import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Warmer } from '../src/warmer.js';
import { buildCodexWarmArgs, CODEX_WARM_MODEL } from '../src/codex-warm.js';

const wait = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
function account(id: string, usageRequestedAt: number) {
  const now = Date.now();
  return { id, label: `account-${id}`, enabled: true, measuredAt: usageRequestedAt, usageRequestedAt, windows: { primary: { usage: 0, resetsAt: now + 5 * 60 * 60_000 }, secondary: { usage: 0.1, resetsAt: now + 3 * 86_400_000 } }, cooldownUntil: null, error: null, warmFailures: 0, warmRetryAt: null, warmGaveUp: false };
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

test('warm command pins only the requested account and carries no credential', () => {
  const args = buildCodexWarmArgs(3457, 'a b'); const text = args.join(' ');
  assert.match(text, /\/tc-acct\/a%20b\/codex/);
  assert.equal(args.at(-1), 'hi');
  assert.equal(args.includes('Bearer'), false);
});

