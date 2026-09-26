import { describe, expect, it, vi } from 'vitest';
import { defaultSave, defaultSettings, type MissionResult } from './schema.js';
import { BOOTSTRAP_KEY, MemoryBackend, SAVE_KEY, SaveStore, migrate } from './store.js';

const result = (overrides: Partial<MissionResult> = {}): MissionResult => ({
  missionId: 'm01_open_sky',
  rank: 'B',
  score: 74,
  rescued: 18,
  dead: 2,
  elapsedSeconds: 640,
  difficulty: 'standard',
  completedAt: 1_700_000_000_000,
  ...overrides,
});

const store = (backend = new MemoryBackend()): { store: SaveStore; backend: MemoryBackend } => ({
  store: new SaveStore({ backend, debounceMs: 5 }),
  backend,
});

describe('defaults', () => {
  it('ships the baseline Rescue helicopter unlocked', () => {
    expect(defaultSave().unlockedAircraft).toContain('rescue');
  });

  it('defaults to Standard difficulty with the landing aid unpinned', () => {
    const settings = defaultSettings();
    expect(settings.difficulty).toBe('standard');
    expect(settings.accessibility.alwaysShowLandingAid).toBe(false);
    expect(settings.accessibility.gameSpeed).toBe(1);
  });
});

describe('migrate', () => {
  it('treats an empty slot as a first run', () => {
    const report = migrate(undefined);
    expect(report.result).toBe('defaulted');
    expect(report.issues).toEqual([]);
  });

  it('loads a valid save untouched', () => {
    const save = defaultSave();
    save.safeLandings = 7;
    const report = migrate(save);
    expect(report.result).toBe('loaded');
    expect(report.save.safeLandings).toBe(7);
  });

  it('rescues campaign progress from a save with broken settings', () => {
    const corrupt = defaultSave() as unknown as Record<string, unknown>;
    corrupt.settings = { language: 5 };
    corrupt.safeLandings = 12;
    corrupt.unlockedAircraft = ['rescue', 'scout'];
    corrupt.completedMissions = { m01_open_sky: result({ score: 91, rank: 'A' }) };

    const report = migrate(corrupt);
    expect(report.result).toBe('recovered');
    expect(report.issues.length).toBeGreaterThan(0);
    // Progress survives; only the unreadable part falls back to defaults.
    expect(report.save.safeLandings).toBe(12);
    expect(report.save.unlockedAircraft).toEqual(['rescue', 'scout']);
    expect(report.save.completedMissions.m01_open_sky?.score).toBe(91);
    expect(report.save.settings.language).toBe('en');
  });

  it('drops individually corrupt mission results but keeps the good ones', () => {
    const corrupt = defaultSave() as unknown as Record<string, unknown>;
    corrupt.schemaVersion = 99;
    corrupt.completedMissions = {
      good: result(),
      bad: { missionId: 'bad', rank: 'Z' },
    };
    const report = migrate(corrupt);
    expect(report.save.completedMissions.good).toBeDefined();
    expect(report.save.completedMissions.bad).toBeUndefined();
  });

  it('survives complete garbage', () => {
    expect(migrate('not a save').result).toBe('recovered');
    expect(migrate(42).save.unlockedAircraft).toEqual(['rescue']);
  });
});

describe('SaveStore', () => {
  it('starts from defaults when storage is empty', async () => {
    const { store: save } = store();
    const report = await save.load();
    expect(report.result).toBe('defaulted');
    expect(save.current.safeLandings).toBe(0);
  });

  it('round-trips through the backend', async () => {
    const backend = new MemoryBackend();
    const first = new SaveStore({ backend, debounceMs: 1 });
    await first.load();
    first.recordSafeLanding();
    first.updateSettings((settings) => {
      settings.difficulty = 'veteran';
    });
    await first.flush();

    const second = new SaveStore({ backend, debounceMs: 1 });
    await second.load();
    expect(second.current.safeLandings).toBe(1);
    expect(second.current.settings.difficulty).toBe('veteran');
  });

  it('mirrors bootstrap-critical settings for the first frame', async () => {
    const { store: save, backend } = store();
    await save.load();
    save.updateSettings((settings) => {
      settings.language = 'ja';
      settings.audio.master = 0.25;
    });
    await save.flush();

    expect(backend.keys).toContain(BOOTSTRAP_KEY);
    expect(await backend.read(BOOTSTRAP_KEY)).toEqual({ language: 'ja', masterVolume: 0.25 });
    expect(save.bootstrap().language).toBe('ja');
  });

  it('coalesces a slider drag into one write', async () => {
    vi.useFakeTimers();
    try {
      const backend = new MemoryBackend();
      const writeSpy = vi.spyOn(backend, 'write');
      const save = new SaveStore({ backend, debounceMs: 50 });
      await save.load();

      for (let i = 0; i < 30; i++) {
        save.updateSettings((settings) => {
          settings.audio.music = i / 30;
        });
      }
      expect(writeSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60);
      // Two calls: the save itself plus the bootstrap mirror. Not sixty.
      expect(writeSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the best run rather than the latest', async () => {
    const { store: save } = store();
    await save.load();
    save.recordMission(result({ score: 88, rank: 'A' }));
    save.recordMission(result({ score: 61, rank: 'C' }));
    expect(save.current.completedMissions.m01_open_sky?.score).toBe(88);

    save.recordMission(result({ score: 95, rank: 'S' }));
    expect(save.current.completedMissions.m01_open_sky?.rank).toBe('S');
  });

  it('unlocks an aircraft once', async () => {
    const { store: save } = store();
    await save.load();
    expect(save.unlockAircraft('heavy_lift')).toBe(true);
    expect(save.unlockAircraft('heavy_lift')).toBe(false);
    expect(save.current.unlockedAircraft.filter((a) => a === 'heavy_lift')).toHaveLength(1);
  });

  it('stays dirty and keeps the session when a write fails', async () => {
    const { store: save, backend } = store();
    await save.load();
    save.recordSafeLanding();
    backend.failNextWrite = true;
    await save.flush();

    expect(save.writeFailed).toBe(true);
    expect(save.hasUnsavedChanges).toBe(true);
    // The in-memory save stays authoritative — a full disk must not erase the run.
    expect(save.current.safeLandings).toBe(1);

    await save.flush();
    expect(save.writeFailed).toBe(false);
    expect(save.hasUnsavedChanges).toBe(false);
  });

  it('treats an unreadable backend as a first run instead of crashing', async () => {
    const backend = new MemoryBackend();
    vi.spyOn(backend, 'read').mockRejectedValue(new Error('blocked'));
    const save = new SaveStore({ backend, debounceMs: 1 });
    const report = await save.load();
    expect(report.result).toBe('defaulted');
  });

  it('persists defaults on a first run, then stays quiet until something changes', async () => {
    const backend = new MemoryBackend();
    const first = new SaveStore({ backend, debounceMs: 1 });
    await first.load();
    // A first run is dirty by definition: the defaults have never been written.
    await first.flush();
    expect(await backend.read(SAVE_KEY)).toBeDefined();

    const second = new SaveStore({ backend, debounceMs: 1 });
    await second.load();
    const writeSpy = vi.spyOn(backend, 'write');
    await second.flush();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('resets to defaults and clears the slot', async () => {
    const { store: save, backend } = store();
    await save.load();
    save.recordSafeLanding();
    await save.flush();
    await save.reset();

    expect(save.current.safeLandings).toBe(0);
    expect(await backend.read(SAVE_KEY)).toBeUndefined();
  });
});
