import assert from 'node:assert/strict';
import test from 'node:test';
import { cellWidth, stripAnsi } from '../src/columns.js';
import { buildFrame, type FrameView } from '../src/frame.js';
import type { HostSample } from '../src/host-metrics.js';
import { config, state } from './narrow-fixture.js';

// The dashboard header with this PC's CPU/RAM, drawn from synthetic data
// (narrow-fixture.ts) and made-up host samples.
const GB = 1024 ** 3;
const sample = (cpu: number | null, ram: number): HostSample => ({ cpu: { usedPct: cpu, cores: 8 }, memory: { totalBytes: 16 * GB, usedBytes: (ram / 100) * 16 * GB, usedPct: ram } });
const header = (width: number, host: HostSample | null | undefined): string => {
  const view: FrameView = { width, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true, host };
  return buildFrame(config, state, view)[0]!;
};
const PORTS = '127.0.0.1:3456/3457';

test('the header never outgrows the terminal, and shows what fits of CPU/RAM', () => {
  for (const width of [40, 46, 80, 120, 160]) {
    for (const host of [sample(12, 46), sample(100, 99.9), sample(null, 46)]) {
      const line = header(width, host);
      assert.ok(cellWidth(line) <= width, `width ${width}: ${cellWidth(line)} columns: ${JSON.stringify(stripAnsi(line))}`);
    }
  }
  assert.match(stripAnsi(header(120, sample(12, 46))), /^ TeamAI +CPU 12% · RAM 46% 7\.4\/16\.0GB {2}127\.0\.0\.1:3456\/3457 $/);
  assert.match(stripAnsi(header(160, sample(null, 46))), /CPU – · RAM 46% /, 'first sample: a dash');
  assert.match(stripAnsi(header(60, sample(12, 46))), /^ TeamAI +CPU 12% · RAM 46% $/, 'narrow layout: no GB amount, no ports');
});

test('the header has no running label and no account counts, at any width', () => {
  for (let width = 20; width <= 200; width++) {
    for (const host of [sample(12, 46), null]) {
      const line = stripAnsi(header(width, host));
      assert.ok(!line.includes('●') && !line.includes('running'), `width ${width}: ${JSON.stringify(line)}`);
      assert.ok(!/Claude \d|Codex \d|C\d X\d/.test(line), `width ${width}: ${JSON.stringify(line)}`);
    }
  }
});

test('at 40, 60, 80 and 120 columns the header is one line that fits, title first', () => {
  const expected: Record<number, RegExp> = {
    40: /^ TeamAI +CPU 12% · RAM 46% $/,
    60: /^ TeamAI +CPU 12% · RAM 46% $/,
    80: /^ TeamAI +CPU 12% · RAM 46% 7\.4\/16\.0GB {2}127\.0\.0\.1:3456\/3457 $/,
    120: /^ TeamAI +CPU 12% · RAM 46% 7\.4\/16\.0GB {2}127\.0\.0\.1:3456\/3457 $/,
  };
  for (const [width, pattern] of Object.entries(expected).map(([w, p]) => [Number(w), p] as const)) {
    const line = header(width, sample(12, 46));
    assert.ok(!line.includes('\n'), `width ${width}: one line`);
    assert.equal(cellWidth(line), width, `width ${width}: fills the row exactly: ${JSON.stringify(stripAnsi(line))}`);
    assert.match(stripAnsi(line), pattern, `width ${width}`);
    const bare = header(width, undefined);
    assert.equal(cellWidth(bare), width, `width ${width}, no host sample`);
    assert.match(stripAnsi(bare), width < 80 ? /^ TeamAI +$/ : /^ TeamAI +127\.0\.0\.1:3456\/3457 $/, `width ${width}, no host sample`);
  }
});

test('when the header is short of room, CPU/RAM go before the port', () => {
  // Wherever the port is missing, CPU/RAM are too.
  for (let width = 80; width <= 200; width++) {
    const line = stripAnsi(header(width, sample(100, 100)));
    if (!line.includes(PORTS)) assert.ok(!line.includes('CPU'), `wide ${width}: ${JSON.stringify(line)}`);
    if (line.includes('GB')) assert.ok(line.includes('CPU') && line.includes(PORTS));
  }
  for (let width = 20; width < 80; width++) {
    const line = stripAnsi(header(width, sample(100, 100)));
    assert.ok(line.startsWith(' TeamAI'), `narrow ${width}: the title stays`);
    assert.ok(!line.includes('GB'), `narrow ${width}: no GB amount`);
    assert.ok(cellWidth(line) <= width, `narrow ${width}: ${JSON.stringify(line)}`);
  }
});

test('without a host sample the header is the title and the ports', () => {
  const right = `${PORTS} `;
  assert.equal(stripAnsi(header(120, undefined)), ` TeamAI${' '.repeat(120 - 7 - cellWidth(right))}${right}`);
  assert.ok(!stripAnsi(header(60, null)).includes('CPU'));
});
