// The dashboard's route editor ('g'): list, add, edit, delete and reorder one
// provider's model routes. The key handling here is pure — a key and the
// current screen in, the next screen out, plus the list to save when a key
// commits one — so it can be driven without a terminal. tui.ts does the
// saving (route-config.ts: validate, write, reload) and frame.ts draws it.
import { ROUTE_COLORS, routeColor, type RouteColor, type RouteConfig } from './routes.js';
import type { ProviderId, StoredAccount, TeamAIConfig } from './types.js';

export const ROUTE_FIELDS = ['name', 'match', 'accounts', 'mode', 'color'] as const;
export const COLOR_CHOICES: Array<RouteColor | null> = [null, ...(Object.keys(ROUTE_COLORS) as RouteColor[])];
export const MODE_HELP = {
  prefer: 'route accounts first; when none can serve, any other account takes it',
  exclusive: 'only route accounts serve, failover included; 429 once they are all spent',
} as const;

export interface RouteDraft { name: string; match: string; accounts: Array<string | number>; mode: 'prefer' | 'exclusive'; color: RouteColor | null }
export interface RouteEdit { at: number | null; field: number; draft: RouteDraft; choices: Array<string | number>; cursor: number }
export interface RouteEditor {
  provider: ProviderId;
  all: Partial<Record<ProviderId, RouteConfig[]>>;
  accounts: StoredAccount[];
  index: number;
  phase: 'list' | 'edit' | 'delete';
  edit?: RouteEdit;
  error?: string;
  warning?: string;
  notice?: string;
}
// A key that commits something: the provider's whole new list, and the route
// the cursor should rest on afterwards.
export interface RouteSave {
  provider: ProviderId;
  routes: RouteConfig[];
  focus: string | null;
  notice: string;
  // route-config checks this snapshot immediately before writing. A CLI edit
  // made while this screen was open must survive the attempted TUI save.
  expected: RouteConfig[];
}

export function openRouteEditor(config: Pick<TeamAIConfig, 'accounts' | 'routes'>, provider: ProviderId, focus: string | null = null, notice?: string): RouteEditor {
  const all = { claude: [...(config.routes?.claude ?? [])], codex: [...(config.routes?.codex ?? [])] };
  const index = Math.max(0, all[provider].findIndex((route) => route.name === focus));
  return { provider, all, accounts: config.accounts, index, phase: 'list', ...(notice ? { notice } : {}) };
}

export const routesOf = (editor: RouteEditor): RouteConfig[] => editor.all[editor.provider] ?? [];
const own = (editor: RouteEditor): StoredAccount[] => editor.accounts.filter((account) => account.provider === editor.provider);
const matches = (route: RouteConfig): string[] => typeof route.match === 'string' ? [route.match] : route.match;

// A stored reference as the editor shows and saves it: the account's label
// when it names one (label, id, credential id or 0-based position, as the
// pool reads them), otherwise as written, so editing never drops it silently.
function resolve(editor: RouteEditor, ref: string | number): string | number {
  const list = own(editor);
  const found = typeof ref === 'number' ? list[ref] : list.find((a) => a.label === ref || a.id === ref || a.credentialId === ref);
  return found ? found.label : ref;
}

function startEdit(editor: RouteEditor, at: number | null): RouteEditor {
  const route = at === null ? undefined : routesOf(editor)[at];
  const picked = route ? route.accounts.map((ref) => resolve(editor, ref)) : [];
  const labels = own(editor).map((account) => account.label);
  const choices = [...labels, ...picked.filter((ref) => !labels.includes(ref as string))];
  const draft: RouteDraft = route
    ? { name: route.name, match: matches(route).join(', '), accounts: picked, mode: route.mode ?? 'prefer', color: route.color ?? null }
    : { name: '', match: '', accounts: [], mode: 'prefer', color: null };
  return { ...editor, phase: 'edit', error: undefined, warning: undefined, notice: undefined, edit: { at, field: 0, draft, choices, cursor: 0 } };
}

// The draft as config.json stores it. Accounts keep the order they are listed
// in on screen; match is split on commas. Not validated here — the save path
// runs it through parseRoutes, the server's own check.
export function draftToRoute(edit: RouteEdit): RouteConfig {
  const { draft } = edit;
  return {
    name: draft.name.trim(),
    match: draft.match.split(',').map((part) => part.trim()).filter(Boolean),
    accounts: edit.choices.filter((choice) => draft.accounts.includes(choice)),
    mode: draft.mode,
    ...(draft.color ? { color: draft.color } : {}),
  };
}

const UP = new Set(['\x1b[A', 'k']); const DOWN = new Set(['\x1b[B', 'j']);
const BACKSPACE = new Set(['\x7f', '\b']);
// eslint-disable-next-line no-control-regex
const printable = (key: string): boolean => key.length > 0 && !/[\x00-\x1f\x7f]/.test(key);

