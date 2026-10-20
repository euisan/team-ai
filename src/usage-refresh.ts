import type { AccountPool } from './account-pool.js';
import type { RuntimeAccount } from './types.js';

export const DEFAULT_USAGE_REFRESH_MS = 5 * 60_000;
export const DEFAULT_USAGE_JITTER_MS = 30_000;
export const DEFAULT_USAGE_CONCURRENCY = 2;
export const DEFAULT_USAGE_BACKOFF_BASE_MS = 30_000;
export const DEFAULT_USAGE_BACKOFF_MAX_MS = 15 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export type TimerHandle = { unref?: () => void };

export interface UsageRefreshOptions {
  intervalMs?: number;
  jitterMaxMs?: number;
  concurrency?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  onUpdated?: (account: RuntimeAccount, pool: AccountPool) => void;
  nowFn?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (timer: TimerHandle) => void;
  jitterFn?: (credentialId: string, cycle: number, maxMs: number) => number;
}

interface AccountSchedule {
  credentialId: string;
  pool: AccountPool;
  account: RuntimeAccount;
  timer: TimerHandle | null;
  dueAt: number | null;
  queued: boolean;
  inFlight: boolean;
  failures: number;
  cycle: number;
}

/** Deterministic per-account, per-cycle jitter in [0, maxMs] so accounts never poll in lockstep. */
export function defaultUsageJitter(credentialId: string, cycle: number, maxMs: number): number {
  if (!Number.isFinite(maxMs) || maxMs <= 0) return 0;
  const input = `${credentialId}:${cycle}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % (Math.floor(maxMs) + 1);
}

function clampDelay(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_TIMER_MS);
}

/**
 * Periodically refreshes quota snapshots for all enabled accounts across
 * provider pools using each provider's zero-quota usage endpoint.
 *
 * Each enabled account is scheduled on its own timer with per-account jitter,
 * bounded by a fleet-wide concurrency limit, and backed off exponentially when
 * a read or token renewal fails. Disabled and retired accounts are skipped.
 */
export class UsageRefresher {
  readonly pools: AccountPool[];
  readonly intervalMs: number;
  readonly jitterMaxMs: number;
  readonly concurrency: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  private readonly onUpdated: (account: RuntimeAccount, pool: AccountPool) => void;
  private readonly nowFn: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (timer: TimerHandle) => void;
  private readonly jitterFn: (credentialId: string, cycle: number, maxMs: number) => number;
  private started = false;
  private generation = 0;
  private schedules = new Map<string, AccountSchedule>();
  private queue: AccountSchedule[] = [];
  private active = 0;

  constructor(pools: AccountPool[], options: UsageRefreshOptions = {}) {
    this.pools = pools;
    this.intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_USAGE_REFRESH_MS);
    this.jitterMaxMs = Math.max(0, options.jitterMaxMs ?? DEFAULT_USAGE_JITTER_MS);
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_USAGE_CONCURRENCY));
    this.backoffBaseMs = Math.max(1_000, options.backoffBaseMs ?? DEFAULT_USAGE_BACKOFF_BASE_MS);
    this.backoffMaxMs = Math.max(this.backoffBaseMs, options.backoffMaxMs ?? DEFAULT_USAGE_BACKOFF_MAX_MS);
    this.onUpdated = options.onUpdated ?? (() => {});
    this.nowFn = options.nowFn ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer: TimerHandle): void => clearTimeout(timer as NodeJS.Timeout));
    this.jitterFn = options.jitterFn ?? defaultUsageJitter;
    if (options.nowFn) {
      for (const pool of this.pools) pool.now = this.nowFn;
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reconcile();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.generation++;
    for (const entry of this.schedules.values()) this.clearTimer(entry);
    this.schedules.clear();
    this.queue = [];
    this.active = 0;
  }

  /** Sync scheduled targets with current pool accounts after startup or config reload. */
  reconcile(): void {
    if (!this.started) return;
    const now = this.nowFn();
    const eligible = new Map<string, { pool: AccountPool; account: RuntimeAccount }>();
    for (const pool of this.pools) {
      pool.sweepExpired();
      if (!pool.provider.fetchUsage) continue;
      for (const account of pool.accounts) {
        if (this.isEligible(pool, account)) {
          eligible.set(account.credentialId, { pool, account });
        }
      }
    }

    for (const [credentialId, entry] of this.schedules) {
      if (!eligible.has(credentialId)) {
        this.clearTimer(entry);
        if (entry.queued) {
          entry.queued = false;
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) this.queue.splice(idx, 1);
        }
        this.schedules.delete(credentialId);
      }
    }

    for (const [credentialId, { pool, account }] of eligible) {
      const existing = this.schedules.get(credentialId);
      if (existing) {
        existing.pool = pool;
        existing.account = account;
        if (!existing.timer && !existing.queued && !existing.inFlight) {
          this.scheduleInitial(existing, now);
        }
        continue;
      }
      const entry: AccountSchedule = {
        credentialId,
        pool,
        account,
        timer: null,
        dueAt: null,
        queued: false,
        inFlight: false,
        failures: 0,
        cycle: 0,
      };
      this.schedules.set(credentialId, entry);
      this.scheduleInitial(entry, now);
    }
  }

  private isEligible(pool: AccountPool, account: RuntimeAccount): boolean {
    return Boolean(pool.provider.fetchUsage) && pool.accounts.includes(account) && account.enabled && !account.retired;
  }

  private countsDue(pool: AccountPool, account: RuntimeAccount, cutoff: number): boolean {
    return pool.resetCredits.enabled && Boolean(pool.provider.consumeResetCredit) && (account.resetCreditsAt ?? 0) <= cutoff;
  }

  private jitter(entry: AccountSchedule): number {
    const raw = this.jitterFn(entry.credentialId, entry.cycle++, this.jitterMaxMs);
    return Number.isFinite(raw) && raw > 0 ? Math.min(this.jitterMaxMs, Math.floor(raw)) : 0;
  }

  private scheduleInitial(entry: AccountSchedule, now: number): void {
    if (typeof entry.account.warmConfirmAt === 'number' && entry.account.warmConfirmAt > now) {
      this.arm(entry, (entry.account.warmConfirmAt - now) + this.jitter(entry));
      return;
    }
    const cutoff = now - this.intervalMs;
    const measuredAt = entry.account.measuredAt;
    if (measuredAt === null || measuredAt === undefined || measuredAt <= cutoff || this.countsDue(entry.pool, entry.account, cutoff)) {
      this.enqueue(entry);
      return;
    }
    const age = Math.max(0, now - measuredAt);
    this.arm(entry, (this.intervalMs - age) + this.jitter(entry));
  }

  private clearTimer(entry: AccountSchedule): void {
    if (entry.timer !== null) {
      this.clearTimeoutFn(entry.timer);
      entry.timer = null;
    }
    entry.dueAt = null;
  }

  private arm(entry: AccountSchedule, delayMs: number): void {
    this.clearTimer(entry);
    const delay = clampDelay(delayMs);
    const gen = this.generation;
    const dueAt = this.nowFn() + delay;
    entry.dueAt = dueAt;
    const timer = this.setTimeoutFn(() => {
      if (!this.started || gen !== this.generation || this.schedules.get(entry.credentialId) !== entry) return;
      entry.timer = null;
      entry.dueAt = null;
      if (!this.isEligible(entry.pool, entry.account)) {
        this.schedules.delete(entry.credentialId);
        return;
      }
      const now = this.nowFn();
      if (now < dueAt) {
        this.arm(entry, dueAt - now);
        return;
      }
      if (typeof entry.account.warmConfirmAt === 'number' && entry.account.warmConfirmAt > now) {
        this.arm(entry, (entry.account.warmConfirmAt - now) + this.jitter(entry));
        return;
      }
      const cutoff = now - this.intervalMs;
      if (entry.failures === 0 && (entry.account.measuredAt ?? -Infinity) > cutoff && !this.countsDue(entry.pool, entry.account, cutoff)) {
        const age = Math.max(0, now - (entry.account.measuredAt ?? 0));
        this.arm(entry, (this.intervalMs - age) + this.jitter(entry));
        return;
      }
      this.enqueue(entry);
    }, delay);
    timer.unref?.();
    entry.timer = timer;
  }

  private enqueue(entry: AccountSchedule): void {
    if (!this.started || entry.queued || entry.inFlight || !this.isEligible(entry.pool, entry.account)) return;
    this.clearTimer(entry);
    entry.queued = true;
    this.queue.push(entry);
    this.pump(this.generation);
  }

  private pump(gen: number): void {
    if (!this.started || gen !== this.generation) return;
    while (this.active < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      entry.queued = false;
      if (this.schedules.get(entry.credentialId) !== entry || !this.isEligible(entry.pool, entry.account)) {
        this.schedules.delete(entry.credentialId);
        continue;
      }
      entry.inFlight = true;
      this.active++;
      void this.runProbe(entry, gen);
    }
  }

  private async runProbe(entry: AccountSchedule, gen: number): Promise<void> {
    let ok = false;
    try {
      entry.pool.sweepExpired();
      ok = await entry.pool.refreshUsageAccount(entry.account);
    } catch {
      ok = false;
    } finally {
      entry.inFlight = false;
      if (gen === this.generation) {
        this.active = Math.max(0, this.active - 1);
      }
    }
    if (!this.started || gen !== this.generation) return;
    if (this.schedules.get(entry.credentialId) !== entry || !this.isEligible(entry.pool, entry.account)) {
      this.schedules.delete(entry.credentialId);
      this.pump(gen);
      return;
    }
    if (ok) {
      entry.failures = 0;
      this.onUpdated(entry.account, entry.pool);
      this.arm(entry, this.intervalMs + this.jitter(entry));
    } else {
      entry.failures++;
      const backoff = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (entry.failures - 1));
      this.arm(entry, backoff);
    }
    this.pump(gen);
  }
}
