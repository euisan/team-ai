import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { displayOrder, orderOptions } from '../src/frame.js';
import { loadConfig } from '../src/storage.js';
import type { Balance } from '../src/pacing.js';
import type { OAuthCredential, PersistedState, Provider, QuotaWindow, StoredAccount } from '../src/types.js';

// Account choice follows the priority, not a Fable reservation. A Claude Max
// account reports a model-weekly (Fable) window, 7d_oi; a Pro account does not.
// Everything here is synthetic: no upstream is called.
const claude: Provider = {
  id: 'claude', label: 'Claude', upstreamBase: 'http://127.0.0.1:1', fableModel: 'claude-fable-5-1', normalizePath: (p) => p,
  buildHeaders: (h) => h, rewriteBody: (b) => b, readQuota: () => null, classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), refresh: async (c) => c,
};
const codex: Provider = {
  id: 'codex', label: 'Codex', upstreamBase: 'http://127.0.0.1:1', normalizePath: (p) => p,
  buildHeaders: (h) => h, rewriteBody: (b) => b, readQuota: () => null, classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), refresh: async (c) => c,
};
const DAY = 86_400_000;
const reset = Date.now() + 3 * DAY;
const max = (week: number, fable: number, session = 0.1): Record<string, QuotaWindow> => ({ '5h': { usage: session, resetsAt: Date.now() + 3_600_000 }, '7d': { usage: week, resetsAt: reset }, '7d_oi': { usage: fable, resetsAt: reset } });
const pro = (week: number, session = 0.05): Record<string, QuotaWindow> => ({ '5h': { usage: session, resetsAt: Date.now() + 3_600_000 }, '7d': { usage: week, resetsAt: reset } });

function fleet(accounts: Array<{ id: string; priority: number | null; windows: Record<string, QuotaWindow> }>, balance: Balance = 'pacing', providerType: 'claude' | 'codex' = 'claude') {
  const p = providerType === 'codex' ? codex : claude;
  const stored = accounts.map(({ id, priority }): StoredAccount => ({ id, provider: providerType, label: id, enabled: true, priority, credentialId: `cred-${id}`, createdAt: '' }));
  const credentials: Record<string, OAuthCredential> = Object.fromEntries(stored.map((a) => [a.credentialId, { accessToken: 'synthetic', refreshToken: null, expiresAt: null, accountId: a.id }]));
  const state: PersistedState = { version: 1, accounts: {} };
  for (const { id, windows } of accounts) {
    const usage = Math.max(...Object.entries(windows).filter(([name]) => !/^7d_/.test(name)).map(([, w]) => w.usage ?? 0));
    state.accounts[`cred-${id}`] = { usage, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows };
  }
  const pool = new AccountPool(p, stored, credentials, state, 0.98, 16); pool.balance = balance;
  return { pool, stored, state, get: (id: string) => pool.accounts.find((a) => a.id === id)! };
}
const take = (pool: AccountPool, wantsFable: boolean, session = `s-${Math.random()}`) => { const a = pool.acquire(session, new Set(), wantsFable); if (a) pool.release(a); return a?.id ?? null; };

// The owner's fleet: two Max accounts at priorities 0 and 2, one Pro at 4. The
// Pro is the emptiest, and has no Fable window to "reserve".
const owners = (balance: Balance = 'pacing') => fleet([
  { id: 'max0', priority: 0, windows: max(0.4, 0.1) },
  { id: 'max2', priority: 2, windows: max(0.3, 0.2) },
  { id: 'pro4', priority: 4, windows: pro(0.02) },
], balance);

for (const balance of ['pacing', 'level'] as const) {
  test(`(a) a non-Fable request goes to the priority-0 Max, not the priority-4 Pro (${balance})`, () => {
    const { pool } = owners(balance);
    assert.equal(take(pool, false), 'max0');
    // Two Max + Pro, the Max at 0 out of the way: the next priority, still not the Pro.
    const { pool: rest, get } = owners(balance); get('max0').enabled = false;
    assert.equal(take(rest, false), 'max2');
  });
}

test('(a) without priorities the balance decides, and the emptier Pro may win', () => {
  const { pool } = fleet([{ id: 'max', priority: null, windows: max(0.4, 0.1) }, { id: 'pro', priority: null, windows: pro(0.02) }], 'level');
  assert.equal(take(pool, false), 'pro');
});

