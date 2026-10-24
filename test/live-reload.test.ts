import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { configReloadHandler } from '../src/config-reload.js';
import { providers } from '../src/providers.js';
import type { RunningServer } from '../src/runtime.js';
import { anyPorts, startOnAnyPorts } from './server-ports.js';
import { defaultConfig, loadConfig, removeAccount, saveConfig } from '../src/storage.js';
import type { ExternalUsage } from '../src/external-usage.js';
import type { PersistedState, TeamAIConfig } from '../src/types.js';

// Account changes reach a running server in place, over the control port,
// with no restart. The real server runs in a throwaway TEAMAI_HOME with no
// background work, and the Codex upstream is a local fake that names the
// account each request came in on: nothing here reads a real config or sign-in
// or reaches the network.

const TOKEN = 'local-test-token';


const grok = (at: number): ExternalUsage => ({ provider: 'grok', status: 'ok', identity: null, groups: [{ name: 'Grok', windows: [{ label: 'wk', minutes: 10_080, usedPercent: 12, resetsAt: null }] }], note: null, measuredAt: at, lastOkAt: at });
const codex = (id: string, priority: number | null) => ({ id, provider: 'codex' as const, label: `${id}@example.com`, enabled: true, priority, credentialId: `codex:${id}`, createdAt: '' });
// Valid for a day, so the relay never tries to refresh one.
const credential = (id: string) => ({ accessToken: `synthetic-${id}`, refreshToken: null, expiresAt: Date.now() + 86_400_000, accountId: id });

// The fake upstream. Account c is out of quota (a 429 saying so, which benches
// it for an hour); the others answer 200 with their usage in the headers. A
// request carrying x-test-hold streams half its body and waits for release().
async function upstream() {
  const seen: string[] = []; let release: () => void = () => {}; const held = new Promise<void>((r) => { release = r; });
  const usage: Record<string, number> = { a: 10, b: 20 };
  const server = createServer((req, res) => {
    const account = String(req.headers['chatgpt-account-id']); seen.push(account); req.resume();
    if (account === 'c') { res.writeHead(429, { 'content-type': 'application/json', 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-after-seconds': '3600', 'x-codex-primary-window-minutes': '300' }); res.end(JSON.stringify({ error: { code: 'usage_limit_reached' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': String(usage[account] ?? 0), 'x-codex-primary-reset-after-seconds': '3600', 'x-codex-primary-window-minutes': '300' });
    res.write('first ');
    if (req.headers['x-test-hold']) void held.then(() => res.end('second')); else res.end('second');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert(address && typeof address !== 'string');
  // A failed test can leave the held response open; close() ends it.
  const close = (): void => { release(); server.closeAllConnections(); server.close(); };
  return { seen, release, close, base: `http://127.0.0.1:${address.port}` };
}

async function home(edit: (config: TeamAIConfig) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'teamai-live-reload-'));
  const previous = process.env.TEAMAI_HOME; process.env.TEAMAI_HOME = root;
  const config = defaultConfig();
  config.proxy = { ...config.proxy, ...anyPorts, clientToken: TOKEN };
  config.warmup = { enabled: false };
  // c first, then a; b is on auto.
  config.accounts = [codex('a', 2), codex('b', null), codex('c', 1)];
  edit(config);
  await saveConfig(config);
  await writeFile(join(root, 'credentials.json'), JSON.stringify(Object.fromEntries(config.accounts.map((a) => [a.credentialId, credential(a.id)]))));
  await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, accounts: {}, events: [], external: { grok: grok(Date.now() - 60_000) } }));
  const restore = async () => { if (previous === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = previous; await rm(root, { recursive: true, force: true }); };
  return { root, config, restore };
}

