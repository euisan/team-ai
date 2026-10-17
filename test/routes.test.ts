import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { buildFrame } from '../src/frame.js';
import { createProxy } from '../src/proxy.js';
import { globToRegExp, matchRoute, parseRoutes } from '../src/routes.js';
import type { OAuthCredential, PersistedState, Provider, StoredAccount, TeamAIConfig } from '../src/types.js';

test('patterns: only * is special, case is ignored, the whole name must match', () => {
  assert.equal(globToRegExp('claude-opus-5.5').test('claude-opus-5.5'), true);
  assert.equal(globToRegExp('claude-opus-5.5').test('claude-opus-5x5'), false, '. is literal');
  assert.equal(globToRegExp('claude-opus-*').test('CLAUDE-OPUS-5'), true);
  assert.equal(globToRegExp('opus').test('claude-opus-5'), false, 'no partial match');
  assert.equal(globToRegExp('*fable*').test('claude-fable-5-1'), true);
  assert.equal(globToRegExp('gpt-*').test('gpt-'), true, '* matches the empty string');
  const routes = parseRoutes([{ name: 'first', match: '*opus*', accounts: ['a'] }, { name: 'second', match: ['claude-*'], accounts: ['b'] }], 'claude');
  assert.equal(matchRoute(routes, 'claude-opus-5')?.name, 'first', 'the first match wins');
  assert.equal(matchRoute(routes, 'claude-sonnet-5')?.name, 'second');
  assert.equal(matchRoute(routes, null), null); assert.equal(matchRoute(routes, 'gpt-6'), null);
  assert.equal(routes[0]!.mode, 'prefer', 'prefer is the default');
});

test('a malformed route is refused with a message naming it', () => {
  const bad: Array<[unknown, RegExp]> = [
    [{ list: 1 }, /must be a list/],
    [[{ name: 'x', match: ['*'], accounts: ['a'], exclusive: true }], /unknown key "exclusive"/],
    [[{ name: 'x', match: ['*'], accounts: ['a'] }, { name: 'x', match: ['y'], accounts: ['b'] }], /duplicate route name "x"/],
    [[{ name: 'x', match: [], accounts: ['a'] }], /route x: match/],
    [[{ name: 'x', match: ['*'], accounts: [] }], /route x: accounts/],
    [[{ name: 'x', match: ['*'], accounts: ['a'], color: 'pink' }], /route x: color/],
    [[{ name: 'x', match: ['*'], accounts: ['a'], mode: 'strict' }], /route x: mode/],
    [[{ match: ['*'], accounts: ['a'] }], /name is required/],
  ];
  for (const [raw, message] of bad) assert.throws(() => parseRoutes(raw, 'codex'), message);
  assert.deepEqual(parseRoutes(undefined, 'codex'), []);
});

function pool(ids: string[], options: { provider?: Partial<Provider>; fableReserve?: number } = {}) {
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: 'http://127.0.0.1:1', normalizePath: () => '/x', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (h) => h, classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), ...options.provider,
  };
  const stored = ids.map((id): StoredAccount => ({ id, provider: provider.id, label: `${id}@example.com`, enabled: true, priority: null, credentialId: `cred-${id}`, createdAt: '' }));
  const credentials: Record<string, OAuthCredential> = Object.fromEntries(ids.map((id) => [`cred-${id}`, { accessToken: `secret-${id}`, refreshToken: null, expiresAt: null, accountId: id }]));
  const p = new AccountPool(provider, stored, credentials, { version: 1, accounts: {} }, 0.98, 16, options.fableReserve ?? 0.8);
  const log: string[] = []; p.log = (m) => log.push(m);
  return { p, log, get: (id: string) => p.accounts.find((a) => a.id === id)! };
}
const take = (p: AccountPool, route: ReturnType<typeof parseRoutes>[number] | null, session = 's', excluded = new Set<string>()) => { const a = p.acquire(session, excluded, false, route); if (a) p.release(a); return a?.id ?? null; };

