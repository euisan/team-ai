import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { stripAnsi } from '../src/columns.js';
import { buildFrame } from '../src/frame.js';
import { claudeProvider } from '../src/providers.js';
import { UsageRefresher } from '../src/usage-refresh.js';
import type { OAuthCredential, PersistedState, Provider, StoredAccount, TeamAIConfig } from '../src/types.js';

const stored: StoredAccount = { id: 'c1', provider: 'claude', label: 'c1@example.com', enabled: true, priority: null, credentialId: 'claude:c1', createdAt: '' };
const credential: OAuthCredential = { accessToken: 'tok-c1', refreshToken: null, expiresAt: null, accountId: 'uuid-c1' };
const limits = [{ kind: 'session', percent: 40, resets_at: '2026-11-11T20:00:00Z' }];

async function usageServer(body: (url: string) => unknown): Promise<{ url: string; paths: string[]; close: () => void }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body(req.url || '')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, paths, close: () => { server.closeAllConnections(); server.close(); } };
}

const poolFor = (base: string, state: PersistedState = { version: 1, accounts: {} }): AccountPool =>
  new AccountPool({ ...claudeProvider, upstreamBase: base, refresh: async (value) => value }, [stored], { 'claude:c1': credential }, state);

test('the periodic usage read asks for ticket data and stores the count from the same response', async (t) => {
  const fake = await usageServer((url) => ({
    limits,
    ...(/cedar_ember=1/.test(url) ? { cedar_ember: { eligible: true, grants: [{ id: 'g1', resets_left: 2, paused: false }] } } : {}),
  }));
  t.after(fake.close);

  const pool = poolFor(fake.url);
  const account = pool.accounts[0]!;
  assert.equal(account.resetCredits, null, 'nothing known before the read');
  assert.equal(account.resetCreditsAt, null);

  assert.equal(await pool.refreshUsageAccount(account), true);
  assert.equal(account.resetCredits, 2, 'the count arrives on the usage read');
  assert.equal(typeof account.resetCreditsAt, 'number');
  assert.equal(fake.paths.length, 1, 'no second request for the count');
  assert.equal(fake.paths[0], '/api/oauth/usage?cedar_ember=1&skip_spend=1');

  const exported: PersistedState = { version: 1, accounts: {} };
  pool.exportState(exported);
  assert.equal(exported.accounts['claude:c1']!.resetCredits, 2, 'the count is persisted for the dashboard');
});

test('a usage response without ticket data leaves the stored count unknown', async (t) => {
  const fake = await usageServer(() => ({ limits }));
  t.after(fake.close);

  const pool = poolFor(fake.url);
  const account = pool.accounts[0]!;
  assert.equal(await pool.refreshUsageAccount(account), true);
  assert.equal(account.resetCredits, null);
  assert.equal(account.resetCreditsAt, null);
});

function fakeClock(start: number) {
  type FakeTimer = { at: number; fn: () => void; unref(): void };
  let now = start;
  const timers = new Set<FakeTimer>();
  const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const timer: FakeTimer = { at: now + Math.max(0, ms), fn, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: (timer: { at?: number; fn?: () => void; unref?: () => void }) => { timers.delete(timer as FakeTimer); },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at; timers.delete(due); due.fn(); await settle();
      }
      now = target; await settle();
    },
  };
}

test('a Claude account with no recorded ticket reading is due for the periodic refresh', async () => {
  const start = 1_700_000_000_000;
  const clock = fakeClock(start);
  const reads: number[] = [];
  const provider: Provider = {
    ...claudeProvider,
    refresh: async (value) => value,
    fetchUsage: async () => {
      reads.push(clock.now() - start);
      return { routingUsage: 0.2, routingResetsAt: null, windows: { '5h': { usage: 0.2, resetsAt: null } }, resetCredits: 2 };
    },
  };
  // Fresh measurement, as a busy account gets from response headers, but the
  // ticket count has never been read.
  const state: PersistedState = { version: 1, accounts: { 'claude:c1': { usage: 0.2, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, measuredAt: start, windows: { '5h': { usage: 0.2, resetsAt: null } } } } };
  const pool = new AccountPool(provider, [stored], { 'claude:c1': credential }, state);
  const refresher = new UsageRefresher([pool], { intervalMs: 300_000, jitterMaxMs: 0, nowFn: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });

  refresher.start();
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(reads, [0], 'the missing count makes the account due immediately');
  assert.equal(pool.accounts[0]!.resetCreditsAt, start, 'the read records when the count was learned');

  await clock.advance(300_000);
  assert.equal(reads.length, 2, 'the normal cadence continues afterwards');
  refresher.stop();
});

const frameConfig: TeamAIConfig = {
  version: 1,
  proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'tok' },
  switchThreshold: 0.98,
  maxConcurrentPerAccount: 3,
  accounts: [stored],
};

function claudeFrame(resetCredits: number): string[] {
  const state: PersistedState = {
    version: 1,
    accounts: {
      'claude:c1': {
        usage: 0.2, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, resetCredits,
        windows: { '5h': { usage: 0.2, resetsAt: null }, '7d': { usage: 0.1, resetsAt: null } },
      },
    },
  };
  return buildFrame(frameConfig, state, { width: 140, selectedId: 'claude:c1', mode: 'normal', message: '', sortByHeadroom: false }).map(stripAnsi);
}

test('the dashboard draws RC2 on a Claude row and hides a zero count like Codex', () => {
  const withTickets = claudeFrame(2);
  assert.ok(withTickets.some((line) => line.includes('c1@example.com') && line.includes('RC2')));
  const withoutTickets = claudeFrame(0);
  assert.ok(!withoutTickets.some((line) => line.includes('RC0')));
  assert.ok(withoutTickets.some((line) => line.includes('c1@example.com')));
});
