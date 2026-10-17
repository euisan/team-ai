import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { buildFrame, displayOrder, orderOptions } from '../src/frame.js';
import { comparePacing, pacingDeviation, WEEK_MS } from '../src/pacing.js';
import type { OAuthCredential, PersistedState, Provider, QuotaWindow, StoredAccount, TeamAIConfig } from '../src/types.js';

const DAY = 86_400_000; const HOUR = 3_600_000;
// The pool's clock, fixed two days ahead of the real one: ranking must read
// the injected clock, while the windows stay in the real future so the
// availability checks (which use the wall clock) leave every account in.
const T = Date.now() + 2 * DAY;

function makePool(provider: 'claude' | 'codex', ids: string[]): AccountPool {
  const p: Provider = { id: provider, label: provider === 'claude' ? 'Claude' : 'Codex', upstreamBase: 'http://127.0.0.1:1', normalizePath: () => '/x', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c, buildHeaders: (h) => h, classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), ...(provider === 'claude' ? { fableModel: 'claude-fable-5-1' } : {}) };
  const stored = ids.map((id): StoredAccount => ({ id, provider, label: id, enabled: true, priority: null, credentialId: `cred-${id}`, createdAt: '' }));
  const credentials: Record<string, OAuthCredential> = Object.fromEntries(ids.map((id) => [`cred-${id}`, { accessToken: 's', refreshToken: null, expiresAt: null, accountId: id }]));
  const pool = new AccountPool(p, stored, credentials, { version: 1, accounts: {} }, 0.98, 16, 0.8);
  pool.now = () => T;
  return pool;
}

function set(pool: AccountPool, id: string, windows: Record<string, QuotaWindow>): void {
  const account = pool.accounts.find((a) => a.id === id)!;
  account.windows = windows;
  // The routing figure is the fuller of the shared windows, as readQuota sets it.
  account.usage = Math.max(0, ...Object.entries(windows).filter(([name]) => !/^7d_/.test(name)).map(([, w]) => w.usage ?? 0));
}

test("owner's example: 50% with a day left beats 40% with six days left under pacing, not under level", () => {
  for (const balance of ['pacing', 'level'] as const) {
    const pool = makePool('claude', ['A', 'B']); pool.balance = balance;
    set(pool, 'A', { '7d': { usage: 0.5, resetsAt: T + 1 * DAY } });
    set(pool, 'B', { '7d': { usage: 0.4, resetsAt: T + 6 * DAY } });
    assert.equal(pool.acquire(`s-${balance}`, new Set(), false)?.id, balance === 'pacing' ? 'A' : 'B', balance);
    assert.equal(pool.preview(false)?.id, balance === 'pacing' ? 'A' : 'B', `${balance} preview`);
  }
  // A is 36%p behind its line (6/7 of the week gone, half used), B 26%p ahead.
  assert.equal(Math.round(pacingDeviation({ '7d': { usage: 0.5, resetsAt: T + DAY } }, false, T)! * 100), -36);
  assert.equal(Math.round(pacingDeviation({ '7d': { usage: 0.4, resetsAt: T + 6 * DAY } }, false, T)! * 100), 26);
});

test('the same example on Codex, whose weekly window is told by its 10080-minute length', () => {
  const pool = makePool('codex', ['A', 'B']);
  set(pool, 'A', { primary: { usage: 0.1, resetsAt: T + 2 * HOUR, minutes: 300 }, secondary: { usage: 0.5, resetsAt: T + DAY, minutes: 10080 } });
  set(pool, 'B', { primary: { usage: 0.1, resetsAt: T + 2 * HOUR, minutes: 300 }, secondary: { usage: 0.4, resetsAt: T + 6 * DAY, minutes: 10080 } });
  assert.equal(pool.acquire('s', new Set(), false)?.id, 'A');
});