test('exclusive keeps requests inside the route, failover included', () => {
  const { p, get } = pool(['a', 'b', 'c']);
  const [route] = parseRoutes([{ name: 'big', match: ['gpt-6*'], accounts: ['a@example.com', 1], mode: 'exclusive' }], 'codex');
  p.setRoutes([route!]);
  get('a').usage = 0.5; get('b').usage = 0.6; get('c').usage = 0.0;
  assert.equal(take(p, route!), 'a', 'c is emptier but outside the route');
  p.cooldown(get('a'), 60_000);
  assert.equal(take(p, route!, 's2'), 'b');
  assert.equal(take(p, route!, 's3', new Set(['b'])), null, 'b excluded by the request, a cooling: nothing, not c');
  p.cooldown(get('b'), 60_000);
  assert.equal(take(p, route!, 's4'), null);
  assert.match(p.explainShortfall(new Set(), false, route).message, /^No Codex account in route "big" can serve right now \(2 accounts: 2 cooling down/);
  assert.equal(take(p, null, 's5'), 'c', 'a request outside the route still reaches c');
});

test('prefer goes to the route first, leaves it at once when it cannot serve, and says so once each way', () => {
  const { p, get, log } = pool(['a', 'b']);
  const [route] = parseRoutes([{ name: 'fast', match: ['*'], accounts: ['b'] }], 'codex'); p.setRoutes([route!]);
  get('a').usage = 0.1; get('b').usage = 0.7;
  assert.equal(take(p, route!), 'b', 'the route account first even though a is emptier');
  p.cooldown(get('b'), 60_000);
  assert.equal(take(p, route!, 's2'), 'a'); assert.equal(take(p, route!, 's3'), 'a');
  get('b').cooldownUntil = null;
  assert.equal(take(p, route!, 's4'), 'b');
  assert.deepEqual(log, ['Codex route fast: no route account available → a@example.com', 'Codex route fast: back on b@example.com']);
});

test('a session pinned outside a prefer route moves into it; exclusive never uses the outside pin', () => {
  const { p, get } = pool(['a', 'b']);
  get('a').usage = 0.1; get('b').usage = 0.5;
  const [prefer] = parseRoutes([{ name: 'r', match: ['*'], accounts: ['b'] }], 'codex'); p.setRoutes([prefer!]);
  // The pin is made by a routed request that had to fall back.
  p.cooldown(get('b'), 60_000); assert.equal(take(p, prefer!, 'sess'), 'a');
  get('b').cooldownUntil = null; assert.equal(take(p, prefer!, 'sess'), 'b', 'back to the route account once it can serve');
  const [exclusive] = parseRoutes([{ name: 'e', match: ['*'], accounts: ['b'], mode: 'exclusive' }], 'codex'); p.setRoutes([exclusive!]);
  assert.equal(take(p, null, 'other'), 'a', 'unrouted session pinned on a');
  assert.equal(take(p, exclusive!, 'other'), 'b');
});

test('a route outranks the automatic Fable reservation', () => {
  const { p, get } = pool(['x', 'y'], { provider: { id: 'claude', label: 'Claude' } });
  get('x').windows = { '7d_oi': { usage: 0.2, resetsAt: null }, '7d': { usage: 0.3, resetsAt: null } };
  get('y').windows = { '7d_oi': { usage: 0.95, resetsAt: null }, '7d': { usage: 0.3, resetsAt: null } };
  assert.equal(take(p, null), 'y', 'without a route a non-Fable request leaves x to Fable');
  const [route] = parseRoutes([{ name: 'opus', match: ['claude-opus-*'], accounts: ['x'] }], 'claude'); p.setRoutes([route!]);
  assert.equal(take(p, route!, 'other'), 'x');
});

test('unknown account references are reported and skipped', () => {
  const { p } = pool(['a']);
  assert.deepEqual(p.setRoutes(parseRoutes([{ name: 'r', match: ['*'], accounts: ['a', 'ghost@example.com', 7] }], 'codex')), ['route r: account ghost@example.com not found — skipped', 'route r: account 7 not found — skipped']);
});

test('the relay routes by the requested model; exclusive does not fail over outside the route', async () => {
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    const account = String(req.headers['chatgpt-account-id']); seen.push(account); req.resume();
    req.once('end', () => { if (account === 'b') { res.writeHead(429); res.end('{"error":{"code":"usage_limit_reached"}}'); } else { res.writeHead(200); res.end('ok'); } });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const { p } = pool(['a', 'b'], { provider: { upstreamBase: `http://127.0.0.1:${up.port}`, buildHeaders: (h, account) => { const out = new Headers(h); out.set('chatgpt-account-id', account.credential.accountId); return out; }, classifyFailure: (status) => status === 429 ? { kind: 'quota', retryAfterMs: 60_000 } : { kind: 'fatal', retryAfterMs: 0 } } });
  p.setRoutes(parseRoutes([{ name: 'mini', match: ['*-mini'], accounts: ['b'], mode: 'exclusive' }, { name: 'big', match: ['gpt-6*'], accounts: ['a'] }], 'codex'));
  const proxy = createProxy(p, 'tok', () => {});
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  const call = (model: string) => fetch(`http://127.0.0.1:${pa.port}/x`, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ model }) });
  try {
    assert.equal((await call('gpt-6-astra')).status, 200); assert.deepEqual(seen, ['a']);
    const res = await call('gpt-6-mini'); assert.equal(res.status, 429, 'b is spent and a is outside the exclusive route'); await res.text();
    assert.deepEqual(seen, ['a', 'b']);
  } finally { proxy.close(); upstream.close(); }
});

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (line: string): string => line.replace(ANSI, '');

