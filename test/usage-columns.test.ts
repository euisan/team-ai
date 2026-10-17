import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { cellWidth, charWidth, gaugeWidth, placeInSlots, stripAnsi } from '../src/columns.js';
import { buildFrame } from '../src/frame.js';
import { BACKGROUND, renderFrame } from '../src/png.js';
import type { PersistedState, StoredAccount, TeamAIConfig } from '../src/types.js';

// Five panels from synthetic data: two Claude accounts, a Codex account with
// 5h + 7d windows and one with only a weekly window, Antigravity with a group
// that has no session window and one with a Hangul name, OpenCode Go with all
// three, and Grok with only its weekly window. A route on the Claude side only,
// so the two account boxes have different marker counts.
const now = Date.now(); const h = 3_600_000; const d = 24 * h;
const account = (provider: 'claude' | 'codex', label: string): StoredAccount => ({ id: label, provider, label, enabled: true, priority: null, credentialId: `cred-${label}`, createdAt: '2026-01-01T00:00:00Z' });
const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3,
  accounts: [account('claude', 'alice@example.com'), account('claude', '김철수.아주긴주소@example.com'), account('codex', 'carol@example.com'), account('codex', 'dave@example.com')] };
const measured = { cooldownUntil: null, lastUsed: null, error: null, measuredAt: now - 14 * 60_000 };
const group = (name: string, windows: Array<[string, number | null, number]>) => ({ name, windows: windows.map(([label, minutes, usedPercent]) => ({ label, minutes, usedPercent, resetsAt: now + 2 * d })) });
const external = (provider: string, identity: string | null, groups: unknown[]) => ({ provider, status: 'ok', identity, measuredAt: now - 14 * 60_000, lastOkAt: now - 14 * 60_000, note: null, groups });
const state = {
  version: 1,
  accounts: {
    'cred-alice@example.com': { ...measured, usage: 0.4, resetsAt: null, profile: { hasClaudeMax: true, status: 'active', createdAt: '2026-01-29T00:00:00Z' }, windows: { '5h': { usage: 0.42, resetsAt: now + 3 * h }, '7d': { usage: 0.61, resetsAt: now + 2 * d }, '7d_oi': { usage: 0.35, resetsAt: now + 2 * d } } },
    'cred-김철수.아주긴주소@example.com': { ...measured, usage: 0.9, resetsAt: null, windows: { '5h': { usage: 0.93, resetsAt: now + h }, '7d': { usage: 0.2, resetsAt: now + 5 * d }, '7d_oi': { usage: 0.1, resetsAt: now + 5 * d } } },
    'cred-carol@example.com': { ...measured, usage: 0.3, resetsAt: null, resetCredits: 2, windows: { primary: { usage: 0.3, resetsAt: now + 2 * h, minutes: 300 }, secondary: { usage: 0.75, resetsAt: now + 4 * d, minutes: 10080 } } },
    'cred-dave@example.com': { ...measured, usage: 0.1, resetsAt: null, windows: { primary: { usage: 0.1, resetsAt: now + 6 * d, minutes: 10080 } } },
  },
  routes: [{ provider: 'claude', name: 'fable', color: 'magenta', mode: 'prefer', members: [{ credentialId: 'cred-alice@example.com', usable: true }] }],
  external: {
    antigravity: external('antigravity', null, [group('Gemini 3 Pro', [['5h', 300, 20], ['wk', 10080, 55]]), group('Gemini 4 Argon', [['wk', 10080, 12]]), group('제미니 한글 모델 그룹 이름이 아주 긴 경우', [['5h', 300, 80], ['wk', 10080, 40]])]),
    opencodeGo: external('opencodeGo', 'env', [group('OpenCode Go', [['5h', 300, 5], ['wk', 10080, 33], ['30d', 43200, 71]])]),
    grok: external('grok', 'SuperGrok ev•••@ex•••.com', [group('Grok', [['wk', 10080, 48]])]),
  },
} as unknown as PersistedState;

