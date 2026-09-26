import {
  defaultSave,
  missionResultSchema,
  saveGameSchema,
  type MissionResult,
  type SaveGame,
  type Settings,
} from './schema.js';

/**
 * Persistence with a swappable backend. IndexedDB is the shipping target, but the save logic —
 * migration, corruption recovery, debounced writes — is where the bugs live, and none of it
 * should need a browser to test.
 */
export interface StorageBackend {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryBackend implements StorageBackend {
  private readonly data = new Map<string, unknown>();
  /** Set to make the next write throw, for testing quota and private-mode failures. */
  failNextWrite = false;

  read(key: string): Promise<unknown> {
    return Promise.resolve(this.data.has(key) ? structuredClone(this.data.get(key)) : undefined);
  }

  write(key: string, value: unknown): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return Promise.reject(new Error('backend write failed'));
    }
    this.data.set(key, structuredClone(value));
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }

  get keys(): string[] {
    return [...this.data.keys()];
  }
}

export const SAVE_KEY = 'shoplifter:save';
/** Bootstrap-critical values are mirrored here so the first frame can read them synchronously. */
export const BOOTSTRAP_KEY = 'shoplifter:bootstrap';

export interface BootstrapSettings {
  language: string;
  masterVolume: number;
}

export type MigrationResult = 'loaded' | 'defaulted' | 'recovered';

export interface LoadReport {
  save: SaveGame;
  result: MigrationResult;
  /** Populated when a corrupt save was discarded, so the UI can tell the player. */
  issues: string[];
}

/** Runs a stored save through the schema, falling back to defaults rather than crashing. */
export const migrate = (raw: unknown): LoadReport => {
  if (raw === undefined || raw === null) {
    return { save: defaultSave(), result: 'defaulted', issues: [] };
  }

  const parsed = saveGameSchema.safeParse(raw);
  if (parsed.success) return { save: parsed.data, result: 'loaded', issues: [] };

  // A partially valid save is worth rescuing: losing campaign progress to one bad settings
  // field is exactly the failure that makes players distrust a game's saves.
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  const recovered = defaultSave();
  if (typeof raw === 'object' && raw !== null) {
    const candidate = raw as Partial<SaveGame>;
    if (typeof candidate.safeLandings === 'number' && candidate.safeLandings >= 0) {
      recovered.safeLandings = Math.floor(candidate.safeLandings);
    }
    if (Array.isArray(candidate.unlockedAircraft)) {
      const aircraft = candidate.unlockedAircraft.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      );
      if (aircraft.length > 0) recovered.unlockedAircraft = aircraft;
    }
    if (candidate.completedMissions && typeof candidate.completedMissions === 'object') {
      for (const [id, result] of Object.entries(candidate.completedMissions)) {
        const missionResult = missionResultSchema.safeParse(result);
        if (missionResult.success) recovered.completedMissions[id] = missionResult.data;
      }
    }
  }
  return { save: recovered, result: 'recovered', issues };
};

export interface SaveStoreOptions {
  backend: StorageBackend;
  /** Milliseconds to coalesce rapid settings writes. A slider drag must not hammer storage. */
  debounceMs?: number;
  /** Injected for tests; defaults to the real clock. */
  now?: () => number;
}

export class SaveStore {
  private readonly backend: StorageBackend;
  private readonly debounceMs: number;
  private save: SaveGame = defaultSave();
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private lastWriteFailed = false;

  constructor(options: SaveStoreOptions) {
    this.backend = options.backend;
    this.debounceMs = options.debounceMs ?? 400;
  }

  get current(): SaveGame {
    return this.save;
  }

  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  get writeFailed(): boolean {
    return this.lastWriteFailed;
  }

  async load(): Promise<LoadReport> {
    let raw: unknown;
    try {
      raw = await this.backend.read(SAVE_KEY);
    } catch {
      // A backend that cannot be read at all is the same situation as a first run.
      raw = undefined;
    }
    const report = migrate(raw);
    this.save = report.save;
    this.dirty = report.result !== 'loaded';
    return report;
  }

  /** Values the boot path needs before the save has finished loading. */
  bootstrap(): BootstrapSettings {
    return {
      language: this.save.settings.language,
      masterVolume: this.save.settings.audio.master,
    };
  }

  updateSettings(mutate: (settings: Settings) => void): void {
    mutate(this.save.settings);
    this.markDirty();
  }

  recordMission(result: MissionResult): void {
    const existing = this.save.completedMissions[result.missionId];
    // Keep the best run: a player replaying for an S rank must not lose it to a worse attempt.
    if (!existing || result.score > existing.score) {
      this.save.completedMissions[result.missionId] = result;
    }
    this.markDirty();
  }

  recordSafeLanding(): void {
    this.save.safeLandings++;
    this.markDirty();
  }

  unlockAircraft(id: string): boolean {
    if (this.save.unlockedAircraft.includes(id)) return false;
    this.save.unlockedAircraft.push(id);
    this.markDirty();
    return true;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Writes immediately, coalescing with any debounced write already queued. */
  async flush(): Promise<void> {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (!this.dirty) return;
    if (this.inFlight) await this.inFlight;

    const snapshot = structuredClone(this.save);
    this.inFlight = (async () => {
      try {
        await this.backend.write(SAVE_KEY, snapshot);
        await this.backend.write(BOOTSTRAP_KEY, {
          language: snapshot.settings.language,
          masterVolume: snapshot.settings.audio.master,
        });
        this.dirty = false;
        this.lastWriteFailed = false;
      } catch {
        // Storage can be full or blocked in private mode. Keep the in-memory save authoritative
        // and stay dirty so a later flush retries, rather than losing the session's progress.
        this.lastWriteFailed = true;
      }
    })();

    await this.inFlight;
    this.inFlight = null;
  }

  async reset(): Promise<void> {
    this.save = defaultSave();
    this.dirty = false;
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    await this.backend.delete(SAVE_KEY);
  }
}

/**
 * IndexedDB backend. Wrapped so that every failure mode — no IndexedDB at all, a blocked open,
 * a private-browsing quota error — surfaces as a rejected promise the store already handles.
 */
export class IndexedDbBackend implements StorageBackend {
  private readonly dbName: string;
  private readonly storeName = 'state';
  private db: IDBDatabase | null = null;

  constructor(dbName = 'shoplifter') {
    this.dbName = dbName;
  }

  static isAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      if (!IndexedDbBackend.isAvailable()) {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
    });
  }

  private async transact<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, mode);
      const request = run(transaction.objectStore(this.storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'));
    });
  }

  read(key: string): Promise<unknown> {
    return this.transact('readonly', (store) => store.get(key) as IDBRequest<unknown>);
  }

  async write(key: string, value: unknown): Promise<void> {
    await this.transact('readwrite', (store) => store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    await this.transact('readwrite', (store) => store.delete(key));
  }
}
