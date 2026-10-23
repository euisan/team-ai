import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { buildFrame, displayOrder, orderOptions, type OrderOptions } from '../src/frame.js';
import { parseBalance } from '../src/pacing.js';
import { providers } from '../src/providers.js';

const LEVEL: OrderOptions = { balance: 'level' };
import type { PersistedState, StoredAccount, TeamAIConfig } from '../src/types.js';

function account(provider: 'claude' | 'codex', label: string, priority: number | null = null): StoredAccount {
  return { id: label, provider, label, enabled: true, priority, credentialId: `cred-${label}`, createdAt: '2026-01-01T00:00:00Z' };
}

function usage(entries: Record<string, number | null>): PersistedState {
  const accounts: PersistedState['accounts'] = {};
  for (const [label, value] of Object.entries(entries)) accounts[`cred-${label}`] = { usage: value, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: value === null ? {} : { '7d_oi': { usage: value, resetsAt: null } } };
  return { version: 1, accounts };
}

test('display order groups providers even when config interleaves them', () => {
  const config = [account('codex', 'x1@example.com'), account('claude', 'c1@example.com'), account('codex', 'x2@example.com'), account('claude', 'c2@example.com')];
  const ordered = displayOrder(config, usage({}), false);
  assert.deepEqual(ordered.map((a) => a.label), ['c1@example.com', 'c2@example.com', 'x1@example.com', 'x2@example.com']);
});

test('display order (level): pinned priority first, then least-spent, unmeasured last', () => {
  // As the pool ranks a non-Fable request: a priority first, whatever Fable
  // budget is left, then the balance; a spent Fable window is no tier.
  const config = [account('claude', 'spent@example.com'), account('claude', 'unknown@example.com'), account('claude', 'fresh@example.com'), account('claude', 'pinned@example.com', 1)];
  const state = usage({ 'spent@example.com': 1, 'unknown@example.com': null, 'fresh@example.com': 0.2, 'pinned@example.com': 0.9 });
  const ordered = displayOrder(config, state, true, LEVEL);
  assert.deepEqual(ordered.map((a) => a.label), ['pinned@example.com', 'fresh@example.com', 'spent@example.com', 'unknown@example.com']);
});

// The regression: ↑↓ used to step through config.json while the screen drew a
// sorted list, so the cursor hopped between non-adjacent rows. Stepping through
// displayOrder by index must visit rows in exactly the order they are drawn.
test('stepping by index through display order visits adjacent drawn rows', () => {
  const config = [account('claude', 'b@example.com'), account('codex', 'z@example.com'), account('claude', 'a@example.com')];
  // No priorities, so the order is by usage alone.
  const state = usage({ 'b@example.com': 0.7, 'a@example.com': 0.1, 'z@example.com': 0.5 });
  const ordered = displayOrder(config, state, true, LEVEL);
  const walk: string[] = []; let index = 0;
  while (index < ordered.length) { walk.push(ordered[index]!.label); index++; }
  assert.deepEqual(walk, ['a@example.com', 'b@example.com', 'z@example.com']);
  assert.notDeepEqual(walk, config.map((a) => a.label));
});

test('display order leaves the input array untouched', () => {
  const config = [account('claude', 'b@example.com'), account('claude', 'a@example.com')];
  const before = config.map((a) => a.label);
  displayOrder(config, usage({ 'b@example.com': 0.9, 'a@example.com': 0.1 }), true);
  assert.deepEqual(config.map((a) => a.label), before);
});

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (line: string): string => line.replace(ANSI, '');

test('buildFrame draws both sections, the column titles and the footer within the width', () => {
  const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'tai-secret' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [account('claude', 'c@example.com'), account('codex', 'x@example.com')] };
  const state = usage({ 'c@example.com': 0.3, 'x@example.com': 0.9 });
  const lines = buildFrame(config, state, { width: 120, selectedId: 'cred-c@example.com', mode: 'normal', message: 'hello', sortByHeadroom: true }).map(plain);
  assert.ok(lines.every((line) => [...line].length <= 120), 'no line wider than the frame');
  assert.ok(lines.some((line) => line.includes('Claude accounts (1)')));
  assert.ok(lines.some((line) => line.includes('Codex accounts (1)')));
  assert.ok(lines.some((line) => line.includes('5h session') && line.includes(' 7d ') && line.includes('7d Fable')));
  assert.ok(lines.some((line) => line.startsWith('>  c@example.com')), 'cursor on the selected row (then the next-account column)');
  const footer = lines.at(-1)!;
  assert.match(footer, /p capture/); assert.match(footer, /c quota-sort/); assert.match(footer, /hello$/);
  assert.equal(lines.join('\n').includes('tai-secret'), false);
});

test('a recovered account is shown as active instead of cooldown', () => {
  const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [account('codex', 'recovered@example.com')] };
  const state = usage({ 'recovered@example.com': 0.2 });
  state.accounts['cred-recovered@example.com']!.cooldownUntil = null;
  state.accounts['cred-recovered@example.com']!.cooldownReason = null;
  const lines = buildFrame(config, state, { width: 100, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).map(plain).join('\n');
  assert.match(lines, /recovered@example\.com/);
  assert.doesNotMatch(lines, /cooldown/);
  assert.match(lines, /active/);
});

