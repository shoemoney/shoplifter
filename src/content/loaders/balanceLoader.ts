import coreBalance from '../balance/core.json' with { type: 'json' };
import { parseBalance, type Balance, type BalanceIssue } from '../schemas/balance.js';

export class BalanceValidationError extends Error {
  constructor(readonly issues: BalanceIssue[]) {
    super(`Invalid balance data:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'BalanceValidationError';
  }
}

/** Validates the bundled balance at startup so a bad edit fails loudly, not subtly. */
export const loadCoreBalance = (): Balance => {
  const result = parseBalance(coreBalance);
  if (!result.ok) throw new BalanceValidationError(result.issues);
  return result.value;
};

export type BalanceListener = (balance: Balance) => void;

/**
 * Vite's HMR gives us balance hot reload for free: edit core.json, see the change without
 * losing the flight state you were testing. Invalid edits log and keep the last good values.
 */
export class BalanceStore {
  private current: Balance;
  private readonly listeners = new Set<BalanceListener>();

  constructor(initial: Balance = loadCoreBalance()) {
    this.current = initial;
  }

  get value(): Balance {
    return this.current;
  }

  subscribe(listener: BalanceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Returns issues instead of throwing so hot reload can reject a bad edit and carry on. */
  replace(raw: unknown): BalanceIssue[] {
    const result = parseBalance(raw);
    if (!result.ok) return result.issues;
    this.current = result.value;
    for (const listener of this.listeners) listener(this.current);
    return [];
  }
}
