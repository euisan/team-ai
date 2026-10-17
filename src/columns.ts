// Terminal cell arithmetic for the dashboard. A string's length is not how
// many columns it takes: a Hangul syllable or a CJK ideograph fills two, a
// combining mark none, and a colour code none at all. Everything that pads,
// truncates or measures a frame line goes through here, so a line built to be
// `width` columns wide is exactly that wide on the screen and in the PNG.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const SGR_SPLIT = new RegExp(`(${String.fromCharCode(27)}\\[[0-9;]*m)`); const ANSI_ONE = new RegExp(`^${String.fromCharCode(27)}\\[[0-9;]*m$`);
const ESC = String.fromCharCode(27); const RESET = `${ESC}[0m`;

// East Asian Wide and Fullwidth ranges, plus the emoji blocks terminals draw
// two cells wide. Ambiguous-width characters (box drawing, ●, …) count as one,
// which is what terminals do unless told otherwise.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x18cff],
  [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];
const ZERO: ReadonlyArray<readonly [number, number]> = [[0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xe0100, 0xe01ef]];
const within = (code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean => {
  let lo = 0; let hi = ranges.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const [from, to] = ranges[mid]!; if (code < from) hi = mid - 1; else if (code > to) lo = mid + 1; else return true; }
  return false;
};

// Columns one character (one code point) takes: 0, 1 or 2.
export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code < 0x300) return 1;
  if (within(code, ZERO)) return 0;
  return within(code, WIDE) ? 2 : 1;
}

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

// Columns a string takes on screen, colour codes ignored.
export function cellWidth(text: string): number {
  let width = 0; for (const char of stripAnsi(text)) width += charWidth(char);
  return width;
}

// Exactly `width` columns: padded with spaces, or cut with an ellipsis when it
// does not fit. Colours up to the cut are kept (and closed after it), so a row
// cut at the terminal's edge keeps its gauges. A wide character that would
// straddle the edge is left out and the gap padded, never split.
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const used = cellWidth(text);
  if (used <= width) return text + ' '.repeat(width - used);
  let out = ''; let taken = 0; let coloured = false;
  for (const part of text.split(SGR_SPLIT)) {
    if (ANSI_ONE.test(part)) { out += part; coloured = true; continue; }
    let full = false;
    for (const char of part) { const w = charWidth(char); if (taken + w > width - 1) { full = true; break; } out += char; taken += w; }
    if (full) break;
  }
  return `${out}${coloured ? RESET : ''}…${' '.repeat(Math.max(0, width - 1 - taken))}`;
}

// The usage grid every dashboard panel draws on — Claude and Codex accounts
// and the other agents' boxes alike — so a gauge in one box sits directly
// above the same kind of gauge in the next:
//
//   identity | session gauge | weekly gauge | extra gauge | tail
//
// The identity is account, plan, state and order on an account row (after the
// route markers, cursor and next-account arrow) and the group name on another
// agent's row; either way it is `id` columns wide. The first gauge is the
// short session window (5h), the second the weekly one, the third whatever a
// provider has beyond those — a model-scoped week, a month. A row without one
// of them leaves that gauge blank at the same width. Narrower terminals get
// narrower gauges and a shorter account name, and anything still too wide is
// cut at the right edge — the same columns for every panel either way.
export const SLOTS = 3;
export const PLAN_WIDTH = 10; export const STATE_WIDTH = 8; export const ORDER_WIDTH = 5;

export interface UsageLayout {
  marks: number;
  account: number;
  id: number;
  gauge: number;
  // Start column of each gauge, then of the tail.
  slots: number[];
  tail: number;
}

// Gauge width depends on the terminal alone, so gauges can be drawn before
// the rest of the layout is known.
export const gaugeWidth = (width: number): number => width >= 132 ? 18 : width >= 120 ? 16 : 12;