const frame = (width: number): string[] => buildFrame(config, state, { width, selectedId: 'cred-alice@example.com', mode: 'normal', message: '', sortByHeadroom: false });
const frameWithSelection = (width: number, selectedId: string): string[] => buildFrame(config, state, { width, selectedId, mode: 'normal', message: '', sortByHeadroom: false });

// The gauges of one line as [start column, width], found by their background
// colour runs (a gauge opens with a background SGR and closes with a reset),
// with columns counted in terminal cells.
const ESC = String.fromCharCode(27);
function gauges(line: string): Array<[number, number]> {
  const out: Array<[number, number]> = []; let col = 0; let start: number | null = null;
  for (const part of line.split(new RegExp(`(${ESC}\\[[0-9;]*m)`))) {
    const sgr = new RegExp(`^${ESC}\\[([0-9;]*)m$`).exec(part);
    if (!sgr) { for (const char of part) col += charWidth(char); continue; }
    const codes = sgr[1]!.split(';').map(Number);
    if (start === null && codes.some((code) => [41, 42, 43, 100].includes(code))) start = col;
    else if (start !== null && codes.includes(0)) { out.push([start, col - start]); start = null; }
  }
  return out;
}
// The column (in cells) where `needle` starts in a line, colours ignored.
const columnOf = (line: string, needle: string): number => { const plain = stripAnsi(line); const at = plain.indexOf(needle); return at < 0 ? -1 : cellWidth(plain.slice(0, at)); };
const row = (lines: string[], needle: string): string => { const found = lines.find((line) => stripAnsi(line).includes(needle)); assert.ok(found, `no row with ${needle}`); return found; };
const panel = (lines: string[], title: string): string[] => { const start = lines.findIndex((line) => stripAnsi(line).includes(`─ ${title}`)); return lines.slice(start, lines.findIndex((line, i) => i > start && stripAnsi(line).startsWith('└'))); };

const WIDTHS = [80, 100, 119, 120, 131, 132, 160, 200];

test('every panel draws its gauges in the same three columns at the same width', () => {
  for (const width of WIDTHS) {
    const lines = frame(width); const gauge = gaugeWidth(width);
    const slots = gauges(row(lines, 'alice@'));
    assert.deepEqual(slots, [0, 1, 2].map((i) => [slots[0]![0] + i * (gauge + 1), gauge]), `width ${width}: three gauges, one column apart`);
    const expect = (needle: string, used: number[]): void => assert.deepEqual(gauges(row(lines, needle)), used.map((i) => slots[i]), `width ${width}: ${needle}`);
    expect('김철수', [0, 1, 2]);
    expect('carol@', [0, 1]);
    expect('Gemini 3 Pro', [0, 1]);
    expect('제미니', [0, 1]);
    expect('OpenCode Go (env)', [0, 1, 2]);
  }
});

test('Grok\'s weekly window is drawn in the weekly gauge, not the session one', () => {
  for (const width of WIDTHS) {
    const lines = frame(width); const slots = gauges(row(lines, 'alice@'));
    assert.deepEqual(gauges(row(lines, 'Grok SuperGrok')), [slots[1]], `width ${width}`);
    const header = panel(lines, 'Grok')[1]!;
    assert.equal(columnOf(header, '7d'), slots[1]![0], `width ${width}: Grok's 7d title over the weekly gauge`);
  }
});

test('a missing window leaves a blank gauge and does not push the next one left', () => {
  for (const width of WIDTHS) {
    const lines = frame(width); const slots = gauges(row(lines, 'alice@'));
    // Antigravity's Argon group has no 5h window; Codex's dave only a weekly one.
    assert.deepEqual(gauges(row(lines, 'Gemini 4 Argon')), [slots[1]], `width ${width}: Argon`);
    assert.deepEqual(gauges(row(lines, 'dave@')), [slots[1]], `width ${width}: dave`);
    const argon = stripAnsi(row(lines, 'Gemini 4 Argon'));
    const blank = argon.slice(slots[0]![0], slots[0]![0] + slots[0]![1]);
    assert.equal(blank.trim(), '', `width ${width}: the session gauge is blank`);
  }
});

