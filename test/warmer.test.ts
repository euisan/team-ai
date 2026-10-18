import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Warmer } from '../src/warmer.js';
import { buildCodexWarmArgs, CODEX_WARM_MODEL } from '../src/codex-warm.js';
import { warmEligibility } from '../src/warm-schedule.js';

const wait = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
function fakeClock(start: number) {
  type FakeTimer = { at: number; fn: () => void; unref(): void };
  let now = start; const timers = new Set<FakeTimer>();
  return { now: () => now, setTimeout: (fn: () => void, ms: number) => { const t: FakeTimer = { at: now + ms, fn, unref() {} }; timers.add(t); return t; }, clearTimeout: (timer: { at?: number; fn?: () => void; unref?: () => void }) => { timers.delete(timer as FakeTimer); }, async advance(ms: number) { const target = now + ms; while (true) { const due = [...timers].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0]; if (!due) break; now = due.at; timers.delete(due); due.fn(); await wait(); } now = target; await wait(); }, pending: () => timers.size };
}
function account(id: string, usageRequestedAt: number) {
  const now = Date.now();
  return { id, label: `account-${id}`, enabled: true, measuredAt: usageRequestedAt, usageRequestedAt, windows: { primary: { usage: 0, resetsAt: now + 5 * 60 * 60_000 }, secondary: { usage: 0.1, resetsAt: now + 3 * 86_400_000 } }, cooldownUntil: null, error: null, warmFailures: 0, warmRetryAt: null, warmGaveUp: false, warmSignature: undefined as string | undefined };
}

test('warmer runs one real Codex command for a fresh idle account', async () => {
  const a = account('a', Date.now() + 100); const specs: Array<{ args: string[] }> = [];
  const warmer = new Warmer({ accounts: [a] }, { port: 3457, spawnFn: async (spec) => { specs.push(spec); return 0; } });
  warmer.start(); await wait();
  assert.equal(specs.length, 1);
  assert.ok(specs[0]!.args.join(' ').includes('/tc-acct/a/codex'));
  assert.equal(specs[0]!.args.at(-1), 'hi');
  assert.ok(specs[0]!.args.includes(CODEX_WARM_MODEL));
  warmer.stop();
});

test('restored usage before process start cannot trigger a warm', async () => {
  const a = account('a', Date.now() - 60_000); const specs: unknown[] = [];
  const warmer = new Warmer({ accounts: [a] }, { port: 3457, spawnFn: async (spec) => { specs.push(spec); return 0; } });
  warmer.start(); await wait();
  assert.equal(specs.length, 0);
  warmer.stop();
});

test('a failed warm is backed off instead of looping on the next event', async () => {
  const a = account('retry', Date.now() + 100); let attempts = 0;
  const warmer = new Warmer({ accounts: [a] }, { port: 3457, spawnFn: async () => { attempts++; return 1; } });
  warmer.start(); await wait();
  warmer.onAccountChanged(a); await wait();
  assert.equal(attempts, 1);
  assert.equal(a.warmFailures, 1);
  assert.ok((a.warmRetryAt || 0) > Date.now());
  warmer.stop();
});

test('a warm abandoned after two failures is not eligible again', () => {
  const now = Date.now(); const a = account('gave-up', now); a.warmSignature = 'idle'; a.warmGaveUp = true;
  assert.deepEqual(warmEligibility(a, now), { eligible: false, reason: 'gave-up' });
});

test('a zero rounded reading with a short reset window is still running', () => {
  const now = Date.now(); const a = account('rounded', now); a.windows!.primary = { usage: 0, resetsAt: now + 243 * 60_000 }; a.usageRequestedAt = now;
  assert.deepEqual(warmEligibility(a, now), { eligible: false, reason: 'window-running' });
});

test('a reset timer refreshes usage before warming', async () => {
  const now = Date.now(); const clock = fakeClock(now); const a = account('reset', now); a.windows!.primary = { usage: 0.2, resetsAt: now + 60 * 60_000 }; a.usageRequestedAt = now;
  let refreshes = 0; let warms = 0;
  const warmer = new Warmer({ accounts: [a] }, { port: 3457, nowFn: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, refreshUsage: async () => { refreshes++; if (refreshes > 1) { a.windows!.primary = { usage: 0, resetsAt: clock.now() + 5 * 60 * 60_000 }; a.usageRequestedAt = clock.now(); } }, spawnFn: async () => { warms++; return 0; } });
  warmer.start(); await wait(); assert.equal(warms, 0); await clock.advance(60 * 60_000 + 9_999); assert.equal(warms, 0); await clock.advance(1); assert.equal(refreshes, 2); assert.equal(warms, 1); warmer.stop();
});

test('accounts due together are warmed one at a time', async () => {
  const first = account('first', Date.now() + 100); const second = account('second', Date.now() + 100); let active = 0; let maximum = 0; const releases: Array<() => void> = [];
  const warmer = new Warmer({ accounts: [first, second] }, { port: 3457, spawnFn: () => new Promise<number>((resolve) => { active++; maximum = Math.max(maximum, active); releases.push(() => { active--; resolve(0); }); }) });
  warmer.start(); await wait(); assert.equal(releases.length, 1); releases.shift()!(); await wait(); assert.equal(releases.length, 1); releases.shift()!(); await wait(); assert.equal(maximum, 1); warmer.stop();
});

test('warm command pins only the requested account and carries no credential', () => {
  const args = buildCodexWarmArgs(3457, 'a b'); const text = args.join(' ');
  assert.match(text, /\/tc-acct\/a%20b\/codex/);
  assert.equal(args.at(-1), 'hi');
  assert.equal(args.includes('Bearer'), false);
});

