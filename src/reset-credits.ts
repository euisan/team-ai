// Codex reset credits: tickets that reset an account's usage windows, the same
// thing Codex CLI's /usage "Full reset" spends. A ticket cannot be given back,
// so everything here leans one way — when it is unclear whether a ticket was
// spent, it is treated as spent, and nothing is spent on a guess.
import type { ResetCredit, RuntimeAccount, TeamAIConfig } from './types.js';

export interface ResetCreditSettings {
  enabled: boolean;
  // fleet: only when no account can serve at all. account: also right after
  // an account's own exhaustion 429, retrying the request there once.
  policy: 'fleet' | 'account';
  // Minimum gap between two attempts on one account, whatever their outcome.
  cooldownMs: number;
  // Tickets per account that automatic use leaves alone.
  reserve: number;
  // Limit on one consume call; running past it leaves the outcome unknown.
  timeoutMs: number;
  // How long a fetched ticket list is reused; 0 = fetched once.
  listRefreshMs: number;
  // Whether an exhausted 5-hour window alone justifies a ticket. Off: only the
  // weekly window does, the one a ticket buys the most time on.
  sessionWindow: boolean;
}

export const RESET_CREDIT_DEFAULTS: ResetCreditSettings = { enabled: false, policy: 'fleet', cooldownMs: 30 * 60_000, reserve: 0, timeoutMs: 10_000, listRefreshMs: 10 * 60_000, sessionWindow: false };

// A restored 'pending' blocks automatic use until a usage read has counted the
// tickets again, or this long has passed.
export const PENDING_TTL_MS = 15 * 60_000;
// After a reset, readings that would raise usage are held back this long: a
// usage read or a response from before the reset can still arrive late.
export const RESET_GRACE_MS = 2 * 60_000;
// The usage re-read after every attempt.
export const RECHECK_DELAY_MS = 1_500;

export function resetCreditSettings(config: Partial<TeamAIConfig>): ResetCreditSettings {
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  const cooldown = config.codexResetCreditsCooldownMs; const reserve = config.codexResetCreditsReserve;
  const timeout = config.codexResetCreditsTimeoutMs; const list = config.codexResetCreditsListRefreshMs;
  return {
    enabled: config.codexResetCredits === true,
    policy: config.codexResetCreditsPolicy === 'account' ? 'account' : 'fleet',
    cooldownMs: finite(cooldown) ? Math.max(0, Math.floor(cooldown)) : RESET_CREDIT_DEFAULTS.cooldownMs,
    reserve: Number.isInteger(reserve) && (reserve as number) > 0 ? reserve as number : 0,
    timeoutMs: finite(timeout) && timeout > 0 ? timeout : RESET_CREDIT_DEFAULTS.timeoutMs,
    listRefreshMs: finite(list) && list >= 0 ? list : RESET_CREDIT_DEFAULTS.listRefreshMs,
    sessionWindow: config.codexResetCreditsSessionWindow === true,
  };
}

// What one consume call amounts to.
//   reset          a ticket was spent and windows were reset
//   spent-no-reset a ticket was spent but the backend reset nothing
//   indeterminate  the call may or may not have reached the backend
//   no-spend       certainly nothing was spent
export type ConsumeKind = 'reset' | 'spent-no-reset' | 'indeterminate' | 'no-spend';
export interface ConsumeOutcome { kind: ConsumeKind; code: string; windowsReset: number | null; error: string | null }

const NO_SPEND_CODES = new Set(['nothing_to_reset', 'no_credit', 'already_redeemed']);

// The backend refuses with a 200 as well, so only the body's code decides.
export function classifyConsume(status: number, body: string): ConsumeOutcome {
  let parsed: Record<string, unknown> | null = null;
  try { const value = JSON.parse(body) as unknown; if (value && typeof value === 'object') parsed = value as Record<string, unknown>; } catch { /* judged below */ }
  const error = errorText(parsed, body);
  if (status >= 500) return { kind: 'indeterminate', code: `http_${status}`, windowsReset: null, error };
  if (status >= 400) return { kind: 'no-spend', code: `http_${status}`, windowsReset: null, error };
  if (!parsed) return { kind: 'indeterminate', code: 'unparseable', windowsReset: null, error };
  const code = typeof parsed.code === 'string' ? parsed.code : 'unknown';
  const raw = parsed.windows_reset;
  const windowsReset = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
  if (code === 'reset') return { kind: windowsReset === 0 ? 'spent-no-reset' : 'reset', code, windowsReset, error: null };
  if (NO_SPEND_CODES.has(code)) return { kind: 'no-spend', code, windowsReset, error };
  return { kind: 'indeterminate', code, windowsReset, error };
}