test('route markers: none without routes, a coloured column per route otherwise', () => {
  const accounts = ['a', 'b'].map((id): StoredAccount => ({ id, provider: 'codex', label: `${id}@example.com`, enabled: true, priority: null, credentialId: `cred-${id}`, createdAt: '' }));
  const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts };
  const view = { width: 100, selectedId: null, mode: 'normal' as const, message: '', sortByHeadroom: false };
  const state: PersistedState = { version: 1, accounts: {} };
  assert.deepEqual(buildFrame(config, { ...state, routes: [] }, view), buildFrame(config, state, view), 'no routes: identical frame');
  const { p, get } = pool(['a', 'b']); p.setRoutes(parseRoutes([{ name: 'r', match: ['*'], accounts: ['a', 'b'], color: 'magenta' }], 'codex'));
  p.cooldown(get('b'), 60_000);
  const exported: PersistedState = { version: 1, accounts: {} }; p.exportState(exported);
  assert.deepEqual(exported.routes, [{ provider: 'codex', name: 'r', color: 'magenta', mode: 'prefer', members: [{ credentialId: 'cred-a', usable: true }, { credentialId: 'cred-b', usable: false }] }]);
  const raw = buildFrame(config, exported, view);
  const rowA = raw.find((l) => plain(l).includes('a@example.com'))!; const rowB = raw.find((l) => plain(l).includes('b@example.com'))!;
  assert.ok(rowA.startsWith(`${String.fromCharCode(27)}[35m▸`), 'usable: the route colour');
  assert.ok(rowB.startsWith(`${String.fromCharCode(27)}[90m▸`), 'cannot serve now: grey');
  assert.ok(raw.map(plain).every((l) => [...l].length <= 100));
});

test('exporting the route summary changes nothing on the accounts', () => {
  const { p, get } = pool(['a']); p.setRoutes(parseRoutes([{ name: 'r', match: ['*'], accounts: ['a'] }], 'codex'));
  const a = get('a'); a.usage = 1; a.resetsAt = Date.now() - 1_000; a.cooldownUntil = Date.now() + 60_000; a.cooldownReason = 'quota';
  const out: PersistedState = { version: 1, accounts: {} }; p.exportState(out);
  assert.equal(out.routes![0]!.members[0]!.usable, true, 'the window rolled over, so it reads as usable');
  assert.equal(a.usage, 1); assert.notEqual(a.cooldownUntil, null, 'but nothing was cleared');
});