// `tail` is the widest tail any row draws; the account name gives up columns
// (down to 10) so the tail fits before anything is cut at the edge.
export function usageLayout(width: number, marks = 0, tail = 0): UsageLayout {
  const gauge = gaugeWidth(width);
  const fixed = marks + 3 + 1 + PLAN_WIDTH + 1 + STATE_WIDTH + 1 + ORDER_WIDTH;
  const account = Math.max(10, Math.min(24, width - fixed - SLOTS * (gauge + 1) - (tail ? tail + 1 : 0)));
  const id = fixed + account;
  return { marks, account, id, gauge, slots: Array.from({ length: SLOTS }, (_, i) => id + 1 + i * (gauge + 1)), tail: id + SLOTS * (gauge + 1) + 1 };
}

// An account row's identity: `lead` is the route markers, cursor and arrow,
// `marks + 2` columns; then account, plan, state and order.
export interface AccountIdentity { lead: string; account: string; plan: string; state: string; order: string }

// One row of the grid, kept as parts until every panel is collected, because
// the account column's width depends on the widest tail in the whole frame.
// `cells` holds a gauge (or a column title) per slot, or nothing for a blank
// one; a single string instead spans all three, for a row with a note where
// its gauges would be. `gaps` replaces the space in front of a slot — the
// Fable arrow sits in the one before the third gauge.
export interface GridRow {
  identity: string | AccountIdentity;
  cells: Array<string | null | undefined> | string;
  tail?: string;
  gaps?: string[];
  dim?: boolean;
}

export function renderRow(layout: UsageLayout, row: GridRow): string {
  const { identity, cells } = row;
  let out = typeof identity === 'string' ? fit(identity, layout.id)
    : `${fit(identity.lead, layout.marks + 2)} ${fit(identity.account, layout.account)} ${fit(identity.plan, PLAN_WIDTH)} ${fit(identity.state, STATE_WIDTH)} ${fit(identity.order, ORDER_WIDTH)}`;
  if (typeof cells === 'string') out += ` ${fit(cells, SLOTS * (layout.gauge + 1) - 1)}`;
  else for (let i = 0; i < SLOTS; i++) out += `${row.gaps?.[i] || ' '}${fit(cells[i] ?? '', layout.gauge)}`;
  if (row.tail) out += ` ${row.tail}`;
  return row.dim ? `${ESC}[90m${out}${RESET}` : out;
}

// Lay out every grid row of a frame on one shared layout; other lines pass
// through untouched.
export function layoutRows(width: number, marks: number, lines: Array<string | GridRow>): string[] {
  const tail = Math.max(0, ...lines.map((line) => typeof line === 'string' ? 0 : cellWidth(line.tail ?? '')));
  const layout = usageLayout(width, marks, tail);
  return lines.map((line) => typeof line === 'string' ? line : renderRow(layout, line));
}

// Which gauge a quota window belongs in, by its length: up to a day is a
// session window, up to a week the weekly one, anything longer an extra.
export function slotOf(minutes: number | null | undefined): number | null {
  if (!minutes) return null;
  return minutes <= 1440 ? 0 : minutes <= 10_080 ? 1 : 2;
}

// Put windows into the three gauges by length; one of unknown length goes to
// `fallback(index)`. Two windows wanting the same gauge: the later one takes
// the next free gauge rather than being dropped.
export function placeInSlots<T>(windows: T[], minutes: (window: T) => number | null | undefined, fallback: (index: number) => number): Array<T | undefined> {
  const out: Array<T | undefined> = Array.from({ length: SLOTS });
  windows.forEach((window, index) => {
    let slot = Math.min(SLOTS - 1, slotOf(minutes(window)) ?? fallback(index));
    while (slot < SLOTS && out[slot] !== undefined) slot++;
    if (slot >= SLOTS) slot = out.findIndex((taken) => taken === undefined);
    if (slot >= 0) out[slot] = window;
  });
  return out;
}
