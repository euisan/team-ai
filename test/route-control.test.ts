import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { createProxy } from '../src/proxy.js';
import { handleRouteControl } from '../src/route-control.js';
import { parseRoutes } from '../src/routes.js';
import type { OAuthCredential, Provider, StoredAccount } from '../src/types.js';

// Each test gets its own TEAMAI_HOME; nothing reads the real config.
async function home(routes: unknown): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'teamai-route-control-')); process.env.TEAMAI_HOME = root;
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, proxy: { host: '127.0.0.1', claudePort: 1, codexPort: 2, clientToken: 'tok' }, switchThreshold: 0.98, maxConcurrentPerAccount: 16, accounts: [], routes }));
}

function pool(ids: string[], provider: Partial<Provider> = {}) {
  const full: Provider = { id: 'codex', label: 'Codex', upstreamBase: 'http://127.0.0.1:1', normalizePath: () => '/x', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c, buildHeaders: (h) => h, classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), ...provider };
  const stored = ids.map((id): StoredAccount => ({ id, provider: 'codex', label: `${id}@example.com`, enabled: true, priority: null, credentialId: `cred-${id}`, createdAt: '' }));
  const credentials: Record<string, OAuthCredential> = Object.fromEntries(ids.map((id) => [`cred-${id}`, { accessToken: `secret-${id}`, refreshToken: null, expiresAt: null, accountId: id }]));
  const p = new AccountPool(full, stored, credentials, { version: 1, accounts: {} }, 0.98, 16, 0.8); p.log = () => {};
  return { p, get: (id: string) => p.accounts.find((a) => a.id === id)! };
}

async function control(pools: AccountPool[], logged: string[] = []): Promise<{ server: Server; call: (init?: RequestInit) => Promise<Response> }> {
  const server = createServer(async (req, res) => { if (!(await handleRouteControl(req, res, pools, 'tok', (warnings) => logged.push(...warnings)))) res.writeHead(404).end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert(address && typeof address !== 'string');
  return { server, call: (init = {}) => fetch(`http://127.0.0.1:${address.port}/routes/reload`, { method: 'POST', headers: { authorization: 'Bearer tok' }, ...init }) };
}

const take = (p: AccountPool, model: string, session = 's') => { const a = p.acquire(session, new Set(), false, p.routeFor(model)); if (a) p.release(a); return a?.id ?? null; };

test('reload swaps in the routes from config.json, and the next request is routed by them', async () => {
  const { p, get } = pool(['a', 'b']); get('a').usage = 0.1; get('b').usage = 0.6;
  await home({ codex: [] });
  const logged: string[] = []; const { server, call } = await control([p], logged);
  try {
    assert.equal(take(p, 'gpt-6-luna'), 'a', 'no route yet: the emptier account');
    await writeFile(join(process.env.TEAMAI_HOME!, 'config.json'), JSON.stringify({ version: 1, proxy: { host: '127.0.0.1', claudePort: 1, codexPort: 2, clientToken: 'tok' }, accounts: [], routes: { codex: [{ name: 'luna', match: ['gpt-6-luna*'], accounts: ['b@example.com', 'ghost@example.com'], mode: 'exclusive' }] } }));
    const res = await call(); assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { routes: { codex: 1 }, warnings: ['Codex route luna: account ghost@example.com not found — skipped'] });
    assert.deepEqual(logged, ['Codex route luna: account ghost@example.com not found — skipped']);
    assert.equal(p.routeFor('gpt-6-luna-mini')?.name, 'luna');
    assert.equal(take(p, 'gpt-6-luna', 's2'), 'b', 'the new exclusive route wins over the emptier a');
    assert.equal(take(p, 'gpt-6-astra', 's3'), 'a', 'an unmatched model is unaffected');
  } finally { server.close(); delete process.env.TEAMAI_HOME; }
});

test('a malformed file is refused and the running routes stay as they were', async () => {
  const { p } = pool(['a']); p.setRoutes(parseRoutes([{ name: 'keep', match: ['*'], accounts: ['a'] }], 'codex'));
  await home({ codex: [{ name: 'x', match: [], accounts: ['a'] }] });
  const { server, call } = await control([p]);
  try {
    const res = await call(); assert.equal(res.status, 400); assert.match((await res.json() as { error: string }).error, /route x: match/);
    assert.deepEqual(p.routeList.map((r) => r.name), ['keep']);
  } finally { server.close(); delete process.env.TEAMAI_HOME; }
});

test('the reload needs the client token and a POST', async () => {
  const { p } = pool(['a']); await home({});
  const { server, call } = await control([p]);
  try {
    assert.equal((await call({ headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await call({ method: 'GET' })).status, 405);
  } finally { server.close(); delete process.env.TEAMAI_HOME; }
});

test('a request in flight during a reload finishes on the account its route chose', async () => {
  let release: () => void = () => {}; const gate = new Promise<void>((r) => { release = r; });
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    seen.push(String(req.headers['chatgpt-account-id'])); req.resume();
    res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first ');
    void gate.then(() => res.end('second'));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const { p, get } = pool(['a', 'b'], { upstreamBase: `http://127.0.0.1:${up.port}`, buildHeaders: (h, account) => { const out = new Headers(h); out.set('chatgpt-account-id', account.credential.accountId); return out; } });
  get('a').usage = 0.1; get('b').usage = 0.6;
  p.setRoutes(parseRoutes([{ name: 'old', match: ['gpt-6*'], accounts: ['b'], mode: 'exclusive' }], 'codex'));
  await home({ codex: [{ name: 'new', match: ['gpt-6*'], accounts: ['a'], mode: 'exclusive' }] });
  const proxy = createProxy(p, 'tok', () => {}); await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  const { server, call } = await control([p]);
  try {
    const pending = await fetch(`http://127.0.0.1:${pa.port}/x`, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ model: 'gpt-6-astra' }) });
    assert.equal(pending.status, 200);
    assert.equal((await call()).status, 200, 'reloaded while the first response is still streaming');
    release();
    assert.equal(await pending.text(), 'first second', 'the in-flight response was not cut');
    const next = await fetch(`http://127.0.0.1:${pa.port}/x`, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ model: 'gpt-6-astra' }) });
    assert.equal(await next.text(), 'first second');
    assert.deepEqual(seen, ['b', 'a'], 'old route for the in-flight request, new route for the next');
  } finally { proxy.close(); upstream.close(); server.close(); delete process.env.TEAMAI_HOME; }
});