test('column titles sit over their gauges in every panel', () => {
  for (const width of WIDTHS) {
    const lines = frame(width); const slots = gauges(row(lines, 'alice@')).map(([start]) => start);
    const titles: Array<[string, string, number]> = [
      ['Claude accounts', '5h session', 0], ['Claude accounts', '7d', 1], ['Claude accounts', '7d Fable', 2],
      ['Codex accounts', '5h', 0], ['Codex accounts', '7d', 1],
      ['Antigravity (agy)', '5h', 0], ['Antigravity (agy)', '7d', 1],
      ['OpenCode Go', '5h', 0], ['OpenCode Go', '7d', 1], ['OpenCode Go', '30d', 2],
    ];
    for (const [title, name, slot] of titles) {
      const header = panel(lines, title)[1]!;
      assert.equal(columnOf(header, ` ${name}`) + 1, slots[slot], `width ${width}: ${title} "${name}"`);
    }
  }
});

test('the identity column is the same width in every panel', () => {
  for (const width of WIDTHS) {
    const lines = frame(width); const id = gauges(row(lines, 'alice@'))[0]![0] - 1;
    for (const title of ['Claude accounts', 'Codex accounts', 'Antigravity (agy)', 'OpenCode Go', 'Grok']) {
      for (const line of panel(lines, title).slice(1)) {
        const plain = stripAnsi(line); let col = 0; let cut = 0;
        for (const char of plain) { if (col >= id) break; col += charWidth(char); cut += char.length; }
        assert.equal(col, id, `width ${width}: ${title} identity ends on a cell boundary`);
        assert.equal(plain[cut], ' ', `width ${width}: ${title} has a gap after its identity: ${JSON.stringify(plain)}`);
      }
    }
  }
});

test('the tail starts in the same column on every row that has one', () => {
  for (const width of [160, 200]) {
    const lines = frame(width); const [start, size] = gauges(row(lines, 'alice@'))[2]!; const tail = start + size + 1;
    for (const needle of ['alice@', '김철수', 'carol@', 'dave@', 'Gemini 4 Argon', '제미니', 'OpenCode Go (env)', 'Grok SuperGrok']) {
      const plain = stripAnsi(row(lines, needle));
      let col = 0; let first = -1;
      for (const char of plain) { if (col >= tail && char !== ' ') { first = col; break; } col += charWidth(char); }
      assert.equal(first, tail, `width ${width}: ${needle}`);
    }
  }
});

test('placeInSlots puts windows by length and moves a collision to the next free gauge', () => {
  const w = (minutes: number | null) => ({ minutes });
  assert.deepEqual(placeInSlots([w(10080)], (x) => x.minutes, (i) => i), [undefined, w(10080), undefined]);
  assert.deepEqual(placeInSlots([w(300), w(10080), w(43200)], (x) => x.minutes, (i) => i), [w(300), w(10080), w(43200)]);
  assert.deepEqual(placeInSlots([w(null), w(null)], (x) => x.minutes, (i) => i), [w(null), w(null), undefined]);
  const a = { minutes: 10080, n: 1 }; const b = { minutes: 10080, n: 2 };
  assert.deepEqual(placeInSlots([a, b], (x) => x.minutes, () => 0), [undefined, a, b]);
});

