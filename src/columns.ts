// Terminal cell arithmetic for the dashboard. A string's length is not how
// many columns it takes: a Hangul syllable or a CJK ideograph fills two, a
// combining mark none, and a colour code none at all. Everything that pads,
// truncates or measures a frame line goes through here, so a line built to be
// `width` columns wide is exactly that wide on the screen and in the PNG.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

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

// Exactly `width` columns: padded with spaces, or cut with an ellipsis (and
// its colours dropped, as before) when it does not fit. A wide character that
// would straddle the edge is left out and the gap padded, never split.
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const used = cellWidth(text);
  if (used <= width) return text + ' '.repeat(width - used);
  let out = ''; let taken = 0;
  for (const char of stripAnsi(text)) { const w = charWidth(char); if (taken + w > width - 1) break; out += char; taken += w; }
  return `${out}…${' '.repeat(Math.max(0, width - 1 - taken))}`;
}
