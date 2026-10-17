// The dashboard as pure text: given a config and a state, produce the lines the
// screen would show. The interactive loop in tui.ts and the file capture in
// capture.ts both draw through here, so a capture is exactly what a person at
// the terminal would have seen — same ordering, same gauges, same colors.
import { cellWidth, fit, gaugeWidth, layoutRows, placeInSlots, SLOTS, type GridRow } from './columns.js';
import { EXTERNAL_PROVIDERS, type ExternalProvider, type ExternalUsage } from './external-usage.js';
import { comparePacing, formatDeviation, pacingDeviation, type Balance } from './pacing.js';
import { routeEditorFooter, routeEditorLines, type RouteEditor } from './route-editor.js';
import { routeColor } from './routes.js';
import type { ActiveRequest, ActivityEvent, PersistedState, StoredAccount, SubscriptionProfile, TeamAIConfig } from './types.js';

export const ESC = '\x1b['; const RESET = `${ESC}0m`;
const color = (code: number, text: string): string => `${ESC}${code}m${text}${RESET}`;
const visible = cellWidth;

function duration(reset: number | null | undefined): string {
  if (!reset || reset <= Date.now()) return '';
  const mins = Math.ceil((reset - Date.now()) / 60_000); if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60); if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

function bar(usage: number | null | undefined, reset: number | null | undefined, width: number): string {
  const remaining = duration(reset); const ratio = usage == null ? null : Math.max(0, Math.min(1, usage));
  const label = ratio == null ? (remaining || '-') : `${Math.round(ratio * 100)}%${remaining && `${Math.round(ratio * 100)}% ${remaining}`.length <= width ? ` ${remaining}` : ''}`;
  const text = label.slice(0, width).padStart(Math.floor((width + label.length) / 2)).padEnd(width);
  if (ratio == null) return `${ESC}100;37m${text}${RESET}`;
  const filled = Math.round(ratio * width); const bg = ratio >= 0.9 ? 41 : ratio >= 0.7 ? 43 : 42;
  return `${ESC}${bg};97m${text.slice(0, filled)}${ESC}100;37m${text.slice(filled)}${RESET}`;
}

// How old a row's figures are. Headers refresh only the accounts the proxy
// routes to and the usage sweep runs on a timer, so without this a number
// nobody has re-read looks exactly like a live one. Dim while fresh, yellow
// once it is older than a few sweeps would allow.
function age(at: number | null | undefined): string {
  if (!at) return color(90, 'unmeasured');
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  const text = mins < 1 ? 'now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
  return color(mins > 15 ? 33 : 90, text);
}

function healthy(profile: SubscriptionProfile | null | undefined): boolean { return !profile?.status || ['active', 'trialing'].includes(profile.status); }
// ChatGPT plan ids are lowercase slugs ('pro', 'prolite', 'plus', 'team'); show
// them the way the product names them so a Codex row reads like a Claude one.
function codexPlan(profile: SubscriptionProfile | null | undefined): string {
  const raw = profile?.rateLimitTier;
  // Before the first profile refresh there is nothing to show yet; say so
  // rather than printing a brand name that looks like a plan.
  if (!raw) return '—';
  const names: Record<string, string> = { pro: 'Pro', prolite: 'Pro Lite', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free' };
  // ChatGPT exposes no Max-style multiplier anywhere: not in the token claims,
  // not in a header that arrives on every response, and not derivable from the
  // quota windows either — Pro and Pro Lite both report a 10080-minute window
  // and a percentage, never the absolute allowance the percentage is of. The
  // plan name is the whole of what can be known.
  return names[raw.toLowerCase()] || raw;
}
function tier(profile: SubscriptionProfile | null | undefined): string {
  if (!profile) return 'OAuth'; const match = /(\d+x)$/i.exec(profile.rateLimitTier || '');
  if (match) return `Max ${match[1]}`; if (profile.hasClaudeMax || profile.orgType === 'claude_max') return 'Max'; if (profile.hasClaudePro || profile.orgType === 'claude_pro') return 'Pro'; return 'OAuth';
}
function renewal(profile: SubscriptionProfile | null | undefined): string {
  if (!profile?.createdAt || !healthy(profile)) return '—'; const created = new Date(profile.createdAt); if (!Number.isFinite(created.getTime())) return '—';
  const now = new Date(); const day = created.getDate(); const build = (year: number, month: number): Date => new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate())); let target = build(now.getFullYear(), now.getMonth()); if (target < new Date(now.getFullYear(), now.getMonth(), now.getDate())) target = build(now.getFullYear(), now.getMonth() + 1);
  const left = Math.round((target.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000); return left <= 0 ? 'D-DAY' : `D-${left}`;
}

