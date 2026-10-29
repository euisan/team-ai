import { buildClaudeWarmRequest, sendClaudeWarm } from './claude-warm.js';
import { buildCodexWarmCommand, spawnCodexWarm, type WarmCommand } from './codex-warm.js';
import type { ProbeTemplate, ProviderId } from './types.js';
import { WARM_GIVE_UP_MS, WARM_RETRY_MAX_MS, WARM_RETRY_MS, WINDOW_START_TOLERANCE_MS, clampDelay, nextWarmAt, warmEligibility, windowOpen } from './warm-schedule.js';

const WARM_TIMEOUT_MS = 120_000;
// The confirming read must come later than the unopened-window tolerance: a
// window the warm did open reads reset = request + 5h minus the time since the
// warm, and inside the tolerance that is indistinguishable from an empty one.
const WARM_CONFIRM_DELAY_MS = WINDOW_START_TOLERANCE_MS + 60_000;
const STALE_RECHECK_MS = 60_000;
type Account = { id: string; label?: string; index?: number; enabled?: boolean; error?: string | null; cooldownUntil?: number | null; windows?: Record<string, { usage: number | null; resetsAt: number | null }>; usage?: number | null; measuredAt?: number | null; usageRequestedAt?: number | null; warmFailures?: number; warmRetryAt?: number | null; warmGaveUp?: boolean; warmGaveUpAt?: number | null; warmTransientRetries?: number; warmTransientFailure?: string | null; warmedAt?: number; warmConfirmAt?: number | null; warmSignature?: string };
type Manager = { accounts: Account[]; provider?: { id: ProviderId; label?: string } };
type SpawnSpec = WarmCommand & { timeoutMs: number; signal: AbortSignal };
type SpawnResult = number | { code: number; transient?: boolean; reason?: string };
type WarmFailure = { reason: string; transient: boolean };
type TimerHandle = { unref?: () => void };
type StatusRecord = { status: string; lastWarmedAt?: number; error?: string | null };

export type WarmSpec = { port: number; clientToken: string; timeoutMs: number; signal: AbortSignal };
export type WarmFn = (account: Account, spec: WarmSpec) => Promise<SpawnResult>;

export class Warmer {
  readonly am: Manager;
  readonly providerId: string;
  enabled: boolean;
  readonly port: number;
  readonly clientToken: string;
  readonly timeoutMs: number;
  private readonly warmFn: WarmFn;
  private readonly refreshUsage: ((account: Account) => Promise<unknown>) | null;
  private readonly switchThreshold: number;
  private readonly log: (line: string) => void;
  private readonly trace: (line: string) => void;
  private readonly nowFn: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (timer: TimerHandle) => void;
  readonly startedAt: number;
  private started = false; private generation = 0;
  private timers = new Map<Account, { timer: TimerHandle; at: number }>();
  private queue: Account[] = []; private current: Account | null = null; private draining: number | null = null; private abort: AbortController | null = null;
  private lastCheck = new Map<Account, number>();
  private status = new Map<string, StatusRecord>();
  private traced = new Map<Account, string>();

