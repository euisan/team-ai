// Pure keep-warm decisions. The only clock input is `now`; usage is trusted
// only when the request that produced it was sent after this process started
// and after the last successful warm.
export const WARM_DELAY_AFTER_RESET_MS = 10_000;
export const WARM_RETRY_MS = 10 * 60_000;
export const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_SWITCH_THRESHOLD = 0.98;

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
  return typeof quota.unified5h === 'number' && quota.unified5h > 0 && typeof quota.unified5hReset === 'number' && quota.unified5hReset > now;
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

