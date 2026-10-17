// This PC's CPU and memory load, for the dashboard header. Node `os` built-ins
// only, measured by the TUI itself (it runs on the same machine as the relay),
// so there is no server API behind it.
//
// CPU busy% cannot be read at an instant: `os.cpus()` gives cumulative
// per-core time counters since boot, so a percentage only exists BETWEEN two
// snapshots. The tracker keeps the previous snapshot and reports the busy
// share of the interval since the last sample (first sample: null).
import os from 'node:os';

export interface CpuSnapshot { idle: number; total: number }
export interface HostSample {
  cpu: { usedPct: number | null; cores: number };
  memory: { totalBytes: number; usedBytes: number; usedPct: number | null };
}

// What the tracker reads, so a test can drive it with made-up counters.
export interface HostSource {
  cpus(): Array<{ times: Record<string, number> }>;
  totalmem(): number;
  freemem(): number;
  now(): number;
}
const SYSTEM: HostSource = { cpus: () => os.cpus(), totalmem: () => os.totalmem(), freemem: () => os.freemem(), now: () => Date.now() };

// Cumulative CPU times summed over every core.
export function cpuSnapshot(cpus: Array<{ times: Record<string, number> }>): CpuSnapshot {
  let idle = 0; let total = 0;
  for (const cpu of cpus || []) for (const [kind, ms] of Object.entries(cpu.times)) { total += ms; if (kind === 'idle') idle += ms; }
  return { idle, total };
}

// Busy percentage (0–100, one decimal) between two snapshots; null when the
// interval says nothing (a missing snapshot, no time or negative time passed).
export function cpuUsageBetween(prev: CpuSnapshot | null | undefined, next: CpuSnapshot | null | undefined): number | null {
  if (!prev || !next) return null;
  const total = next.total - prev.total; const idle = next.idle - prev.idle;
  if (!(total > 0)) return null;
  return Math.round(Math.min(100, Math.max(0, ((total - idle) / total) * 100)) * 10) / 10;
}

export function memoryUsage(source: HostSource = SYSTEM): HostSample['memory'] {
  const total = source.totalmem(); const used = total - source.freemem();
  return { totalBytes: total, usedBytes: used, usedPct: total > 0 ? Math.round((used / total) * 1000) / 10 : null };
}

// Each sample() is the whole host picture, CPU% measured since the previous
// sample. A re-entry within 100 ms (two redraws back to back) carries too
// little signal, so it repeats the last measured value instead of a jittery one.
export function createHostTracker(source: HostSource = SYSTEM): { sample(): HostSample } {
  let prev = cpuSnapshot(source.cpus()); let prevAt = source.now(); let last: number | null = null;
  return {
    sample() {
      const now = source.now(); const cpus = source.cpus();
      if (now - prevAt >= 100) {
        const snap = cpuSnapshot(cpus); const pct = cpuUsageBetween(prev, snap);
        if (pct != null) last = pct;
        prev = snap; prevAt = now;
      }
      return { cpu: { usedPct: last, cores: cpus.length }, memory: memoryUsage(source) };
    },
  };
}

// SGR colour for a load percentage: red from 90%, yellow from 70%, none below.
export const loadColor = (pct: number | null | undefined): number | null => pct == null ? null : pct >= 90 ? 31 : pct >= 70 ? 33 : null;

// "7.3/16.0GB": used over total, in GB (MB below 1 GB).
export function formatMemory(used: number, total: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0) return '?';
  const gb = 1024 ** 3;
  return total >= gb ? `${(used / gb).toFixed(1)}/${(total / gb).toFixed(1)}GB` : `${Math.round(used / 1024 ** 2)}/${Math.round(total / 1024 ** 2)}MB`;
}

const percent = (pct: number | null | undefined): string => pct == null ? '–' : `${pct.toFixed(0)}%`;

// The header's host field, coloured by load: "CPU 12% · RAM 46%", with the
// used/total amount appended when `amounts` is set. A missing value is '–'.
export function hostText(host: HostSample, amounts: boolean): string {
  const paint = (pct: number | null, text: string): string => { const code = loadColor(pct); return code == null ? text : `\x1b[${code}m${text}\x1b[0m`; };
  const cpu = paint(host.cpu.usedPct, `CPU ${percent(host.cpu.usedPct)}`);
  const ram = paint(host.memory.usedPct, `RAM ${percent(host.memory.usedPct)}`);
  return `${cpu} · ${ram}${amounts ? ` ${formatMemory(host.memory.usedBytes, host.memory.totalBytes)}` : ''}`;
}

// A sample with a measured CPU%, for one-shot callers (`teamai status`, a
// capture): two snapshots `ms` apart.
export async function measureHost(ms = 250, source: HostSource = SYSTEM): Promise<HostSample> {
  const tracker = createHostTracker(source);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return tracker.sample();
}