test('(b) a Fable request never goes to a Pro account, which has no Fable window', () => {
  // The Pro ranked first on purpose: only availability can keep it out.
  const { pool, get } = fleet([{ id: 'pro', priority: 0, windows: pro(0.02) }, { id: 'max', priority: 4, windows: max(0.6, 0.5) }]);
  assert.equal(take(pool, true), 'max');
  assert.equal(pool.preview(true)?.id, 'max');
  get('max').enabled = false;
  assert.equal(take(pool, true), null, 'only the Pro is left: nothing, rather than a certain 429');
  assert.match(pool.explainShortfall(new Set(), true).message, /1 without a Fable budget/);
  assert.equal(take(pool, false), 'pro', 'the Pro still serves every other model');
});

test('(b) an account not measured yet is not judged to lack Fable', () => {
  const { pool } = fleet([{ id: 'fresh', priority: 0, windows: {} }]);
  assert.equal(take(pool, true), 'fresh');
});

test('(c) a Max with its Fable budget spent leaves Fable requests, keeps the rest', () => {
  const { pool } = fleet([{ id: 'spent', priority: 0, windows: max(0.5, 1) }, { id: 'left', priority: 2, windows: max(0.2, 0.3) }]);
  assert.equal(take(pool, true), 'left');
  assert.equal(take(pool, false), 'spent', 'priority still decides for non-Fable');
});

test('(d) a session pin is not moved off an account for holding Fable budget', () => {
  const { pool, get } = fleet([{ id: 'home', priority: null, windows: max(0.5, 0.1) }, { id: 'other', priority: null, windows: max(0.5, 0.1) }]);
  const first = pool.acquire('sess', new Set(), false)!; pool.release(first);
  const away = first.id === 'home' ? get('other') : get('home');
  // The other account now looks better on everything, and its Fable is spent —
  // what the removed reservation would have diverted every Opus turn to.
  away.windows = max(0.05, 1, 0); away.usage = 0.05;
  assert.equal(take(pool, false, 'sess'), first.id);
  // The Fable side of the same session pins apart, and stays where Fable is left.
  assert.equal(take(pool, true, 'sess'), first.id);
});

test('(e) an old config.json that still carries fableReserveThreshold loads and routes by priority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-priority-')); const previous = process.env.TEAMAI_HOME; process.env.TEAMAI_HOME = root;
  try {
    const { stored, state } = owners();
    await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'tai-test' }, switchThreshold: 0.98, maxConcurrentPerAccount: 16, fableReserveThreshold: 0.8, routing: { balance: 'level' }, accounts: stored }));
    const config = await loadConfig();
    const credentials: Record<string, OAuthCredential> = Object.fromEntries(config.accounts.map((a) => [a.credentialId, { accessToken: 'synthetic', refreshToken: null, expiresAt: null, accountId: a.id }]));
    // The arguments the server passes (src/runtime.ts).
    const pool = new AccountPool(claude, config.accounts, credentials, state, config.switchThreshold, config.maxConcurrentPerAccount);
    assert.equal(pool.maxSessions, 4096, 'the leftover key does not shift into another setting');
    assert.equal(take(pool, false), 'max0');
    assert.deepEqual(orderOptions(config), { balance: 'level' });
    assert.equal(displayOrder(config.accounts, state, true, orderOptions(config))[0]?.id, 'max0');
  } finally {
    if (previous === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// The real selection order: a new session's non-Fable request, that account set
// aside, and again.
function selectionOrder(pool: AccountPool): string[] {
  const order: string[] = []; const excluded = new Set<string>();
  for (let i = 0; i < pool.accounts.length; i++) {
    const picked = pool.acquire(`order-${i}`, excluded, false); if (!picked) break;
    pool.release(picked); excluded.add(picked.id); order.push(picked.id);
  }
  return order;
}

for (const balance of ['pacing', 'level'] as const) {
  test(`(f) the dashboard order and its arrow are the real selection order (${balance})`, () => {
    const { pool, stored, state } = fleet([
      { id: 'pro4', priority: 4, windows: pro(0.02) },
      { id: 'max2', priority: 2, windows: max(0.3, 0.95) },
      { id: 'free-a', priority: null, windows: max(0.6, 0.1) },
      { id: 'max0', priority: 0, windows: max(0.4, 0.1) },
      { id: 'free-b', priority: null, windows: max(0.1, 1) },
    ], balance);
    const expected = selectionOrder(pool);
    assert.deepEqual(expected.slice(0, 3), ['max0', 'max2', 'pro4'], 'explicit priorities first, smallest first');
    assert.deepEqual(displayOrder(stored, state, true, { balance }).map((a) => a.id), expected);
    assert.equal(pool.nextTargets().general, `cred-${expected[0]}`, 'the arrow points where acquire goes');
    assert.equal(pool.preview(false)?.id, take(pool, false));
  });
}

test('(a) equal priority accounts are balanced by pacing: less progressed account is picked first for preview and acquire', () => {
  const now = Date.now();
  const reset = now + 3 * DAY;
  const { pool } = fleet([
    { id: 'ahead', priority: 1, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.70, resetsAt: reset } } },
    { id: 'behind', priority: 1, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.35, resetsAt: reset } } },
  ], 'pacing');
  pool.now = () => now;
  assert.equal(pool.preview(false)?.id, 'behind');
  assert.equal(take(pool, false), 'behind');
});

