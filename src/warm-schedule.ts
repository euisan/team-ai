// Pure keep-warm decisions. The only clock input is `now`; usage is trusted
// only when the request that produced it was sent after this process started
// and after the last successful warm.
export const WARM_DELAY_AFTER_RESET_MS = 10_000;
export const WARM_RETRY_MS = 10 * 60_000;
export const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_SWITCH_THRESHOLD = 0.98;
const CODEX_SESSION_WINDOW_MS = 300 * 60_000;
// Usage responses arrive after the request was sent and the provider clocks
// are not perfectly aligned. Match the same five-minute slack used by the
// account-pool unopened-window detector when deciding whether a zero reading
// is a genuinely new window or a running one rounded down to 0.00%.
const WINDOW_START_TOLERANCE_MS = 5 * 60_000;

type WarmAccount = {
  enabled?: boolean;
  error?: string | null;
  cooldownUntil?: number | null;
  usage?: number | null;
  resetsAt?: number | null;
  measuredAt?: number | null;
  usageRequestedAt?: number | null;
  windows?: Record<string, { usage: number | null; resetsAt: number | null }>;
  quota?: Record<string, unknown>;
  warmRetryAt?: number | null;
  warmGaveUp?: boolean;
  warmedAt?: number;
};

function quotaOf(account: WarmAccount): Record<string, unknown> {
  if (account.quota) return account.quota;
  const primary = account.windows?.primary;
  const secondary = account.windows?.secondary;
  return {
    codex5hAdvertised: Boolean(primary),
    unified5h: primary?.usage ?? null,
    unified5hReset: primary?.resetsAt ?? null,
    unified7d: secondary?.usage ?? null,
    unified7dReset: secondary?.resetsAt ?? null,
    codexUsageAt: account.measuredAt,
    codexUsageRequestedAt: account.usageRequestedAt,
  };
}

function windowRunning(quota: Record<string, unknown>, now: number): boolean {
  if (typeof quota.unified5hReset !== 'number' || quota.unified5hReset <= now) return false;
  if (typeof quota.unified5h !== 'number') return false;
  if (quota.unified5h > 0) return true;
  if (quota.unified5h !== 0) return false;
  // A provider can round a small amount of usage to 0.00% while retaining the
  // reset time of the already-open window. The request timestamp lets us
  // recognize the exact unopened shape (reset = request + five hours); when
  // it is absent, a reset materially short of five hours is enough evidence
  // that the window is already running.
  const usageAt = typeof quota.codexUsageRequestedAt === 'number' ? quota.codexUsageRequestedAt : typeof quota.codexUsageAt === 'number' ? quota.codexUsageAt : null;
  if (usageAt !== null) return Math.abs(quota.unified5hReset - usageAt - CODEX_SESSION_WINDOW_MS) > WINDOW_START_TOLERANCE_MS;
  return quota.unified5hReset - now < CODEX_SESSION_WINDOW_MS - WINDOW_START_TOLERANCE_MS;
}
function weeklyExhausted(quota: Record<string, unknown>, now: number, threshold: number): boolean {
  return typeof quota.unified7d === 'number' && quota.unified7d >= threshold && !(typeof quota.unified7dReset === 'number' && quota.unified7dReset <= now);
}
function throttled(account: WarmAccount, now: number): boolean { return typeof account.cooldownUntil === 'number' && account.cooldownUntil > now; }

export function warmEligibility(account: WarmAccount | null | undefined, now: number, { switchThreshold = DEFAULT_SWITCH_THRESHOLD, usageSince = 0 } = {}): { eligible: boolean; reason: string } {
  const quota = account ? quotaOf(account) : {};
  const no = (reason: string) => ({ eligible: false, reason });
  if (!account || account.enabled === false) return no('disabled');
  if (account.error || throttled(account, now)) return no('unavailable');
  if (quota.codex5hAdvertised !== true) return no('no-5h-window');
  if (weeklyExhausted(quota, now, switchThreshold)) return no('weekly-exhausted');
  if (windowRunning(quota, now)) return no('window-running');
  const usageAt = typeof quota.codexUsageRequestedAt === 'number' ? quota.codexUsageRequestedAt : typeof quota.codexUsageAt === 'number' ? quota.codexUsageAt : null;
  if (usageAt == null || usageAt < usageSince || (typeof account.warmedAt === 'number' && usageAt <= account.warmedAt)) return no('awaiting-usage');
  if (quota.unified5h !== 0) return no('awaiting-usage');
  if (typeof account.warmRetryAt === 'number' && now < account.warmRetryAt) return no('retry-backoff');
  if (account.warmGaveUp) return no('gave-up');
  return { eligible: true, reason: 'ok' };
}

export function nextWarmAt(account: WarmAccount | null | undefined, now: number, options: Parameters<typeof warmEligibility>[2] = {}): number | null {
  const { eligible, reason } = warmEligibility(account, now, options);
  if (eligible) return now;
  const quota = account ? quotaOf(account) : {};
  switch (reason) {
    case 'unavailable': return throttled(account!, now) ? account!.cooldownUntil! : null;
    case 'weekly-exhausted': return typeof quota.unified7dReset === 'number' ? quota.unified7dReset + WARM_DELAY_AFTER_RESET_MS : null;
    case 'window-running': return (quota.unified5hReset as number) + WARM_DELAY_AFTER_RESET_MS;
    case 'awaiting-usage': return typeof quota.unified5h === 'number' && quota.unified5h > 0 && typeof quota.unified5hReset === 'number' ? quota.unified5hReset + WARM_DELAY_AFTER_RESET_MS : null;
    case 'retry-backoff': return account?.warmRetryAt ?? null;
    default: return null;
  }
}

export function clampDelay(ms: number): number { if (!Number.isFinite(ms) || ms <= 0) return 0; return Math.min(ms, MAX_TIMER_MS); }