// A quota window upstream is actually enforcing. ChatGPT sends both `primary`
// and `secondary` on every response, but an account may have only one in play:
// the unused one arrives with a zero-length window, no reset and 0% — which
// would otherwise render as a full, untouched bar and read as spare capacity.
function activeWindow(window: { usage: number | null; resetsAt: number | null; minutes?: number | null } | undefined): boolean {
  if (!window) return false;
  return Boolean(window.minutes) || window.resetsAt !== null || (window.usage ?? 0) > 0;
}

// A quota window's own length, named the way a person would say it ("5h", "7d").
// Codex reports the span in its headers; Claude's window names already carry it.
function windowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// What the account order depends on in config: routing.balance and the Fable
// reserve line, read the same way the server reads them.
export interface OrderOptions { balance: Balance; fableReserve: number; now?: number }
export function orderOptions(config: Pick<TeamAIConfig, 'routing' | 'fableReserveThreshold'>): OrderOptions {
  return { balance: config.routing?.balance === 'level' ? 'level' : 'pacing', fableReserve: config.fableReserveThreshold ?? 0.8 };
}

// The accounts in the order the screen draws them: grouped by provider, and
// within a group in the pool's own order unless the roster was switched back
// to configured order. Everything that walks rows — rendering, ↑↓ movement, the
// initial cursor — goes through this one function, so the cursor always lands
// on the adjacent visible row rather than the adjacent entry in config.json.
export function displayOrder(accounts: StoredAccount[], state: PersistedState, byHeadroom: boolean, options: OrderOptions = { balance: 'pacing', fableReserve: 0.8 }): StoredAccount[] {
  // Mirrors AccountPool.byHeadroom: least-spent first on the binding window
  // (Claude's Fable bucket, Codex's main one), then — once they all tie at
  // spent — whichever frees up soonest, unmeasured last, pinned priority first.
  const rank = (account: StoredAccount): { usage: number | null; resetsAt: number | null } => {
    const saved = state.accounts[account.credentialId];
    const windows = saved?.windows || {};
    const binding = Object.entries(windows).find(([name]) => /^7d_[a-z0-9]+$/i.test(name))?.[1]
      ?? windows.primary ?? windows.requests ?? windows['7d'];
    return { usage: binding?.usage ?? saved?.usage ?? null, resetsAt: binding?.resetsAt ?? saved?.resetsAt ?? null };
  };
  // With pacing, the same order the pool gives a new non-Fable request: the
  // Fable tier, then priority, then comparePacing — so the top row is where the
  // green arrow points unless something is unavailable.
  const now = options.now ?? Date.now();
  const windows = (account: StoredAccount) => state.accounts[account.credentialId]?.windows || {};
  const fableSpent = (account: StoredAccount): boolean => {
    const usage = Object.entries(windows(account)).find(([name]) => /^7d_[a-z0-9]+$/i.test(name))?.[1]?.usage;
    return options.fableReserve < 1 && usage !== null && usage !== undefined && usage >= options.fableReserve;
  };
  const ordered: StoredAccount[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    const group = accounts.filter((account) => account.provider === provider);
    if (byHeadroom && options.balance === 'pacing') {
      group.sort((a, b) => {
        const tier = (fableSpent(a) ? 0 : 1) - (fableSpent(b) ? 0 : 1); if (tier) return tier;
        if (a.priority !== null || b.priority !== null) return (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
        return comparePacing({ id: a.id, windows: windows(a) }, { id: b.id, windows: windows(b) }, false, now);
      });
    } else if (byHeadroom) {
      group.sort((a, b) => {
        if (a.priority !== null || b.priority !== null) return (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
        const ra = rank(a); const rb = rank(b);
        if (ra.usage === null || rb.usage === null) return (ra.usage === null ? 1 : 0) - (rb.usage === null ? 1 : 0);
        if (ra.usage !== rb.usage) return ra.usage - rb.usage;
        return (ra.resetsAt ?? Number.MAX_SAFE_INTEGER) - (rb.resetsAt ?? Number.MAX_SAFE_INTEGER);
      });
    }
    ordered.push(...group);
  }
  return ordered;
}

// Braille spinner for requests still in flight. The frame is derived from the
// clock, so the 500ms redraw animates it with no state of its own.
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const clock = (at: number): string => color(90, new Date(at).toLocaleTimeString('en-GB'));

// A session's tag: the first six characters of its id, in a colour fixed by
// the id, so one conversation's lines can be followed down the log. Red (an
// error) and grey (the clock) are left out of the palette.
const SESSION_COLORS = [36, 35, 34, 33, 94, 95, 96, 93, 92];
function sessionTag(id: string): string {
  let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return color(SESSION_COLORS[hash % SESSION_COLORS.length]!, id.slice(0, 6).padEnd(6));
}

// " (model·effort)", the effort in a quieter grey.
function modelText(model: string | null | undefined, effort: string | null | undefined, dim: boolean): string {
  if (!model) return '';
  const name = dim ? color(2, model) : model;
  return ` (${name}${effort ? `${ESC}38;5;244m·${effort}${RESET}` : ''})`;
}

// In-flight requests first, in the order they started, then the log newest
// first. A finished request is drawn from its structured fields so the status
// and duration read the same on every line; anything else is its sentence.
// The session column is there only when some request line has a session, and
// then it is six wide on every request line so methods stay aligned.
function activityLines(active: ActiveRequest[], events: ActivityEvent[], rows: number, show: { sessionIds: boolean; models: boolean }, tint: (provider: string, route: string) => number): string[] {
  const now = Date.now(); const spin = SPINNER[Math.floor(now / 500) % SPINNER.length]!;
  const shownActive = active.slice(0, rows); const shownEvents = [...events].reverse().slice(0, Math.max(0, rows - shownActive.length));
  const tagged = show.sessionIds && [...shownActive, ...shownEvents.map((e) => e.request)].some((r) => r?.sessionId);
  const tag = (id: string | null | undefined): string => tagged ? `${id ? sessionTag(id) : ' '.repeat(6)} ` : '';
  const model = (r: { model?: string | null; effort?: string | null }, dim: boolean): string => show.models ? modelText(r.model, r.effort, dim) : '';
  const routed = (r: { provider: string; route?: string | null; routeFallback?: boolean }): string => r.route ? ` ${color(tint(r.provider, r.route), `[route:${r.route}${r.routeFallback ? '→fallback' : ''}]`)}` : '';
  const out = shownActive.map((entry) => {
    const account = entry.account ? ` → ${entry.account}` : '';
    return `${color(36, spin)} ${clock(entry.startedAt)}  ${tag(entry.sessionId)}${entry.providerLabel} ${entry.method} ${entry.path}${model(entry, true)}${account}${routed(entry)} ${color(2, `(${(Math.max(0, now - entry.startedAt) / 1000).toFixed(1)}s...)`)}`;
  });
  for (const event of shownEvents) {
    const request = event.request;
    if (!request) { out.push(`  ${clock(event.at)}  ${event.message}`); continue; }
    const failed = typeof request.status !== 'number' || request.status >= 400;
    const outcome = `(${request.status}, ${(request.durationMs / 1000).toFixed(1)}s)`;
    out.push(`  ${clock(event.at)}  ${tag(request.sessionId)}${request.providerLabel} ${request.method} ${request.path}${model(request, false)}${request.account ? ` → ${request.account}` : ''}${routed(request)} ${failed ? color(31, outcome) : outcome}`);
  }
  return out;
}

const EXTERNAL_TITLES: Record<ExternalProvider, string> = { antigravity: 'Antigravity (agy)', opencodeGo: 'OpenCode Go', grok: 'Grok' };

// One provider's box: a row per usage group, its windows as the same gauges
// the accounts use (same colour steps, so the screen reads one way), or a
// grey line saying why there is nothing to show. A failed refresh keeps the
// last good gauges for a while, labelled as cached. The gauges sit in the
// account rows' columns: a 5h window under the session gauge, a weekly one
// under the weekly gauge (Grok's only window included), a 30-day one under
// the extra gauge, and a window of unknown length there too.
function externalBox(usage: ExternalUsage, width: number, gauge: number): Array<string | GridRow> {
  const title = ` ${EXTERNAL_TITLES[usage.provider]} `;
  const out: Array<string | GridRow> = [color(36, `┌─${title}${'─'.repeat(Math.max(0, width - visible(title) - 3))}┐`)];
  const placed = new Map(usage.groups.map((group) => [group, placeInSlots(group.windows, (w) => w.minutes, () => SLOTS - 1)]));
  // Each gauge is titled with the provider's own name for the first window
  // drawn in it; a gauge no group uses has no title.
  const titles = Array.from({ length: SLOTS }, (_, slot) => usage.groups.map((group) => placed.get(group)![slot]?.label).find(Boolean));
  const name = (group: string): string => !usage.identity || usage.provider === 'antigravity' ? group : usage.provider === 'opencodeGo' ? `${group} (${usage.identity})` : `${group} ${usage.identity}`;
  const problem = usage.status === 'ok' ? null
    : usage.status === 'signed-out' ? (usage.note ?? 'not signed in') : usage.status === 'expired' ? (usage.note ?? 'sign-in expired')
    : usage.status === 'unavailable' ? (usage.note ?? 'usage unavailable') : `${usage.note ?? 'error'}`;
  if (titles.some(Boolean)) {
    out.push({ identity: '  group', cells: titles, dim: true });
    for (const group of usage.groups) {
      const gauges = placed.get(group)!.map((w) => w && bar(w.usedPercent === null ? null : w.usedPercent / 100, w.resetsAt, gauge));
      out.push({ identity: `  ${name(group.name)}`, cells: gauges, tail: [age(usage.lastOkAt)] });
    }
    if (problem) out.push(color(90, `  refresh failed — showing cached data (${problem})`));
  } else out.push(color(90, `  ${problem ?? (usage.measuredAt ? 'no usage data' : 'not measured yet')}`));
  out.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
  return out;
}

export type FrameMode = 'normal' | 'order' | 'delete' | 'add' | 'credits' | 'routes';

// The reset-credit picker ('t' on a Codex row): the tickets on one account and
// where the operator is in choosing and confirming one.
export interface CreditPicker {
  account: string;
  phase: 'loading' | 'pick' | 'confirm' | 'applying' | 'done';
  items: Array<{ title: string | null; grantedAt: number | null; expiresAt: number | null }>;
  index: number;
  result?: string;
}

function stamp(at: number | null): string {
  if (!at) return '—'; const d = new Date(at); const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pickerLines(picker: CreditPicker, width: number): string[] {
  const title = ` Reset credits — ${picker.account} `;
  const out = [color(36, `┌─${title}${'─'.repeat(Math.max(0, width - visible(title) - 3))}┐`)];
  if (picker.phase === 'loading') out.push(color(90, '  Loading…'));
  else if (!picker.items.length) out.push(color(90, '  No reset credits available'));
  else picker.items.forEach((item, i) => out.push(`${i === picker.index ? color(36, '>') : ' '} ${fit(item.title ?? '(untitled)', 28)} granted ${stamp(item.grantedAt)}  expires ${stamp(item.expiresAt)}`));
  if (picker.phase === 'applying') out.push(color(33, '  Applying…'));
  if (picker.phase === 'done') out.push(`  Result: ${picker.result ?? 'error'}`);
  out.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
  return out;
}

export interface FrameView {
  width: number;
  // The terminal's row count when drawing live: the activity pane grows to
  // fill it and the frame is padded and clipped to exactly that many rows.
  // Absent for a capture, which shows a fixed slice of activity and no padding.
  height?: number;
  selectedId: string | null;
  mode: FrameMode;
  message: string;
  sortByHeadroom: boolean;
  credits?: CreditPicker;
  routes?: RouteEditor;
}

export function buildFrame(config: TeamAIConfig, state: PersistedState, view: FrameView): string[] {
  const { width, height, selectedId, mode, message, sortByHeadroom } = view;
  const accounts = config.accounts; const ordered = displayOrder(accounts, state, sortByHeadroom, orderOptions(config));
  const lines: Array<string | GridRow> = [];
  // One column layout for every panel below (see columns.ts): the account
  // boxes and the other agents' boxes are collected as grid rows and laid out
  // together. The route markers widen the identity column by the larger
  // provider's route count, so both account boxes keep their gauges in line.
  const markWidth = Math.max(0, ...(['claude', 'codex'] as const).map((provider) => (state.routes || []).filter((route) => route.provider === provider).length));
  const barWidth = gaugeWidth(width);
  const claudeCount = accounts.filter((account) => account.provider === 'claude').length; const codexCount = accounts.filter((account) => account.provider === 'codex').length;
  const headerLeft = color(1, ' TeamAI'); const headerRight = `${color(32, '● running')}  Claude ${claudeCount}  Codex ${codexCount}  ${config.proxy.host}:${config.proxy.claudePort}/${config.proxy.codexPort} `;
  lines.push(`${headerLeft}${' '.repeat(Math.max(1, width - visible(headerLeft) - visible(headerRight)))}${headerRight}`); lines.push('━'.repeat(width));
  for (const provider of ['claude', 'codex'] as const) {
    const group = ordered.filter((account) => account.provider === provider); if (!group.length) continue;
    const sectionTitle = ` ${provider === 'claude' ? 'Claude' : 'Codex'} accounts (${group.length}) `;
    lines.push(color(36, `┌─${sectionTitle}${'─'.repeat(Math.max(0, width - sectionTitle.length - 3))}┐`));
    // Column titles: the rows are dense and every field below is an
    // abbreviation, so name them once per section rather than expecting the
    // reader to infer what "auto" or a bare percentage refers to.
    // Codex windows go to the gauge their length says — a 5h limit to the
    // session gauge, a 1w limit to the weekly one, whichever ChatGPT sends it
    // as — and a window of unknown length keeps its primary/secondary place.
    const codexSlots = (account: StoredAccount) => {
      const saved = state.accounts[account.credentialId];
      return placeInSlots([saved?.windows?.primary || saved?.windows?.requests, saved?.windows?.secondary].filter(activeWindow), (window) => window!.minutes, (index) => index);
    };
    // Codex titles follow whatever windows are actually in play for this
    // section, so the header never advertises a gauge that no row renders.
    // Window lengths vary by account, so the title carries the span the rows
    // no longer repeat; fall back to a neutral name when they disagree.
    const spanAt = (slot: number): string => {
      const windows = group.map((account) => codexSlots(account)[slot]).filter(Boolean);
      if (!windows.length) return '';
      const seen = new Set(windows.map((window) => windowLabel(window!.minutes, '')).filter(Boolean));
      return seen.size === 1 ? `${[...seen][0]} limit` : ['usage limit', 'second limit', 'third limit'][slot]!;
    };
    const usageTitles = provider === 'claude' ? ['5h session', '7d overall', '7d Fable'] : Array.from({ length: SLOTS }, (_, slot) => spanAt(slot));
    // One marker column per model route, left of the cursor: the route's
    // colour on its accounts, grey where that account cannot serve now. No
    // routes, no columns — the rows are then exactly as before.
    const routes = (state.routes || []).filter((route) => route.provider === provider);
    // Where a new request would go (state.next, from the server): a green ►
    // after the cursor, a magenta one before the Fable gauge, and a bold
    // route marker for each route's own target.
    const next = state.next?.[provider];
    const marks = (account: StoredAccount): string => ' '.repeat(markWidth - routes.length) + routes.map((route) => {
      const member = route.members.find((m) => m.credentialId === account.credentialId);
      if (!member) return ' ';
      const target = next?.routes?.[route.name] === account.credentialId;
      return `${ESC}${target ? '1;' : ''}${member.usable ? routeColor(route.color) : 90}m▸${RESET}`;
    }).join('');
    const arrow = (account: StoredAccount): string => next?.general === account.credentialId ? color(32, '►') : ' ';
    lines.push({ identity: { lead: '', account: 'account', plan: 'plan', state: 'state', order: 'order' }, cells: usageTitles, dim: true });
    for (const account of group) {
      const saved = state.accounts[account.credentialId]; const profile = saved?.profile; const cursor = account.credentialId === selectedId ? color(36, '>') : ' '; const enabled = account.enabled ? (saved?.error ? color(31, 'error') : saved?.cooldownUntil && saved.cooldownUntil > Date.now() ? color(33, 'cooldown') : color(32, 'active')) : color(90, 'disabled'); const rank = account.priority == null ? 'auto' : `#${account.priority}`;
      const plan = provider === 'claude' && profile && !healthy(profile) ? color(31, profile.status || 'inactive') : provider === 'claude' ? tier(profile) : codexPlan(profile);
      const head = { lead: `${marks(account)}${cursor}${arrow(account)}`, account: account.label, plan, state: enabled, order: rank };
      // Weekly progress against the straight line: -30%p is behind (goes
      // first), +12%p ahead. Blank without a weekly window that resets later.
      const pace = formatDeviation(pacingDeviation(saved?.windows || {}, false, Date.now()));
      const paceText = pace ? color(90, pace) : '';
      if (provider === 'claude') {
        const session = saved?.windows?.['5h']; const weekly = saved?.windows?.['7d']; const fable = saved?.windows?.['7d_oi'] || Object.entries(saved?.windows || {}).find(([name]) => name.startsWith('7d_'))?.[1]; const renew = renewal(profile); const renewColored = renew === 'D-DAY' || /^D-[0-3]$/.test(renew) ? color(31, renew) : /^D-[4-7]$/.test(renew) ? color(33, renew) : color(32, renew);
        const gauges = [bar(session?.usage, session?.resetsAt, barWidth), bar(weekly?.usage, weekly?.resetsAt, barWidth), bar(fable?.usage, fable?.resetsAt, barWidth)];
        lines.push({ identity: head, cells: gauges, tail: [age(saved?.measuredAt), paceText, `~${renewColored}`], gaps: ['', '', next?.fable === account.credentialId ? color(35, '►') : ''] });
      } else {
        const shown = codexSlots(account);
        // Reset credits on hand, when the usage endpoint has counted some.
        const credits = typeof saved?.resetCredits === 'number' && saved.resetCredits > 0 ? color(36, `RC${saved.resetCredits}`) : '';
        lines.push(shown.some(Boolean)
          ? { identity: head, cells: shown.map((window) => window && bar(window.usage, window.resetsAt, barWidth)), tail: [age(saved?.measuredAt), paceText, credits] }
          : { identity: head, cells: color(90, 'no quota data yet'), tail: ['', '', credits] });
      }
    }
    lines.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
  }
  // Other agents' usage, one box each, after the relayed accounts. In a live
  // view a box is left out when it would squeeze the activity pane below its
  // minimum; a provider that is not installed has no entry and no box.
  for (const provider of EXTERNAL_PROVIDERS) {
    const usage = state.external?.[provider]; if (!usage) continue;
    const box = externalBox(usage, width, barWidth);
    if (height !== undefined && lines.length + box.length + 5 + 4 > height) continue;
    lines.push(...box);
  }
  if (mode === 'credits' && view.credits) lines.push(...pickerLines(view.credits, width));
  if (mode === 'routes' && view.routes) lines.push(...routeEditorLines(view.routes, width));
  const activityRows = height === undefined ? 8 : Math.max(4, height - lines.length - 5); lines.push('');
  const active = state.active || [];
  const activityTitle = ` Activity${active.length ? `  ${color(36, `${active.length} active`)}` : ''} `;
  lines.push(`${activityTitle}${'─'.repeat(Math.max(0, width - visible(activityTitle)))}`);
  const tint = (provider: string, name: string): number => routeColor(config.routes?.[provider as 'claude' | 'codex']?.find((route) => route.name === name)?.color);
  lines.push(...activityLines(active, state.events || [], activityRows, { sessionIds: config.activity?.sessionIds !== false, models: config.activity?.models !== false }, tint));
  if (height !== undefined) while (lines.length < height - 2) lines.push('');
  lines.push('─'.repeat(width));
  // 't' only does something on a Codex row, so it is only offered there.
  const codexSelected = accounts.some((account) => account.credentialId === selectedId && account.provider === 'codex');
  const footer = mode === 'routes' && view.routes ? routeEditorFooter(view.routes) : mode === 'normal' ? ` 1 Claude  2 Codex  ↑↓ select  s switch  e enable  o order  d delete  a add  ${codexSelected ? 't credits  ' : ''}p capture  R Reload  c ${sortByHeadroom ? 'quota' : 'config'}-sort  g routes  q quit` : mode === 'order' ? ' ORDER: ↑↓ rank   a/c auto   Enter/Esc done' : mode === 'delete' ? ' DELETE selected account? y/Enter confirm   Esc cancel' : mode === 'add' ? ' ADD: 1 Claude login   2 Codex login   Esc cancel'
    : view.credits?.phase === 'confirm' ? ` Reset ${view.credits.account}'s usage with this credit? (y/n)`
    : view.credits?.phase === 'done' ? ' Esc close' : ' CREDITS: ↑↓ select   Enter use   Esc close';
  // The message is the part that matters when there is one — a capture path,
  // a failure — so when both do not fit it is the key hints that give way.
  const status = message ? `   ${message}` : '';
  lines.push(status && visible(footer) + visible(status) > width ? `${fit(footer, Math.max(0, width - visible(status)))}${status}` : fit(`${footer}${status}`, width));
  const drawn = layoutRows(width, markWidth, lines);
  return (height === undefined ? drawn : drawn.slice(0, height)).map((line) => fit(line, width));
}