test('the Codex weekly window ranks at all (it used to be ignored for primary)', () => {
  // Same 5-hour window state but A has burned 90% of its week. Before the fix
  // generalWindow() read `primary` (the 5-hour window) and never the weekly
  // one, so A — lighter on the 5-hour figure — was picked in both modes.
  for (const balance of ['pacing', 'level'] as const) {
    const pool = makePool('codex', ['A', 'B']); pool.balance = balance;
    set(pool, 'A', { primary: { usage: 0.1, resetsAt: T + 2 * HOUR, minutes: 300 }, secondary: { usage: 0.9, resetsAt: T + 3 * DAY, minutes: 10080 } });
    set(pool, 'B', { primary: { usage: 0.3, resetsAt: T + 2 * HOUR, minutes: 300 }, secondary: { usage: 0.2, resetsAt: T + 3 * DAY, minutes: 10080 } });
    assert.equal(pool.acquire(`s-${balance}`, new Set(), false)?.id, 'B', balance);
  }
  assert.equal(AccountPool.generalWindow({ windows: { primary: { usage: 0.1, resetsAt: null, minutes: 300 }, secondary: { usage: 0.9, resetsAt: null, minutes: 10080 } } })?.usage, 0.9);
});

test('deviations within 0.05 tie, and the tie goes to the higher headroom rate', () => {
  // A is 4%p behind with 90% of the week left (rate 1.04/week); B 2%p behind
  // with 20% left (rate 1.10). The 2%p gap is inside the band, so B's rate wins.
  const pool = makePool('claude', ['A', 'B']);
  set(pool, 'A', { '7d': { usage: 0.06, resetsAt: T + 0.9 * WEEK_MS } });
  set(pool, 'B', { '7d': { usage: 0.78, resetsAt: T + 0.2 * WEEK_MS } });
  assert.equal(pool.preview(false)?.id, 'B');
  // Push B to 2%p ahead: a 6%p gap is outside the band and deviation decides.
  set(pool, 'B', { '7d': { usage: 0.82, resetsAt: T + 0.2 * WEEK_MS } });
  assert.equal(pool.preview(false)?.id, 'A');
});

test('inside the band the session pin comes first, then reset times, then the 5-hour window', () => {
  const a = { id: 'a', windows: { '7d': { usage: 0.5, resetsAt: T + 3.5 * DAY } } };
  const b = { id: 'b', windows: { '7d': { usage: 0.5, resetsAt: T + 3.5 * DAY } } };
  assert.ok(comparePacing(a, b, false, T, 'b') > 0, 'the pinned account wins a tie');
  assert.ok(comparePacing(a, b, false, T, 'a') < 0);
  // Equal week: the earlier, then emptier, 5-hour window.
  const early = { windows: { ...a.windows, '5h': { usage: 0.5, resetsAt: T + HOUR } } };
  const late = { windows: { ...a.windows, '5h': { usage: 0.1, resetsAt: T + 3 * HOUR } } };
  assert.ok(comparePacing(early, late, false, T) < 0);
  const light = { windows: { ...a.windows, '5h': { usage: 0.1, resetsAt: T + HOUR } } };
  assert.ok(comparePacing(light, early, false, T) < 0);
  // But the pin never overrides a deviation outside the band.
  const behind = { id: 'c', windows: { '7d': { usage: 0.1, resetsAt: T + 3.5 * DAY } } };
  assert.ok(comparePacing(behind, a, false, T, 'a') < 0);
});

test('an account with no valid weekly window sorts after one that has it, even far ahead', () => {
  const pool = makePool('claude', ['none', 'stale', 'ahead']);
  set(pool, 'none', { '5h': { usage: 0, resetsAt: T + HOUR } });
  // A weekly window whose reset has passed (by the injected clock) is not valid.
  set(pool, 'stale', { '7d': { usage: 0, resetsAt: T - HOUR }, '5h': { usage: 0, resetsAt: T + 2 * HOUR } });
  set(pool, 'ahead', { '7d': { usage: 0.9, resetsAt: T + 6 * DAY } });
  assert.equal(pool.preview(false)?.id, 'ahead');
  // Among themselves the 5-hour keys decide: the earlier reset first.
  const order = displayOrder(pool.accounts, { version: 1, accounts: Object.fromEntries(pool.accounts.map((a) => [a.credentialId, { usage: a.usage, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: a.windows }])) }, true, { balance: 'pacing', fableReserve: 0.8, now: T });
  assert.deepEqual(order.map((a) => a.id), ['ahead', 'none', 'stale']);
});

