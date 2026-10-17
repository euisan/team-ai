import assert from 'node:assert/strict';
import test from 'node:test';
import { cellWidth, charWidth, fit } from '../src/columns.js';
import { buildFrame } from '../src/frame.js';
import { renderFrame } from '../src/png.js';
import type { PersistedState, TeamAIConfig } from '../src/types.js';

test('cellWidth counts wide characters twice and colour codes not at all', () => {
  assert.equal(cellWidth('abc'), 3);
  assert.equal(cellWidth('한글'), 4);
  assert.equal(cellWidth('日本語'), 6);
  assert.equal(cellWidth('ＡＢ'), 4);
  assert.equal(cellWidth('\x1b[32mok\x1b[0m'), 2);
  assert.equal(cellWidth('é'), 1);
  assert.equal(cellWidth('┌─●…►▸'), 6);
  assert.equal(charWidth('가'), 2); assert.equal(charWidth('a'), 1); assert.equal(charWidth('​'), 0);
});

test('fit pads and cuts by columns, never splitting a wide character', () => {
  assert.equal(fit('ab', 4), 'ab  ');
  assert.equal(fit('한글', 6), '한글  ');
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(fit('한글이름', 5), '한글…');
  assert.equal(fit('한글이름', 6), '한글… ');
  for (const width of [1, 2, 3, 4, 5, 6, 7]) assert.equal(cellWidth(fit('가나다라마', width)), width);
  assert.equal(cellWidth(fit('\x1b[31m한글\x1b[0m', 8)), 8);
});

const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3,
  accounts: [{ id: '김철수', provider: 'claude', label: '김철수@예시.한국', enabled: true, priority: null, credentialId: 'cred-k', createdAt: '2026-01-01T00:00:00Z' }] };
const state = {
  version: 1, accounts: {},
  external: { antigravity: { provider: 'antigravity', status: 'ok', identity: null, measuredAt: 1, lastOkAt: 1, note: null, groups: [{ name: '제미니 한글 모델 그룹 이름이 아주 긴 경우', windows: [{ label: 'wk', minutes: 10080, usedPercent: 40, resetsAt: null }] }] } },
  events: [{ at: 1, message: '한글로 된 아주 긴 활동 기록 '.repeat(12) }],
} as unknown as PersistedState;

// The regression: lengths were counted in code points, so a Hangul group name
// made its line wider than the terminal; the terminal wrapped it and the
// redraw left border pieces on the wrong rows.
test('every frame line is exactly the frame width in columns, wide text included', () => {
  for (const width of [80, 100, 120, 160, 200]) {
    const lines = buildFrame(config, state, { width, selectedId: null, mode: 'normal', message: '저장했습니다 — 한글 메시지', sortByHeadroom: true });
    for (const line of lines) assert.equal(cellWidth(line), width, `width ${width}: ${JSON.stringify(line)}`);
  }
});

test('the PNG gives a wide character two cells, so its rows stay as wide as the text frame', () => {
  const lines = buildFrame(config, state, { width: 100, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true });
  const png = renderFrame(lines, 0);
  assert.equal(png.readUInt32BE(16), 100 * 9);
  assert.equal(renderFrame(['가a'], 0).readUInt32BE(16), 3 * 9);
});