  constructor(
    am: Manager,
    options: {
      providerId?: string;
      enabled?: boolean;
      port: number;
      clientToken?: string;
      timeoutMs?: number;
      spawnFn?: (spec: SpawnSpec) => Promise<SpawnResult>;
      warmFn?: WarmFn;
      getProbeTemplate?: () => ProbeTemplate | null;
      refreshUsage?: (account: Account) => Promise<unknown>;
      switchThreshold?: number;
      log?: (line: string) => void;
      trace?: (line: string) => void;
      nowFn?: () => number;
      setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
      clearTimeoutFn?: (timer: TimerHandle) => void;
    },
  ) {
    this.am = am;
    this.providerId = options.providerId ?? am.provider?.id ?? 'codex';
    this.enabled = options.enabled !== false;
    this.port = options.port;
    this.clientToken = options.clientToken || '';
    this.timeoutMs = options.timeoutMs ?? WARM_TIMEOUT_MS;
    this.refreshUsage = options.refreshUsage || null;
    this.switchThreshold = options.switchThreshold ?? 0.98;
    this.log = options.log || (() => {});
    this.trace = options.trace || (() => {});
    this.nowFn = options.nowFn || Date.now;
    this.setTimeoutFn = options.setTimeoutFn || ((fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn || ((timer: TimerHandle): void => clearTimeout(timer as NodeJS.Timeout));
    this.startedAt = this.nowFn();

    if (options.warmFn) {
      this.warmFn = options.warmFn;
    } else if (options.spawnFn) {
      const spawn = options.spawnFn;
      this.warmFn = (a, spec) => spawn({ ...buildCodexWarmCommand(spec.port, a.id, { token: spec.clientToken }), timeoutMs: spec.timeoutMs, signal: spec.signal });
    } else if (this.providerId === 'claude') {
      const getProbe = options.getProbeTemplate;
      this.warmFn = (a, spec) => sendClaudeWarm({ ...buildClaudeWarmRequest(spec.port, a.id, { token: spec.clientToken, probeTemplate: getProbe?.() }), timeoutMs: spec.timeoutMs, signal: spec.signal });
    } else {
      this.warmFn = (a, spec) => spawnCodexWarm({ ...buildCodexWarmCommand(spec.port, a.id, { token: spec.clientToken }), timeoutMs: spec.timeoutMs, signal: spec.signal });
    }
  }

  start(): void {
    this.started = true;
    if (!this.enabled) return;
    for (const account of this.am.accounts) this.onAccountChanged(account);
    // Restored quota is intentionally stale for keep-warm purposes. Take one
    // usage reading per account at process start so an idle window can become
    // eligible without a polling timer.
    if (this.refreshUsage) void Promise.all(this.am.accounts.map(async (account) => { try { await this.refreshUsage!(account); } catch { /* next event can retry */ } this.onAccountChanged(account); }));
  }
  stop(): void { this.started = false; this.halt(); }
  configure(options: { enabled?: boolean } = {}): void {
    const next = options.enabled !== false; if (next === this.enabled) return; this.enabled = next;
    if (!next) { this.halt(); this.log('[TeamAI] Keep-warm disabled'); return; }
    this.log('[TeamAI] Keep-warm enabled'); if (this.started) this.start();
  }
  onAccountChanged(account: Account): void {
    if (!this.enabled || !this.started || !this.live(account)) return;
    this.releaseExpiredGiveUp(account, this.nowFn());
    const signature = this.signature(account);
    if (account.warmSignature !== signature) {
      account.warmSignature = signature; account.warmFailures = 0; account.warmRetryAt = null; account.warmGaveUp = false; account.warmGaveUpAt = null; account.warmTransientRetries = 0;
    }
    this.evaluate(account);
  }
  getStatus(): { enabled: boolean; running: string | null; accounts: Array<{ name: string; status: string; lastWarmedAt: string | null; nextAt: string | null; error: string | null }> } {
    return { enabled: this.enabled, running: this.current?.label || this.current?.id || null, accounts: this.am.accounts.map(account => { const record = this.status.get(account.id); const timer = this.timers.get(account); const status = record?.status || (account.warmGaveUp ? 'gave-up' : this.hasWindow(account) ? 'never' : 'not-applicable'); return { name: account.label || account.id, status, lastWarmedAt: iso(record?.lastWarmedAt), nextAt: this.enabled ? iso(timer?.at) : null, error: record?.error || null }; }) };
  }
  private live(a: Account): boolean { return this.am.accounts[a.index ?? this.am.accounts.indexOf(a)] === a; }
  private halt(): void { this.generation++; for (const x of this.timers.values()) this.clearTimeoutFn(x.timer); this.timers.clear(); this.queue = []; this.current = null; this.draining = null; this.abort?.abort(); this.abort = null; }
  private options() { return { switchThreshold: this.switchThreshold, usageSince: this.startedAt }; }
  private hasWindow(a: Account): boolean { return Boolean(a.windows?.primary || a.windows?.['5h']); }
  // An open window that still reads 0% (a warm alone barely registers) is
  // 'run', not 'idle': otherwise the reset that empties it changes nothing, and
  // a backoff or give-up from the previous window carries into the next one.
  private signature(a: Account): string { const q = a.windows?.primary ?? a.windows?.['5h']; if (a.enabled === false) return 'off'; if (!q) return 'none'; if (q.usage === 0 && !windowOpen(a, this.nowFn())) return 'idle'; if (typeof q.usage === 'number') return `run:${q.resetsAt}`; return 'unknown'; }
  private who(a: Account): string { return `${this.providerId} #${this.am.accounts.indexOf(a) + 1}`; }
  // One line per account each time the decision changes, and one per warm
  // outcome. Account number only: no label, address or token.
  private note(a: Account, decision: string): void { if (this.traced.get(a) === decision) return; this.traced.set(a, decision); this.trace(`${this.who(a)}: ${decision}`); }
  private event(a: Account, line: string): void { this.traced.delete(a); this.trace(`${this.who(a)}: ${line}`); }
  private evaluate(account: Account, fromTimer = false): void {
    if (!this.enabled || !this.started || !this.live(account)) return;
    const now = this.nowFn(); this.releaseExpiredGiveUp(account, now); const decision = warmEligibility(account, now, this.options());
    if (decision.eligible) { this.clearTimer(account); this.enqueue(account); return; }
    const next = nextWarmAt(account, now, this.options());
    this.note(account, next != null && next > now ? `${decision.reason}, next check ${iso(next)}` : decision.reason);
    if (next != null && next > now) { this.arm(account, next); return; }
    if (next != null && !fromTimer && now - (this.lastCheck.get(account) ?? -Infinity) >= STALE_RECHECK_MS) { this.arm(account, now); return; }
    if (decision.reason === 'awaiting-usage' && this.timers.has(account)) return;
    this.clearTimer(account);
  }
  private clearTimer(a: Account): void { const e = this.timers.get(a); if (e) this.clearTimeoutFn(e.timer); this.timers.delete(a); }
  private arm(a: Account, at: number): void { const old = this.timers.get(a); if (old?.at === at) return; this.clearTimer(a); const gen = this.generation; const entry: { timer: TimerHandle; at: number } = { at, timer: { } }; entry.timer = this.setTimeoutFn(() => { if (this.timers.get(a) !== entry || gen !== this.generation) return; this.timers.delete(a); if (this.nowFn() < at) { this.arm(a, at); return; } void this.fire(a, gen); }, clampDelay(at - this.nowFn())); entry.timer?.unref?.(); this.timers.set(a, entry); }
  private async fire(a: Account, gen: number): Promise<void> {
    if (!this.live(a)) return;
    const now = this.nowFn(); this.lastCheck.set(a, now);
    // Only the one timer armed after a successful warm confirms it. This used
    // to be every timer after any warm, since warmedAt is never cleared: each
    // later reset was taken for a confirmation and pushed back ten minutes,
    // forever, and an account kept warm only by the warmer was never warmed
    // again after its first window (2026-10-19). The backoff is set before the
    // read so the change event the read raises cannot warm in the meantime.
    const confirming = typeof a.warmConfirmAt === 'number' && now >= a.warmConfirmAt;
    if (confirming) { a.warmConfirmAt = null; a.warmRetryAt = now + WARM_RETRY_MS; }
    if (this.refreshUsage) { try { await this.refreshUsage(a); } catch { /* judged on current figures */ } }
    if (gen !== this.generation) return;
    // Still the unopened shape after the warm: it did not take. That counts as
    // a failure, so a warm that never opens a window is sent twice, not every
    // ten minutes.
    if (confirming && warmEligibility(a, this.nowFn(), this.options()).reason === 'retry-backoff') this.failed(a, { reason: 'window not opened', transient: false });
    this.evaluate(a, true);
  }
  private enqueue(a: Account): void { if (this.current === a || this.queue.includes(a)) return; this.queue.push(a); if (this.draining === this.generation) return; const gen = this.generation; this.draining = gen; queueMicrotask(() => void this.drain(gen)); }
  private async drain(gen: number): Promise<void> { try { while (gen === this.generation && this.queue.length) { const a = this.queue.shift()!; if (!this.live(a)) continue; this.releaseExpiredGiveUp(a, this.nowFn()); if (!warmEligibility(a, this.nowFn(), this.options()).eligible) { this.evaluate(a); continue; } this.current = a; await this.warm(a, gen); if (gen === this.generation) this.current = null; } } finally { if (this.draining === gen) this.draining = null; } }
  private async warm(a: Account, gen: number): Promise<void> {
    const abort = new AbortController(); this.abort = abort; const previous = this.status.get(a.id); a.warmTransientFailure = null; this.record(a, { status: 'running' }); this.event(a, 'warm sent'); let failure: WarmFailure | null = null;
    try {
      const result = await this.warmFn(a, { port: this.port, clientToken: this.clientToken, timeoutMs: this.timeoutMs, signal: abort.signal });
      if (typeof result === 'number') { if (result !== 0) failure = { reason: `exit ${result}`, transient: false }; }
      else if (result.code !== 0) failure = { reason: result.reason || `exit ${result.code}`, transient: result.transient === true };
    } catch (error) { failure = classifyError(error, this.providerId); }
    finally { if (this.abort === abort) this.abort = null; }
    if (a.warmTransientFailure) failure = { reason: a.warmTransientFailure, transient: true };
    if (abort.signal.aborted || gen !== this.generation) { if (previous) this.status.set(a.id, previous); else this.status.delete(a.id); return; }
    const finished = this.nowFn();
    // A clean exit is not yet a success: the failure count is cleared only once
    // a reading shows the window open (a signature change), so the confirming
    // read can still count a warm that did not take.
    if (!failure) { a.warmedAt = finished; a.warmRetryAt = null; a.warmTransientRetries = 0; a.warmConfirmAt = finished + WARM_CONFIRM_DELAY_MS; this.record(a, { status: 'ok', lastWarmedAt: finished, error: null }); this.event(a, 'warm ok'); }
    else this.failed(a, failure);
    this.evaluate(a);
    if (!failure && gen === this.generation) this.arm(a, finished + WARM_CONFIRM_DELAY_MS);
  }
  private failed(a: Account, failure: WarmFailure): void {
    const now = this.nowFn(); a.warmConfirmAt = null;
    if (failure.transient) {
      const attempt = a.warmTransientRetries || 0; a.warmTransientRetries = attempt + 1;
      const delay = Math.min(WARM_RETRY_MAX_MS, WARM_RETRY_MS * (2 ** Math.min(attempt, 16)));
      a.warmRetryAt = now + delay; a.warmGaveUp = false; a.warmGaveUpAt = null;
      this.log(`[TeamAI] warm account transient failure: ${failure.reason}; retry in ${Math.ceil(delay / 1000)}s`);
      this.record(a, { status: 'retrying', error: failure.reason }); this.event(a, `warm retry: ${failure.reason}`); return;
    }
    a.warmFailures = (a.warmFailures || 0) + 1;
    if (a.warmFailures === 1) a.warmRetryAt = now + WARM_RETRY_MS;
    else { a.warmRetryAt = null; a.warmGaveUp = true; a.warmGaveUpAt = now; }
    this.log(`[TeamAI] warm account failed: ${failure.reason}`);
    this.record(a, { status: a.warmGaveUp ? 'gave-up' : 'error', error: failure.reason });
    this.event(a, `warm failed: ${failure.reason}`);
  }
  private releaseExpiredGiveUp(a: Account, now: number): void {
    if (!a.warmGaveUp || typeof a.warmGaveUpAt !== 'number' || now < a.warmGaveUpAt + WARM_GIVE_UP_MS) return;
    a.warmGaveUp = false; a.warmGaveUpAt = null; a.warmFailures = 0; a.warmRetryAt = null; a.warmTransientRetries = 0;
    this.record(a, { status: 'idle', error: null }); this.event(a, 'give-up expired');
  }
  private record(a: Account, fields: { status?: string; lastWarmedAt?: number; error?: string | null }): void { const previous = this.status.get(a.id); this.status.set(a.id, { status: fields.status ?? previous?.status ?? 'never', lastWarmedAt: fields.lastWarmedAt ?? previous?.lastWarmedAt, error: fields.error === undefined ? previous?.error : fields.error }); }
}
function classifyError(error: unknown, providerId = 'codex'): WarmFailure { const value = error && typeof error === 'object' ? error as { code?: string; message?: string; signal?: string } : {}; if (value.code === 'ETIMEDOUT' || /timed out/i.test(value.message || '')) return { reason: 'timeout', transient: true }; if (value.code === 'ENOENT') return { reason: `${providerId} not found`, transient: false }; if (value.signal) return { reason: `killed by ${value.signal}`, transient: true }; if (/fetch failed|ECONNREFUSED|ECONNRESET/i.test(value.message || '')) return { reason: value.message || 'network error', transient: true }; return { reason: `${providerId === 'claude' ? 'request' : 'spawn'} failed`, transient: false }; }
function iso(value: number | undefined): string | null { return typeof value === 'number' ? new Date(value).toISOString() : null; }
