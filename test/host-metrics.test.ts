import assert from 'node:assert/strict';
import test from 'node:test';
import { cpuSnapshot, cpuUsageBetween, createHostTracker, formatMemory, hostText, loadColor, memoryUsage, type HostSample, type HostSource } from '../src/host-metrics.js';

const GB = 1024 ** 3;
// A fake machine: two cores whose counters and clock the test moves by hand.
function machine(): HostSource & { tick(ms: number, busy: number, idle: number): void } {
  const cores = [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }];
  let clock = 1_000;
  return {
    cpus: () => cores.map((core) => ({ times: { ...core.times } })), totalmem: () => 16 * GB, freemem: () => 4 * GB, now: () => clock,
    tick(ms, busy, idle) { clock += ms; for (const core of cores) { core.times.user += busy / 2; core.times.idle += idle / 2; } },
  };
}

test('CPU% is the busy share between two snapshots, summed over cores', () => {
  assert.deepEqual(cpuSnapshot([{ times: { user: 30, sys: 10, idle: 60 } }, { times: { user: 5, idle: 95 } }]), { idle: 155, total: 200 });
  assert.equal(cpuUsageBetween({ idle: 100, total: 200 }, { idle: 175, total: 300 }), 25);
  assert.equal(cpuUsageBetween({ idle: 0, total: 0 }, { idle: 1, total: 3 }), 66.7, 'one decimal');
});

test('no elapsed time, time going backwards or a missing snapshot gives null', () => {
  assert.equal(cpuUsageBetween({ idle: 10, total: 100 }, { idle: 10, total: 100 }), null);
  assert.equal(cpuUsageBetween({ idle: 10, total: 100 }, { idle: 5, total: 90 }), null);
  assert.equal(cpuUsageBetween(null, { idle: 5, total: 90 }), null);
  assert.equal(cpuUsageBetween({ idle: 5, total: 90 }, undefined), null);
});

test('the tracker: null at first, then the interval since the last sample; within 100 ms it repeats the last value', () => {
  const host = machine(); const tracker = createHostTracker(host);
  assert.equal(tracker.sample().cpu.usedPct, null, 'nothing measured yet');
  host.tick(500, 300, 700); assert.equal(tracker.sample().cpu.usedPct, 30);
  host.tick(50, 100, 0); assert.equal(tracker.sample().cpu.usedPct, 30, 'a 50 ms re-entry reuses the last value');
  host.tick(60, 0, 100);
  // 110 ms since the last measurement, which takes in the 50 ms re-entry's counters too: 100 busy of 200.
  assert.equal(tracker.sample().cpu.usedPct, 50);
  host.tick(500, 0, 0); assert.equal(tracker.sample().cpu.usedPct, 50, 'counters that did not move keep the last value');
  const sample = tracker.sample(); assert.equal(sample.cpu.cores, 2); assert.deepEqual(sample.memory, { totalBytes: 16 * GB, usedBytes: 12 * GB, usedPct: 75 });
});

test('RAM% from total and free memory; zero total gives null', () => {
  const base = machine();
  assert.equal(memoryUsage({ ...base, totalmem: () => 3, freemem: () => 2 }).usedPct, 33.3);
  assert.equal(memoryUsage({ ...base, totalmem: () => 0, freemem: () => 0 }).usedPct, null);
  assert.equal(formatMemory(7.3 * GB, 16 * GB), '7.3/16.0GB');
  assert.equal(formatMemory(300 * 1024 ** 2, 512 * 1024 ** 2), '300/512MB');
  assert.equal(formatMemory(1, 0), '?');
});

test('load colours: none below 70%, yellow from 70%, red from 90%', () => {
  assert.equal(loadColor(null), null); assert.equal(loadColor(0), null); assert.equal(loadColor(69.9), null);
  assert.equal(loadColor(70), 33); assert.equal(loadColor(89.9), 33); assert.equal(loadColor(90), 31); assert.equal(loadColor(100), 31);
  const text = hostText(sample(95, 72), false);
  assert.ok(text.includes('\x1b[31mCPU 95%\x1b[0m'), JSON.stringify(text)); assert.ok(text.includes('\x1b[33mRAM 72%\x1b[0m'), JSON.stringify(text));
  assert.equal(hostText(sample(12, 46), false), 'CPU 12% · RAM 46%', 'a calm machine is not coloured');
  assert.equal(hostText(sample(null, 46), true), 'CPU – · RAM 46% 7.4/16.0GB', 'a missing value is a dash');
});

function sample(cpu: number | null, ram: number): HostSample {
  return { cpu: { usedPct: cpu, cores: 8 }, memory: { totalBytes: 16 * GB, usedBytes: (ram / 100) * 16 * GB, usedPct: ram } };
}