const ask = (port: number, hold = false): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'session-id': randomUUID(), ...(hold ? { 'x-test-hold': '1' } : {}) }, body: JSON.stringify({ model: 'gpt-6-astra' }) });
const reload = (config: TeamAIConfig): Promise<Response> => fetch(`http://127.0.0.1:${config.proxy.controlPort}/reload`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
const edit = async (change: (config: TeamAIConfig) => void): Promise<void> => { const config = await loadConfig(); change(config); await saveConfig(config); };
const find = (config: TeamAIConfig, id: string) => config.accounts.find((a) => a.id === id)!;

test('a stream in flight runs to the end through a re-rank, a switch-off and a delete of its account, and the next request follows the new order', async () => {
  const up = await upstream(); const h = await home(); const base = providers.codex.upstreamBase; providers.codex.upstreamBase = up.base;
  let server: RunningServer | undefined;
  try {
    server = await startOnAnyPorts(h.config);
    const port = h.config.proxy.codexPort;
    // c is tried first, is out of quota and is benched; a serves.
    const first = await ask(port); assert.equal(first.status, 200); assert.equal(await first.text(), 'first second');
    assert.deepEqual(up.seen, ['c', 'a']);

    const pending = await ask(port, true);
    assert.equal(pending.status, 200);
    assert.equal(up.seen.at(-1), 'a', 'the long stream runs on a');
    const body = pending.text().catch((error: Error) => `cut: ${error.message}`);

    // While a streams: b to the top, then a off, then a deleted.
    await edit((c) => { find(c, 'b').priority = 1; find(c, 'c').priority = null; });
    let res = await reload(h.config); assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await res.json() as { accounts: unknown }).accounts, { claude: { added: 0, removed: 0, retired: 0 }, codex: { added: 0, removed: 0, retired: 0 } });
    await edit((c) => { find(c, 'a').enabled = false; });
    assert.equal((await reload(h.config)).status, 200);
    assert.equal(await removeAccount('codex:a'), true);
    res = await reload(h.config); assert.equal(res.status, 200);
    assert.deepEqual((await res.json() as { accounts: { codex: unknown } }).accounts.codex, { added: 0, removed: 0, retired: 1 }, 'a is still serving, so it is retired, not dropped');

    const during = await ask(port); assert.equal(await during.text(), 'first second');
    assert.equal(up.seen.at(-1), 'b', 'a request starting while a finishes goes to the new first');

    up.release();
    assert.equal(await body, 'first second', 'the stream was not cut');

    // New requests: b now ranks first; c is still benched; a is gone.
    const next = await ask(port); assert.equal(await next.text(), 'first second');
    const after = await ask(port); assert.equal(await after.text(), 'first second');
    assert.deepEqual(up.seen.slice(3), ['b', 'b', 'b']);

    const running = server; server = undefined; await running.stop();
    const state = JSON.parse(await readFile(join(h.root, 'state.json'), 'utf8')) as PersistedState;
    assert.ok((state.accounts['codex:c']?.cooldownUntil ?? 0) > Date.now() + 30 * 60_000, 'c\'s cooldown, learned live, survived three reloads');
    assert.equal(state.accounts['codex:b']?.usage, 0.2, 'usage learned live is kept');
    assert.equal(state.accounts['codex:a'], undefined, 'the deleted account left the pool once its stream ended');
    assert.equal(state.external?.grok?.groups[0]?.windows[0]?.usedPercent, 12, 'other agents\' usage is untouched');
    const credentials = JSON.parse(await readFile(join(h.root, 'credentials.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(credentials).sort(), ['codex:b', 'codex:c'], 'the deleted account\'s token is not written back');
  } finally { await server?.stop(); providers.codex.upstreamBase = base; up.close(); await h.restore(); }
});

test('a config the server cannot use is refused with the reason, and the running settings stay', async () => {
  const up = await upstream(); const h = await home((c) => { c.accounts = [codex('a', 1), codex('b', 2)]; }); const base = providers.codex.upstreamBase; providers.codex.upstreamBase = up.base;
  let server: RunningServer | undefined;
  try {
    server = await startOnAnyPorts(h.config);
    const port = h.config.proxy.codexPort;
    const refusals: Array<[(c: TeamAIConfig) => void, RegExp]> = [
      [(c) => { find(c, 'b').priority = 'top' as never; find(c, 'a').priority = 5; }, /accounts\[1\]: priority must be a whole number/],
      [(c) => { find(c, 'a').enabled = 'yes' as never; }, /accounts\[0\]: enabled must be true or false/],
      [(c) => { c.accounts.push({ ...find(c, 'a'), id: 'z' }); }, /accounts\[2\]: credentialId is used by an earlier account/],
      [(c) => { find(c, 'a').enabled = false; c.routes = { codex: [{ name: 'x', match: [], accounts: ['b'] }] }; }, /route x: match/],
      [(c) => { find(c, 'a').enabled = false; c.routing = { balance: 'random' as never }; }, /routing\.balance/],
    ];
    for (const [change, reason] of refusals) {
      const before = await readFile(join(h.root, 'config.json'), 'utf8');
      await edit(change);
      const res = await reload(h.config); assert.equal(res.status, 400);
      assert.match((await res.json() as { error: string }).error, reason);
      const served = await ask(port); assert.equal(await served.text(), 'first second');
      assert.equal(up.seen.at(-1), 'a', `still on the old order and a still on after ${reason}`);
      await writeFile(join(h.root, 'config.json'), before);
    }
    await writeFile(join(h.root, 'config.json'), '{ not json');
    const res = await reload(h.config); assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /JSON/);
  } finally { await server?.stop(); providers.codex.upstreamBase = base; up.close(); await h.restore(); }
});