test('the PNG capture keeps the same gauge columns as the text frame', () => {
  for (const width of [100, 160]) {
    const lines = frame(width); const png = renderFrame(lines, 0);
    // Decode just enough of the image: the frame is a fixed grid of 9×18 cells,
    // so sample the pixel in the middle of a cell from the raw scanlines.
    const idat = png.subarray(33 + 8, png.length - 16);
    const raw = inflateSync(idat); const pxWidth = png.readUInt32BE(16); const stride = pxWidth * 3 + 1;
    assert.equal(pxWidth, width * 9);
    const pixel = (col: number, line: number): number[] => { const x = col * 9 + 4; const y = line * 18 + 9; const at = y * stride + 1 + x * 3; return [raw[at]!, raw[at + 1]!, raw[at + 2]!]; };
    lines.forEach((line, index) => {
      for (const [start, size] of gauges(line)) {
        assert.notDeepEqual(pixel(start, index), [...BACKGROUND], `width ${width} row ${index}: gauge starts at ${start} in the image`);
        assert.notDeepEqual(pixel(start + size - 1, index), [...BACKGROUND], `width ${width} row ${index}: gauge ends at ${start + size - 1}`);
        assert.deepEqual(pixel(start - 1, index), [...BACKGROUND], `width ${width} row ${index}: nothing painted just before the gauge`);
      }
    });
  }
});

test('the tail fields — age, pace, RC / ~D-n — each start in one column across panels', () => {
  for (const width of [120, 160, 200]) {
    const lines = frame(width);
    const ages = ['alice@', '김철수', 'carol@', 'dave@', 'Gemini 3 Pro', 'Gemini 4 Argon', '제미니', 'OpenCode Go (env)', 'Grok SuperGrok'].map((needle) => columnOf(row(lines, needle), '14m ago'));
    assert.equal(new Set(ages).size, 1, `width ${width}: age columns ${ages}`);
    const paces = (['alice@', '김철수', 'carol@', 'dave@'] as const).map((needle) => columnOf(row(lines, needle), stripAnsi(row(lines, needle)).match(/[+-]\d+%p/)![0]));
    assert.equal(new Set(paces).size, 1, `width ${width}: pace columns ${paces}`);
    assert.ok(paces[0]! > ages[0]!);
    assert.equal(columnOf(row(lines, 'carol@'), 'RC2'), columnOf(row(lines, 'alice@'), '~D-'), `width ${width}: RC and ~D-n share the extra column`);
  }
});

test('a row without pace keeps its age and extra tail fields in the shared columns', () => {
  const noPace = {
    ...state,
    accounts: {
      ...state.accounts,
      'cred-dave@example.com': {
        ...state.accounts['cred-dave@example.com'],
        resetCredits: 2,
        windows: { primary: { usage: 0.1, resetsAt: now + 6 * d, minutes: 300 } },
      },
    },
  } as PersistedState;
  for (const width of [120, 160, 200]) {
    const lines = buildFrame(config, noPace, { width, selectedId: 'cred-alice@example.com', mode: 'normal', message: '', sortByHeadroom: false });
    const age = columnOf(row(lines, 'alice@'), '14m ago');
    const extra = columnOf(row(lines, 'carol@'), 'RC2');
    const dave = row(lines, 'dave@');
    assert.equal(columnOf(dave, '14m ago'), age, `width ${width}: age stays aligned without pace`);
    assert.equal(columnOf(dave, 'RC2'), extra, `width ${width}: RC stays in the extra column without pace`);
    assert.doesNotMatch(stripAnsi(dave), /[+-]\d+%p/, `width ${width}: no pace is invented`);
  }
});

test('Claude and Codex selected rows show the cursor in the selection column', () => {
  for (const width of [120, 160, 200]) {
    const claude = row(frameWithSelection(width, 'cred-alice@example.com'), 'alice@');
    const codexSelected = row(frameWithSelection(width, 'cred-carol@example.com'), 'carol@');
    const codexUnselected = row(frameWithSelection(width, 'cred-carol@example.com'), 'dave@');
    assert.match(stripAnsi(claude), /^▸> {2}alice@/, `width ${width}: Claude cursor`);
    assert.match(stripAnsi(codexSelected), /^ > {2}carol@/, `width ${width}: Codex cursor`);
    assert.match(stripAnsi(codexUnselected), /^ {4}dave@/, `width ${width}: unselected Codex row`);
  }
});