test('a Fable request paces on the Fable weekly window, anything else on 7d', () => {
  const pool = makePool('claude', ['A', 'B']);
  // A: overall 20%p ahead, Fable 40%p behind. B: the other way round.
  set(pool, 'A', { '7d': { usage: 0.7, resetsAt: T + 3.5 * DAY }, '7d_oi': { usage: 0.1, resetsAt: T + 3.5 * DAY } });
  set(pool, 'B', { '7d': { usage: 0.2, resetsAt: T + 3.5 * DAY }, '7d_oi': { usage: 0.7, resetsAt: T + 3.5 * DAY } });
  assert.equal(pool.acquire('fable', new Set(), true)?.id, 'A');
  assert.equal(pool.acquire('opus', new Set(), false)?.id, 'B');
});

test('the Fable reservation tier and an explicit priority still come before pacing', () => {
  const pool = makePool('claude', ['behind', 'spentFable', 'ranked']);
  set(pool, 'behind', { '7d': { usage: 0.05, resetsAt: T + DAY }, '7d_oi': { usage: 0.1, resetsAt: T + DAY } });
  set(pool, 'spentFable', { '7d': { usage: 0.6, resetsAt: T + 6 * DAY }, '7d_oi': { usage: 0.9, resetsAt: T + 6 * DAY } });
  set(pool, 'ranked', { '7d': { usage: 0.5, resetsAt: T + 6 * DAY }, '7d_oi': { usage: 0.5, resetsAt: T + 6 * DAY } });
  assert.equal(pool.preview(false)?.id, 'spentFable', 'non-Fable goes to the spent-Fable tier first');
  assert.equal(pool.preview(true)?.id, 'behind');
  pool.accounts.find((a) => a.id === 'ranked')!.priority = 1;
  assert.equal(pool.preview(true)?.id, 'ranked', 'priority outranks pacing');
});

test('an account behind on the week is skipped while its 5-hour window is at the switch threshold', () => {
  const pool = makePool('claude', ['behind', 'ahead']);
  set(pool, 'behind', { '7d': { usage: 0.1, resetsAt: T + DAY }, '5h': { usage: 0.98, resetsAt: T + HOUR } });
  set(pool, 'ahead', { '7d': { usage: 0.6, resetsAt: T + 6 * DAY }, '5h': { usage: 0.2, resetsAt: T + HOUR } });
  assert.equal(pool.acquire('s', new Set(), false)?.id, 'ahead');
  set(pool, 'behind', { '7d': { usage: 0.1, resetsAt: T + DAY }, '5h': { usage: 0.5, resetsAt: T + HOUR } });
  assert.equal(pool.acquire('t', new Set(), false)?.id, 'behind');
});

test('the dashboard orders accounts with the same comparison, and shows each deviation', () => {
  const now = Date.now();
  const stored = ['level@example.com', 'paced@example.com'].map((label): StoredAccount => ({ id: label, provider: 'claude', label, enabled: true, priority: null, credentialId: `cred-${label}`, createdAt: '' }));
  const windows = { 'level@example.com': { '7d': { usage: 0.4, resetsAt: now + 6 * DAY } }, 'paced@example.com': { '7d': { usage: 0.5, resetsAt: now + DAY } } };
  const state: PersistedState = { version: 1, accounts: Object.fromEntries(stored.map((a) => [a.credentialId, { usage: windows[a.label as keyof typeof windows]['7d'].usage, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: windows[a.label as keyof typeof windows] }])) };
  const config = { version: 1, proxy: { host: '127.0.0.1', claudePort: 1, codexPort: 2, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 16, accounts: stored } as TeamAIConfig;
  assert.deepEqual(displayOrder(stored, state, true, orderOptions(config)).map((a) => a.label), ['paced@example.com', 'level@example.com']);
  assert.deepEqual(displayOrder(stored, state, true, orderOptions({ ...config, routing: { balance: 'level' } })).map((a) => a.label), ['level@example.com', 'paced@example.com']);
  const text = buildFrame(config, state, { width: 160, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).join('\n');
  assert.match(text, /-36%p/); assert.match(text, /\+26%p/);
  assert.ok(text.indexOf('paced@example.com') < text.indexOf('level@example.com'));
});