export function routeEditorKey(editor: RouteEditor, key: string): { editor: RouteEditor; save?: RouteSave; close?: boolean } {
  const routes = routesOf(editor);
  if (editor.phase === 'delete') {
    const route = routes[editor.index];
    if ((key === 'y' || key === '\r') && route) {
      const next = routes.filter((_, i) => i !== editor.index);
      return { editor, save: { provider: editor.provider, routes: next, focus: next[Math.min(editor.index, next.length - 1)]?.name ?? null, notice: `Deleted route ${route.name}`, expected: routes } };
    }
    if (key === 'n' || key === '\x1b') return { editor: { ...editor, phase: 'list', notice: 'Delete cancelled' } };
    return { editor };
  }

  if (editor.phase === 'edit' && editor.edit) {
    const edit = editor.edit; const field = ROUTE_FIELDS[edit.field]!; const draft = edit.draft;
    const set = (patch: Partial<RouteEdit>, draftPatch: Partial<RouteDraft> = {}): { editor: RouteEditor } => ({ editor: { ...editor, edit: { ...edit, ...patch, draft: { ...draft, ...draftPatch } } } });
    if (key === '\x1b') return { editor: { ...editor, phase: 'list', edit: undefined, error: undefined, warning: undefined, notice: 'Edit cancelled — nothing saved' } };
    if (key === '\x1b[Z') return set({ field: Math.max(0, edit.field - 1), cursor: 0 });
    if (key === '\r' || key === '\t') {
      if (edit.field < ROUTE_FIELDS.length - 1) return set({ field: edit.field + 1, cursor: 0 });
      if (key === '\t') return { editor };
      const route = draftToRoute(edit);
      const next = [...routes]; if (edit.at === null) next.push(route); else next[edit.at] = route;
      return { editor, save: { provider: editor.provider, routes: next, focus: route.name, notice: `${edit.at === null ? 'Added' : 'Saved'} route ${route.name}`, expected: routes } };
    }
    if (field === 'name' || field === 'match') {
      if (BACKSPACE.has(key)) return set({}, { [field]: draft[field].slice(0, -1) });
      if (printable(key)) return set({}, { [field]: draft[field] + key });
      return { editor };
    }
    if (field === 'accounts') {
      if (UP.has(key)) return set({ cursor: Math.max(0, edit.cursor - 1) });
      if (DOWN.has(key)) return set({ cursor: Math.min(Math.max(0, edit.choices.length - 1), edit.cursor + 1) });
      const choice = edit.choices[edit.cursor];
      if (key === ' ' && choice !== undefined) return set({}, { accounts: draft.accounts.includes(choice) ? draft.accounts.filter((a) => a !== choice) : [...draft.accounts, choice] });
      return { editor };
    }
    if (field === 'mode') {
      if (UP.has(key) || DOWN.has(key) || key === ' ') return set({}, { mode: draft.mode === 'prefer' ? 'exclusive' : 'prefer' });
      return { editor };
    }
    const at = COLOR_CHOICES.indexOf(draft.color);
    if (UP.has(key)) return set({}, { color: COLOR_CHOICES[(at - 1 + COLOR_CHOICES.length) % COLOR_CHOICES.length]! });
    if (DOWN.has(key) || key === ' ') return set({}, { color: COLOR_CHOICES[(at + 1) % COLOR_CHOICES.length]! });
    return { editor };
  }

  // The list.
  const quiet = { ...editor, error: undefined, warning: undefined, notice: undefined };
  if (key === '\x1b' || key === 'q') return { editor, close: true };
  if (UP.has(key)) return { editor: { ...quiet, index: Math.max(0, editor.index - 1) } };
  if (DOWN.has(key)) return { editor: { ...quiet, index: Math.min(Math.max(0, routes.length - 1), editor.index + 1) } };
  if (key === '\t' || key === '\x1b[C' || key === '\x1b[D') return { editor: { ...quiet, provider: editor.provider === 'claude' ? 'codex' : 'claude', index: 0 } };
  if (key === 'a') return { editor: startEdit(editor, null) };
  if ((key === 'e' || key === '\r') && routes[editor.index]) return { editor: startEdit(editor, editor.index) };
  if (key === 'd' && routes[editor.index]) return { editor: { ...quiet, phase: 'delete' } };
  // First match wins, so order is part of the configuration.
  const shift = key === 'K' || key === '[' ? -1 : key === 'J' || key === ']' ? 1 : 0;
  const to = editor.index + shift;
  if (shift && routes[editor.index] && to >= 0 && to < routes.length) {
    const next = [...routes]; [next[editor.index], next[to]] = [next[to]!, next[editor.index]!];
    return { editor, save: { provider: editor.provider, routes: next, focus: routes[editor.index]!.name, notice: `Moved route ${routes[editor.index]!.name} ${shift < 0 ? 'up' : 'down'}`, expected: routes } };
  }
  return { editor };
}