// Only the short human part of an error body, never the whole response.
function errorText(parsed: Record<string, unknown> | null, body: string): string | null {
  const nested = parsed?.error;
  const candidates = [nested && typeof nested === 'object' ? (nested as Record<string, unknown>).message : nested, parsed?.detail, parsed?.message];
  const found = candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
  const text = (found ?? body).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : null;
}

// ISO string or epoch (seconds or ms) → epoch ms.
function instant(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && value) { const at = Date.parse(value); return Number.isFinite(at) ? at : null; }
  return null;
}

// The spendable tickets, soonest to expire first; one without an expiry last.
export function parseResetCreditList(data: unknown): ResetCredit[] {
  const credits = (data as { credits?: unknown } | null)?.credits;
  if (!Array.isArray(credits)) return [];
  return credits
    .map((raw, index) => ({ raw: raw as Record<string, unknown> | null, index }))
    .filter(({ raw }) => raw && raw.status === 'available' && typeof raw.id === 'string' && raw.id.length > 0)
    .map(({ raw, index }) => ({ index, credit: { id: String(raw!.id), title: typeof raw!.title === 'string' && raw!.title ? raw!.title : null, grantedAt: instant(raw!.granted_at), expiresAt: instant(raw!.expires_at) } }))
    .sort((a, b) => (a.credit.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.credit.expiresAt ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(({ credit }) => credit);
}

// available_count from /wham/usage: a non-negative integer, or unknown.
export function resetCreditCount(data: unknown): number | null {
  const count = (data as { rate_limit_reset_credits?: { available_count?: unknown } } | null)?.rate_limit_reset_credits?.available_count;
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
}

// Codex reports a window's span; the weekly one is what a ticket is for. When
// no span was reported, the secondary window is the weekly one by convention.
export function weeklyWindow(account: Pick<RuntimeAccount, 'windows'>): { usage: number | null; resetsAt: number | null } | undefined {
  const spans = [account.windows.primary, account.windows.secondary].filter((w) => w && (w.minutes ?? 0) >= 7 * 1440);
  return spans[0] ?? account.windows.secondary;
}

// Out of budget in a way a ticket would fix: the weekly window measured full,
// or with the session-window option any window full or a live quota bench.
export function exhausted(account: RuntimeAccount, sessionWindow: boolean, now = Date.now()): boolean {
  if ((weeklyWindow(account)?.usage ?? 0) >= 1) return true;
  if (!sessionWindow) return false;
  if (account.cooldownReason === 'quota' && account.cooldownUntil !== null && account.cooldownUntil > now) return true;
  return Object.values(account.windows).some((w) => (w.usage ?? 0) >= 1) || (account.usage ?? 0) >= 1;
}

// Whether automatic use may spend a ticket on this account, and if not, why.
export function eligibility(account: RuntimeAccount, settings: ResetCreditSettings, provider: string, now = Date.now()): string {
  if (provider !== 'codex') return 'not-codex-oauth';
  if (!account.enabled) return 'disabled';
  if (account.error) return /revok|invalid_grant/i.test(account.error) ? 'auth-revoked' : 'error';
  if (!account.credential?.accessToken) return 'no-credential';
  const joining = Boolean(account.resetCreditPromise);
  if (!joining) {
    const credits = account.resetCredits;
    if (credits === null || credits === undefined) return 'credits-unknown';
    if (credits <= settings.reserve) return settings.reserve > 0 && credits > 0 ? 'reserved' : 'no-credits';
    if (account.resetCreditLastOutcome === 'pending' && pendingHolds(account, now)) return 'pending';
    if (account.resetCreditLastAt && now - account.resetCreditLastAt < settings.cooldownMs) return 'cooldown';
  }
  if (!exhausted(account, settings.sessionWindow, now)) return 'not-exhausted';
  return joining ? 'in-flight' : 'ok';
}

function pendingHolds(account: RuntimeAccount, now: number): boolean {
  const last = account.resetCreditLastAt ?? 0;
  if ((account.resetCreditsAt ?? 0) > last) return false;
  return now - last < PENDING_TTL_MS;
}

// Most tickets first, then the weekly window that resets latest (a ticket buys
// the most time there), then pool order.
export function candidateOrder(accounts: RuntimeAccount[]): RuntimeAccount[] {
  return accounts.map((account, index) => ({ account, index })).sort((a, b) =>
    (b.account.resetCredits ?? 0) - (a.account.resetCredits ?? 0)
    || (weeklyWindow(b.account)?.resetsAt ?? 0) - (weeklyWindow(a.account)?.resetsAt ?? 0)
    || a.index - b.index).map(({ account }) => account);
}

export interface RedeemResult extends ConsumeOutcome {
  // skipped: nothing was sent (not eligible, or the token could not be renewed).
  skipped: boolean;
  reason: string;
}
