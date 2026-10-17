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
  assert.match(stripAnsi(header(120, sample(12, 46))), /CPU 12% · RAM 46% 7\.4\/16\.0GB {2}● running {2}Claude 3 {2}Codex 2 {2}127\.0\.0\.1:3456\/3457 $/);
  assert.match(stripAnsi(header(160, sample(null, 46))), /CPU – · RAM 46% /, 'first sample: a dash');
  assert.match(stripAnsi(header(80, sample(12, 46))), /CPU 12% · RAM 46% {2}● running .*3457 $/, 'wide at 80: the GB amount goes first');
  assert.match(stripAnsi(header(60, sample(12, 46))), /CPU 12% · RAM 46% {2}● running {2}Claude 3 {2}Codex 2 $/, 'narrow layout: no GB amount');
});

test('when the header is short of room, CPU/RAM go before the port and the running label', () => {
  for (const width of [40, 46]) {
    const line = stripAnsi(header(width, sample(12, 46)));
    assert.ok(!line.includes('CPU') && !line.includes('RAM'), `width ${width}: ${JSON.stringify(line)}`);
    assert.ok(line.includes('● running  Claude 3  Codex 2'), `width ${width}: the running label stays: ${JSON.stringify(line)}`);
  }
  // Wherever the port or the full running label is missing, CPU/RAM are too.
  for (let width = 80; width <= 200; width++) {
    const line = stripAnsi(header(width, sample(100, 100)));
    if (!line.includes(PORTS)) assert.ok(!line.includes('CPU'), `wide ${width}: ${JSON.stringify(line)}`);
    if (line.includes('GB')) assert.ok(line.includes('CPU') && line.includes(PORTS));
  }
  for (let width = 20; width < 80; width++) {
    const line = stripAnsi(header(width, sample(100, 100)));
    if (!line.includes('● running')) assert.ok(!line.includes('CPU'), `narrow ${width}: ${JSON.stringify(line)}`);
    assert.ok(!line.includes('GB'), `narrow ${width}: no GB amount`);
  }
});

test('without a host sample the header is as it was', () => {
  const right = `● running  Claude 3  Codex 2  ${PORTS} `;
  assert.equal(stripAnsi(header(120, undefined)), ` TeamAI${' '.repeat(120 - 7 - cellWidth(right))}${right}`);
  assert.ok(!stripAnsi(header(60, null)).includes('CPU'));
});