test('buildFrame pads to the terminal height when given one and not otherwise', () => {
  const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [account('claude', 'c@example.com')] };
  const view = { width: 100, selectedId: null, mode: 'normal' as const, message: '', sortByHeadroom: true };
  assert.equal(buildFrame(config, usage({}), { ...view, height: 40 }).length, 40);
  assert.ok(buildFrame(config, usage({}), view).length < 40);
});

// The real selection order, read off the pool itself: acquire a new session's
// non-Fable request, set that account aside, and ask again.
function selectionOrder(pool: AccountPool): string[] {
  const order: string[] = []; const excluded = new Set<string>();
  for (let i = 0; i < pool.accounts.length; i++) {
    const picked = pool.acquire(`session-${i}`, excluded, false); if (!picked) break;
    pool.release(picked); excluded.add(picked.id); order.push(picked.label);
  }
  return order;
}

test('with routing.balance "level" the dashboard order is the pool\'s own selection order', () => {
  // Fable (7d_oi), general weekly (7d) and session (5h) windows that rank
  // differently: by the Fable window, as the dashboard used to, the order would
  // be A, C, B; the pool levels on the fuller of 7d and 5h in 10% steps.
  const windows: Record<string, { fable: number; week: number; session: number }> = {
    'a@example.com': { fable: 0.1, week: 0.6, session: 0.1 },
    'b@example.com': { fable: 0.5, week: 0.2, session: 0.3 },
    'c@example.com': { fable: 0.3, week: 0.25, session: 0.7 },
    // Fable nearly spent: no longer a tier of its own, it ranks on 7d/5h.
    'd@example.com': { fable: 0.9, week: 0.7, session: 0 },
    // A pinned priority ranks first, whatever Fable budget it still holds.
    'e@example.com': { fable: 0.2, week: 0.9, session: 0.5 },
  };
  const stored = Object.keys(windows).map((label) => account('claude', label, label === 'e@example.com' ? 1 : null));
  const state: PersistedState = { version: 1, accounts: {} };
  for (const [label, w] of Object.entries(windows)) state.accounts[`cred-${label}`] = { usage: Math.max(w.week, w.session), resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { '7d_oi': { usage: w.fable, resetsAt: null }, '7d': { usage: w.week, resetsAt: null }, '5h': { usage: w.session, resetsAt: null } } };
  const credentials = Object.fromEntries(stored.map((a) => [a.credentialId, { accessToken: 'synthetic', refreshToken: null, expiresAt: null, accountId: a.id }]));
  const pool = new AccountPool(providers.claude, stored, credentials, state, 0.98, 16); pool.balance = 'level';
  const expected = selectionOrder(pool);
  assert.deepEqual(expected, ['e@example.com', 'b@example.com', 'a@example.com', 'c@example.com', 'd@example.com']);
  assert.deepEqual(displayOrder(stored, state, true, LEVEL).map((a) => a.label), expected);
});

test('with routing.balance "level" in-flight requests break a tie the way the pool does', () => {
  const stored = [account('claude', 'busy@example.com'), account('claude', 'idle@example.com')];
  const state: PersistedState = { version: 1, accounts: {}, active: [{ id: '1', provider: 'claude', providerLabel: 'Claude', method: 'POST', path: '/', account: 'busy@example.com', startedAt: 0 }] };
  for (const a of stored) state.accounts[a.credentialId] = { usage: 0.3, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { '5h': { usage: 0.31, resetsAt: null }, '7d': { usage: 0.32, resetsAt: null } } };
  assert.deepEqual(displayOrder(stored, state, true, LEVEL).map((a) => a.label), ['idle@example.com', 'busy@example.com']);
});

test('Codex dashboard order stays weekly-first when routing.balance is level', () => {
  const stored = [account('codex', 'weekly20@example.com'), account('codex', 'weekly24@example.com')];
  const now = Date.now();
  const state: PersistedState = { version: 1, accounts: {
    'cred-weekly20@example.com': { usage: 0.36, resetsAt: now + 3_600_000, cooldownUntil: null, lastUsed: null, error: null, windows: {
      primary: { usage: 0.36, resetsAt: now + 3_600_000, minutes: 300 },
      secondary: { usage: 0.20, resetsAt: now + 3 * 86_400_000, minutes: 10_080 },
    } },
    'cred-weekly24@example.com': { usage: 0.24, resetsAt: now + 3_600_000, cooldownUntil: null, lastUsed: null, error: null, windows: {
      primary: { usage: 0, resetsAt: now + 3_600_000, minutes: 300 },
      secondary: { usage: 0.24, resetsAt: now + 3 * 86_400_000, minutes: 10_080 },
    } },
  } };
  assert.deepEqual(displayOrder(stored, state, true, LEVEL).map((a) => a.label), ['weekly20@example.com', 'weekly24@example.com']);
});

test('routing.balance is read by one parser: the server refuses what the dashboard falls back from', () => {
  assert.equal(parseBalance(undefined), 'pacing');
  assert.equal(parseBalance('pacing'), 'pacing');
  assert.equal(parseBalance('level'), 'level');
  for (const bad of ['Level', 'fastest', '', 1, null]) assert.throws(() => parseBalance(bad), /routing\.balance must be "pacing" or "level", not /, String(bad));
  const base = {};
  assert.equal(orderOptions({ ...base, routing: { balance: 'level' } }).balance, 'level');
  assert.equal(orderOptions(base).balance, 'pacing');
  // The server will not start on it; the dashboard still draws, in the default order.
  assert.equal(orderOptions({ ...base, routing: { balance: 'fastest' as 'level' } }).balance, 'pacing');
});