// --- drawing -----------------------------------------------------------------

const ESC = '\x1b['; const RESET = `${ESC}0m`;
const color = (code: number, text: string): string => `${ESC}${code}m${text}${RESET}`;
const label = (provider: ProviderId): string => provider === 'claude' ? 'Claude' : 'Codex';

export function routeEditorLines(editor: RouteEditor, width: number): string[] {
  const routes = routesOf(editor); const edit = editor.phase === 'edit' ? editor.edit : undefined;
  const title = edit ? ` ${edit.at === null ? 'New' : 'Edit'} ${label(editor.provider)} route ` : ` ${label(editor.provider)} routes (${routes.length}) — first match wins `;
  const out = [color(36, `┌─${title}${'─'.repeat(Math.max(0, width - title.length - 3))}┐`)];
  if (!edit) {
    if (!routes.length) out.push(color(90, '  No routes for this provider — a to add one'));
    routes.forEach((route, i) => {
      const mark = i === editor.index ? color(36, '>') : ' ';
      out.push(`${mark} ${String(i + 1).padStart(2)}. ${color(routeColor(route.color ?? null), route.name)} [${route.mode ?? 'prefer'}] ${matches(route).join(', ')} → ${route.accounts.map((ref) => resolve(editor, ref)).join(', ')}`);
    });
  } else {
    const { draft } = edit; const active = ROUTE_FIELDS[edit.field];
    const row = (field: typeof ROUTE_FIELDS[number], value: string): string => `${active === field ? color(36, '>') : ' '} ${field.padEnd(9)}${value}`;
    const cursor = (field: 'name' | 'match'): string => active === field ? `${draft[field]}${color(7, ' ')}` : draft[field];
    out.push(row('name', cursor('name')));
    out.push(row('match', `${cursor('match')}${active === 'match' ? color(90, '   model globs, comma-separated (* = anything)') : ''}`));
    if (active === 'accounts') {
      out.push(row('accounts', color(90, '↑↓ move   Space toggle')));
      edit.choices.forEach((choice, i) => {
        const known = own(editor).some((account) => account.label === choice);
        out.push(`  ${i === edit.cursor ? color(36, '›') : ' '}        [${draft.accounts.includes(choice) ? 'x' : ' '}] ${String(choice)}${known ? '' : color(33, '  (no such account — skipped by the server)')}`);
      });
      if (!edit.choices.length) out.push(color(90, `           no ${label(editor.provider)} accounts`));
    } else out.push(row('accounts', draft.accounts.length ? edit.choices.filter((c) => draft.accounts.includes(c)).map(String).join(', ') : color(90, '(none)')));
    out.push(row('mode', `${draft.mode}  ${color(90, `— ${MODE_HELP[draft.mode]}`)}`));
    if (active === 'mode') out.push(color(90, `           ${draft.mode === 'prefer' ? 'exclusive' : 'prefer'}: ${MODE_HELP[draft.mode === 'prefer' ? 'exclusive' : 'prefer']}`));
    out.push(row('color', draft.color ? color(routeColor(draft.color), draft.color) : color(90, '(default)')));
  }
  if (editor.error) out.push(color(31, `  Not saved: ${editor.error}`));
  else if (editor.warning) out.push(color(33, `  ${editor.warning}`));
  else if (editor.notice) out.push(color(32, `  ${editor.notice}`));
  out.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
  return out;
}

export function routeEditorFooter(editor: RouteEditor): string {
  if (editor.phase === 'delete') return ` DELETE route ${routesOf(editor)[editor.index]?.name ?? ''}? y/Enter confirm   n/Esc cancel`;
  if (editor.phase === 'edit' && editor.edit) {
    const field = ROUTE_FIELDS[editor.edit.field] ?? 'name';
    const last = editor.edit.field === ROUTE_FIELDS.length - 1;
    const keys = field === 'accounts' ? '↑↓ move  Space toggle' : field === 'mode' ? '↑↓/Space switch' : field === 'color' ? '↑↓ choose' : 'type  Backspace erase';
    return ` ROUTE ${field.toUpperCase()}: ${keys}   ${last ? 'Enter save' : 'Enter/Tab next'}   Shift-Tab back   Esc cancel`;
  }
  return ' ROUTES: ↑↓ select  a add  e/Enter edit  d delete  [ ] or K J move  Tab Claude/Codex  Esc close';
}