const listening = (port: number): Promise<boolean> => new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => { res.resume(); resolve(true); });
  req.on('error', () => resolve(false)); req.end();
});

test('a provider\'s first account opens its port on reload; restart-only settings are named', async () => {
  const h = await home();
  let server: RunningServer | undefined;
  try {
    server = await startOnAnyPorts(h.config);
    assert.equal(server.ports.claude, 0, 'no Claude accounts, no Claude port');
    await edit((c) => { c.accounts.push({ id: 'k', provider: 'claude', label: 'k@example.com', enabled: true, priority: null, credentialId: 'claude:k', createdAt: '' }); c.switchThreshold = 0.9; });
    const credentials = JSON.parse(await readFile(join(h.root, 'credentials.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(h.root, 'credentials.json'), JSON.stringify({ ...credentials, 'claude:k': credential('k') }));
    const res = await reload(h.config); assert.equal(res.status, 200);
    const result = await res.json() as { accounts: { claude: { added: number } }; warnings: string[] };
    assert.equal(result.accounts.claude.added, 1);
    assert.deepEqual(result.warnings, ['switchThreshold changed — applies after teamai restart']);
    assert.notEqual(server.ports.claude, 0); assert.equal(await listening(server.ports.claude), true);
  } finally { await server?.stop(); await h.restore(); }
});

test('reload is local-only, behind the client token, and POST only', async () => {
  const h = await home();
  let server: RunningServer | undefined;
  try {
    server = await startOnAnyPorts(h.config);
    const url = `http://127.0.0.1:${h.config.proxy.controlPort}/reload`;
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
  } finally { await server?.stop(); await h.restore(); }
});

// The address a request arrived from, without a network: /reload reads only
// req.socket.remoteAddress, and these are the two response methods it uses.
function fromAddress(remoteAddress: string | undefined, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): { req: IncomingMessage; res: ServerResponse; seen: { status: number; body: string } } {
  const seen = { status: 0, body: '' };
  const res = { writeHead: (status: number) => { seen.status = status; }, end: (body?: string) => { seen.body = body ?? ''; } } as unknown as ServerResponse;
  const req = { url: '/reload', method: 'POST', headers, socket: { remoteAddress } } as unknown as IncomingMessage;
  return { req, res, seen };
}

test('with the control port exposed beyond loopback, an outside address cannot reload and a loopback one can', async () => {
  const h = await home((c) => { c.proxy.host = '0.0.0.0'; });
  const pool = new AccountPool(providers.codex, [], {}, { version: 1, accounts: {} }); pool.log = () => {};
  const reload = configReloadHandler([pool], h.config);
  try {
    // A valid token and POST from an address that is not loopback: refused,
    // even when the Host header claims loopback, and nothing is applied.
    const outside = fromAddress('203.0.113.9', { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1' });
    assert.equal(await reload(outside.req, outside.res), true);
    assert.equal(outside.seen.status, 403);
    assert.deepEqual(JSON.parse(outside.seen.body), { error: 'local only' });
    assert.equal(pool.accounts.length, 0, 'a refused request changed nothing');

    const local = fromAddress('127.0.0.1');
    assert.equal(await reload(local.req, local.res), true);
    assert.equal(local.seen.status, 200, local.seen.body);
    assert.deepEqual(pool.accounts.map((a) => a.id).sort(), ['a', 'b', 'c']);

    const mapped = fromAddress('::ffff:127.0.0.1', { authorization: `Bearer ${TOKEN}`, host: 'teamai.example' });
    assert.equal(await reload(mapped.req, mapped.res), true);
    assert.equal(mapped.seen.status, 200, mapped.seen.body);
  } finally { await h.restore(); }
});

test('an account removed while serving finishes that request, takes no new one, and leaves when it ends', () => {
  const stored = [codex('a', 1), codex('b', 2)]; const credentials = { 'codex:a': credential('a'), 'codex:b': credential('b') };
  const pool = new AccountPool(providers.codex, stored, credentials, { version: 1, accounts: {} });
  const a = pool.acquire('s1')!; assert.equal(a.id, 'a');
  a.usage = 0.4; a.cooldownUntil = null;
  assert.deepEqual(pool.sync([stored[1]!], credentials), { added: 0, removed: 0, retired: 1 });
  assert.equal(pool.acquire('s1')?.id, 'b', 'the session pinned to a moves on; a takes nothing new');
  assert.equal(pool.acquire('s2')?.id, 'b');
  const exported: PersistedState = { version: 1, accounts: {} }; pool.exportState(exported);
  assert.deepEqual(Object.keys(exported.accounts), ['codex:b'], 'a retired account is not saved');
  pool.release(a);
  assert.deepEqual(pool.accounts.map((x) => x.id), ['b'], 'gone once its request ended');

  // Removed and added back before its request ended: the same account, live again.
  const again = new AccountPool(providers.codex, stored, credentials, { version: 1, accounts: {} });
  const held = again.acquire('s')!; held.usage = 0.4;
  again.sync([stored[1]!], credentials); again.sync(stored, credentials);
  assert.equal(again.accounts.find((x) => x.id === 'a'), held);
  assert.equal(held.retired, false); assert.equal(held.enabled, true); assert.equal(held.usage, 0.4);
  again.release(held);
  assert.deepEqual(again.accounts.map((x) => x.id), ['a', 'b'], 'a live account stays after release');
});

test('Codex capacity settings are validated and adopted atomically by POST /reload without replacing the listener', { timeout: 10_000 }, async () => {
  let attempts = 0; let alwaysFail = true; const accounts: string[] = []; const times: number[] = [];
  const fake = createServer((req, res) => {
    req.resume(); attempts++; accounts.push(String(req.headers['chatgpt-account-id'])); times.push(Date.now());
    if (alwaysFail || attempts % 2) { res.writeHead(503, { 'retry-after': '120' }); res.end('{"error":{"code":"server_is_overloaded"}}'); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"type":"response.completed"}\n\n'); }
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r)); const address = fake.address(); assert(address && typeof address !== 'string');
  const h = await home((c) => { c.accounts = [codex('a', 1), codex('b', 2)]; c.codexCapacityEnabled = false; });
  const base = providers.codex.upstreamBase; providers.codex.upstreamBase = `http://127.0.0.1:${address.port}`;
  let server: RunningServer | undefined;
  try {
    server = await startOnAnyPorts(h.config);
    const first = await ask(h.config.proxy.codexPort); assert.equal(first.status, 503); await first.text(); assert.equal(attempts, 2);
    await edit((c) => { c.codexCapacityEnabled = true; c.codexCapacityRetryMs = 60; c.codexCapacityPreambleHoldMs = 0; c.codexCapacityRotation = true; });
    assert.equal((await reload(h.config)).status, 200);
    alwaysFail = false; attempts = 0; accounts.length = 0; times.length = 0;
    const next = await ask(h.config.proxy.codexPort); assert.equal(next.status, 200); assert.equal(await next.text(), 'data: {"type":"response.completed"}\n\n');
    assert.equal(attempts, 2); assert.deepEqual(accounts, ['a', 'b']); assert(times[1]! - times[0]! >= 55);
    for (const key of ['codexCapacityEnabled', 'codexCapacityRetryMs', 'codexCapacityPreambleHoldMs', 'codexCapacityRotation'] as const) {
      const before = await readFile(join(h.root, 'config.json'), 'utf8');
      await edit((c) => { find(c, 'a').enabled = false; Object.assign(c, { [key]: 'invalid' }); });
      const refused = await reload(h.config); assert.equal(refused.status, 400); assert.match((await refused.json() as { error: string }).error, new RegExp(key));
      attempts = 0; accounts.length = 0;
      const served = await ask(h.config.proxy.codexPort); assert.equal(served.status, 200); await served.text(); assert.deepEqual(accounts, ['a', 'b'], 'invalid settings must not partly apply account edits');
      await writeFile(join(h.root, 'config.json'), before);
    }
  } finally { await server?.stop(); providers.codex.upstreamBase = base; fake.closeAllConnections(); fake.close(); await h.restore(); }
});