test('(b) equal priority accounts are balanced by level: account with lower load is picked first for preview and acquire', () => {
  const now = Date.now();
  const reset = now + 3 * DAY;
  const { pool } = fleet([
    { id: 'fuller', priority: 1, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.70, resetsAt: reset } } },
    { id: 'emptier', priority: 1, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.35, resetsAt: reset } } },
  ], 'level');
  pool.now = () => now;
  assert.equal(pool.preview(false)?.id, 'emptier');
  assert.equal(take(pool, false), 'emptier');
});

test('(c) different priorities strictly favor the higher priority account regardless of balance', () => {
  const now = Date.now();
  const reset = now + 3 * DAY;
  for (const balance of ['pacing', 'level'] as const) {
    const { pool } = fleet([
      { id: 'high-priority-full', priority: 1, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.70, resetsAt: reset } } },
      { id: 'low-priority-empty', priority: 2, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.35, resetsAt: reset } } },
    ], balance);
    pool.now = () => now;
    assert.equal(pool.preview(false)?.id, 'high-priority-full', `${balance} preview`);
    assert.equal(take(pool, false), 'high-priority-full', `${balance} acquire`);
  }
});

test('(d) dashboard display order balances accounts with equal priority under pacing and level, matching preview', () => {
  const now = Date.now();
  const reset = now + 3 * DAY;
  // Pacing with equal priority
  {
    const { stored, state } = fleet([
      { id: 'ahead', priority: 1, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.70, resetsAt: reset } } },
      { id: 'behind', priority: 1, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.35, resetsAt: reset } } },
    ], 'pacing');
    assert.deepEqual(displayOrder(stored, state, true, { balance: 'pacing', now }).map((a) => a.id), ['behind', 'ahead']);
  }
  // Level with equal priority
  {
    const { stored, state } = fleet([
      { id: 'fuller', priority: 1, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.70, resetsAt: reset } } },
      { id: 'emptier', priority: 1, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.35, resetsAt: reset } } },
    ], 'level');
    assert.deepEqual(displayOrder(stored, state, true, { balance: 'level', now }).map((a) => a.id), ['emptier', 'fuller']);
  }
  // Different priorities: priority wins in display order
  {
    const { stored, state } = fleet([
      { id: 'high-priority-full', priority: 1, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.70, resetsAt: reset } } },
      { id: 'low-priority-empty', priority: 2, windows: { '5h': { usage: 0.1, resetsAt: now + 3_600_000 }, '7d': { usage: 0.35, resetsAt: reset } } },
    ], 'pacing');
    assert.deepEqual(displayOrder(stored, state, true, { balance: 'pacing', now }).map((a) => a.id), ['high-priority-full', 'low-priority-empty']);
  }
});

test('Codex accounts with equal priority are ordered by pacing on their 10080-minute window', () => {
  const now = Date.now();
  const reset = now + 3 * DAY;
  const { pool, stored, state } = fleet([
    { id: 'hyphen', priority: 1, windows: { primary: { usage: 0.1, resetsAt: now + 3_600_000, minutes: 300 }, secondary: { usage: 0.40, resetsAt: reset, minutes: 10080 } } },
    { id: 'putt', priority: 1, windows: { primary: { usage: 0.1, resetsAt: now + 3_600_000, minutes: 300 }, secondary: { usage: 0.31, resetsAt: reset, minutes: 10080 } } },
  ], 'pacing', 'codex');
  pool.now = () => now;
  assert.equal(pool.preview(false)?.id, 'putt');
  assert.equal(take(pool, false), 'putt');
  assert.deepEqual(displayOrder(stored, state, true, { balance: 'pacing', now }).map((a) => a.id), ['putt', 'hyphen']);
});
