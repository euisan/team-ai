// Weekly pacing: which of two otherwise-equal accounts should take the next
// request. The pool, the dashboard's order and its next-account arrows all
// compare through here, so they cannot disagree.
//
// The weekly budget is a straight line from 0% at the start of the week to
// 100% at its reset. An account below its line is behind — it has budget it
// will lose at the reset unless it is spent — so it goes first. This is an
// order, not a gate: when every account is ahead, the least-ahead one is used.
// An account about to reset with budget left is already the furthest behind,
// so there is no separate "resets soon" rule.

export const WEEK_MS = 7 * 86_400_000;
const WEEK_MINUTES = 10_080;
const SESSION_MINUTES = 300;
// Deviations this close count as equal, so two accounts drifting past each
// other by a request's worth do not swap places on every turn.
export const PACING_BAND = 0.05;

export type Balance = 'pacing' | 'level';

// routing.balance from config.json: absent is 'pacing'; anything but the two
// names is an error that says what was found. The one reading of the key: the
// server refuses to start on the error, the dashboard draws the default order.
export function parseBalance(value: unknown): Balance {
  if (value === undefined) return 'pacing';
  if (value === 'pacing' || value === 'level') return value;
  throw new Error(`routing.balance must be "pacing" or "level", not ${JSON.stringify(value)}`);
}

interface Window { usage: number | null; resetsAt?: number | null; minutes?: number | null }
export interface Paced { id?: string; windows: Record<string, Window> }

// The weekly window a request spends: Claude's Fable bucket (7d_*) for a Fable
// request, otherwise Claude's 7d or the Codex window whose length is a week.
// Codex names its windows primary/secondary, and which one is weekly is told
// only by its length, never by its name.
export function weeklyWindow(windows: Record<string, Window>, wantsFable: boolean): Window | undefined {
  if (wantsFable) { const fable = Object.entries(windows).find(([name]) => /^7d_[a-z0-9]+$/i.test(name))?.[1]; if (fable) return fable; }
  return windows['7d'] ?? Object.values(windows).find((w) => w.minutes === WEEK_MINUTES);
}

// The 5-hour session window: Claude's 5h, or the Codex window that long.
export function sessionWindow(windows: Record<string, Window>): Window | undefined {
  return windows['5h'] ?? Object.values(windows).find((w) => w.minutes === SESSION_MINUTES);
}

interface Pace { usage: number; resetsAt: number; deviation: number; headroomRate: number | null }

// A weekly window counts only with both a usage and a reset in the future.
export function pace(windows: Record<string, Window>, wantsFable: boolean, now: number): Pace | null {
  const window = weeklyWindow(windows, wantsFable);
  if (!window || window.usage === null || window.usage === undefined || !window.resetsAt || window.resetsAt <= now) return null;
  const remaining = (window.resetsAt - now) / WEEK_MS;
  const elapsed = Math.max(0, Math.min(1, 1 - remaining));
  return { usage: window.usage, resetsAt: window.resetsAt, deviation: window.usage - elapsed, headroomRate: remaining > 0 ? (1 - window.usage) / remaining : null };
}

// Negative: behind the line, positive: ahead of it. Null without a valid window.
export function pacingDeviation(windows: Record<string, Window>, wantsFable: boolean, now: number): number | null {
  return pace(windows, wantsFable, now)?.deviation ?? null;
}

const MISSING = Number.MAX_SAFE_INTEGER;

// Behind-the-line first. Within the band: the session's own account, then the
// most budget left per remaining week, then the earliest weekly reset, then
// the earliest and least-used 5-hour window. An account with no valid weekly
// window takes no part in the deviation and sorts as if its week never resets.
export function comparePacing(a: Paced, b: Paced, wantsFable: boolean, now: number, pinned?: string | null): number {
  const pa = pace(a.windows, wantsFable, now); const pb = pace(b.windows, wantsFable, now);
  if (pa && pb && Math.abs(pa.deviation - pb.deviation) > PACING_BAND) return pa.deviation - pb.deviation;
  if (pinned && (a.id === pinned) !== (b.id === pinned)) return a.id === pinned ? -1 : 1;
  const ra = pa?.headroomRate ?? null; const rb = pb?.headroomRate ?? null;
  if (ra !== rb) { if (ra === null || rb === null) return ra === null ? 1 : -1; return rb - ra; }
  const wa = pa?.resetsAt ?? MISSING; const wb = pb?.resetsAt ?? MISSING;
  if (wa !== wb) return wa - wb;
  const sa = sessionWindow(a.windows); const sb = sessionWindow(b.windows);
  // A 5-hour window that has already rolled over is fresh: no reset pending, 0% used.
  const rolled = (w: Window | undefined) => Boolean(w?.resetsAt && w.resetsAt <= now);
  const reset = (w: Window | undefined) => (w?.resetsAt && !rolled(w) ? w.resetsAt : MISSING);
  const used = (w: Window | undefined) => (rolled(w) ? 0 : w?.usage ?? MISSING);
  const xa = reset(sa); const xb = reset(sb);
  if (xa !== xb) return xa - xb;
  return used(sa) - used(sb);
}

// "+12%p" / "-30%p": the deviation as the dashboard shows it. ASCII minus, so
// the capture's bitmap font can draw it.
export function formatDeviation(deviation: number | null): string {
  if (deviation === null) return '';
  const points = Math.round(deviation * 100);
  return `${points > 0 ? '+' : points < 0 ? '-' : ''}${Math.abs(points)}%p`;
}
