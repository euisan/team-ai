// Adopting a Claude conversation the relay never registered (one that started
// under an older relay) as first bound to an account an administrator names.
// Fake upstreams, loopback port 0 and the isolated TEAMAI_HOME only.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AccountPool } from '../src/account-pool.js';
import { CLAUDE_SESSION_ADOPT_PATH, handleClaudeSessionAdopt, requestClaudeAdopt } from '../src/claude-session-control.js';
import { createProxy } from '../src/proxy.js';
import { claudeProvider } from '../src/providers.js';
import { defaultConfig, issueClaudeSession, loadSessions, paths, saveConfig, saveCredentials } from '../src/storage.js';
import type { OAuthCredential, StoredAccount } from '../src/types.js';
import { startOnAnyPorts } from './server-ports.js';

const TOKEN = 'synthetic-control';
const LEGACY_ID = '0f8c2a51-7d3e-4b6a-9c1d-2e5f6a7b8c9d';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
function close(server: Server): void { server.closeAllConnections(); server.close(); }

const ledgerPath = () => join(dirname(paths().sessions), '.sessions-ledger.json');
const markerPath = () => join(dirname(paths().sessions), '.sessions-created');
async function storeFiles(): Promise<(string | null)[]> {
  return Promise.all([markerPath(), ledgerPath(), paths().sessions].map((file) => readFile(file, 'utf8').catch(() => null)));
}

type Shape = { credentialId: (id: string) => string; actual: (id: string) => string };
const distinct: Shape = { credentialId: (id) => `cred-${id}`, actual: (id) => `uuid-${id}` };
// What test/claude-session-child.ts builds: credential id and actual id are the account id.
const childShape: Shape = { credentialId: (id) => id, actual: (id) => id };

function fixture(shape: Shape, extra: StoredAccount[] = []): { accounts: StoredAccount[]; credentials: Record<string, OAuthCredential> } {
  const accounts: StoredAccount[] = ['a', 'b'].map((id, i) => ({ id, provider: 'claude', label: `${id}@example.test`, enabled: true, priority: i + 1, credentialId: shape.credentialId(id), createdAt: '' }));
  const credentials: Record<string, OAuthCredential> = Object.fromEntries(['a', 'b'].map((id) => [shape.credentialId(id), { accountId: shape.actual(id), accessToken: `fake-${id}`, refreshToken: null, expiresAt: null }]));
  for (const account of extra) { accounts.push(account); credentials[account.credentialId] = { accountId: `uuid-${account.id}`, accessToken: `fake-${account.id}`, refreshToken: null, expiresAt: null }; }
  return { accounts, credentials };
}

// One relay: proxy and control listener over one pool, with a fake upstream
// that records which credential each request carried. reply decides the
// upstream's answer per token.
async function rig(t: test.TestContext, options: { shape?: Shape; extra?: StoredAccount[]; reply?: (auth: string) => number } = {}) {
  const hits: string[] = [];
  const upstream = createServer((req, res) => {
    req.resume(); req.once('end', () => {
      const auth = String(req.headers.authorization); hits.push(auth);
      const status = options.reply?.(auth) ?? 200;
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'anthropic-ratelimit-unified-5h-status': 'rejected', 'retry-after': '60' } : {}) });
      res.end(status === 200 ? '{}' : JSON.stringify({ type: 'error', error: { type: 'synthetic', message: 'synthetic' } }));
    });
  });
  const upstreamBase = await listen(upstream); t.after(() => close(upstream));
  const { accounts, credentials } = fixture(options.shape ?? distinct, options.extra);
  const makePool = () => new AccountPool({ ...claudeProvider, upstreamBase, readQuota: () => null, refresh: async (credential) => credential }, accounts, credentials, { version: 1, accounts: {} });
  const pool = makePool();
  const proxy = createProxy(pool, TOKEN, () => {});
  const proxyBase = await listen(proxy); t.after(() => close(proxy));
  const logs: string[] = [];
  const control = createServer(async (req, res) => { if (!(await handleClaudeSessionAdopt(req, res, pool, TOKEN, (line) => logs.push(line)))) res.writeHead(404).end(); });
  const controlBase = await listen(control); t.after(() => close(control));
  const adopt = async (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, method = 'POST') => {
    const response = await fetch(controlBase + CLAUDE_SESSION_ADOPT_PATH, { method, headers: { 'content-type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text || '{}') as Record<string, unknown> };
  };
  const sendVia = async (base: string, id: string) => {
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-claude-code-session-id': id }, body: JSON.stringify({ messages: [{ role: 'user', content: 'synthetic' }] }) });
    await response.text(); return response.status;
  };
  const send = (id: string) => sendVia(proxyBase, id);
  return { hits, pool, makePool, adopt, send, sendVia, logs, upstreamBase };
}

test('adopt control refuses a missing or wrong client token and records nothing', async (t) => {
  const r = await rig(t);
  const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }, { authorization: 'Bearer ' }, { authorization: `Bearer ${TOKEN}x` }, { authorization: `Basic ${TOKEN}` }];
  for (const headers of attempts) {
    const reply = await r.adopt({ sessionId: LEGACY_ID, account: 'b@example.test' }, headers);
    assert.equal(reply.status, 401, JSON.stringify(headers));
  }
  assert.deepEqual(await storeFiles(), [null, null, null]);
  assert.equal(await r.send(LEGACY_ID), 409);
  assert.deepEqual(r.hits, []);
});

test('an adopted session is served only by the named account although another ranks first', async (t) => {
  const r = await rig(t);
  const reply = await r.adopt({ sessionId: LEGACY_ID, account: 'b@example.test' });
  assert.equal(reply.status, 201);
  assert.deepEqual(reply.body, { sessionId: LEGACY_ID, account: 'b@example.test', status: 'adopted' });
  for (let i = 0; i < 3; i++) assert.equal(await r.send(LEGACY_ID), 200);
  assert.deepEqual(r.hits, ['Bearer fake-b', 'Bearer fake-b', 'Bearer fake-b']);
  const stored = (await loadSessions())[LEGACY_ID]!;
  assert.deepEqual({ ...stored, boundAt: 0 }, { sessionId: LEGACY_ID, provider: 'claude', accountId: 'b', credentialId: 'cred-b', actualAccountId: 'uuid-b', boundAt: 0 });
  assert.deepEqual(JSON.parse(await readFile(ledgerPath(), 'utf8')), { [LEGACY_ID]: 'bound' });
});

test('adopt reply and log carry no token or credential', async (t) => {
  const r = await rig(t);
  const reply = await r.adopt({ sessionId: LEGACY_ID, account: 'cred-b' });
  assert.equal(reply.status, 201);
  assert.deepEqual(Object.keys(reply.body).sort(), ['account', 'sessionId', 'status']);
  for (const text of [reply.text, ...r.logs]) for (const secret of [TOKEN, 'fake-a', 'fake-b', 'uuid-b']) assert(!text.includes(secret), `${secret} leaked`);
  assert.equal(r.logs.length, 1);
});

test('an adopted session never moves to another account on quota, cooldown, disable, upstream errors or removal', async (t) => {
  for (const failure of [429, 401, 403, 500, 529]) {
    const r = await rig(t, { reply: (auth) => (auth === 'Bearer fake-b' ? failure : 200) });
    assert.equal((await r.adopt({ sessionId: LEGACY_ID, account: 'b' })).status, 201);
    for (let i = 0; i < 3; i++) await r.send(LEGACY_ID);
    assert(r.hits.length > 0, `upstream ${failure} reached`);
    assert.deepEqual(r.hits.filter((hit) => hit !== 'Bearer fake-b'), [], `upstream ${failure}: account a must receive nothing`);
    for (const file of [markerPath(), ledgerPath(), paths().sessions]) await rm(file);
  }
  const r = await rig(t);
  assert.equal((await r.adopt({ sessionId: LEGACY_ID, account: 'b' })).status, 201);
  const b = r.pool.accounts.find((a) => a.id === 'b')!;
  b.cooldownUntil = Date.now() + 60_000; b.cooldownReason = 'quota';
  assert.equal(await r.send(LEGACY_ID), 429);
  b.cooldownUntil = null; b.cooldownReason = null; b.enabled = false;
  assert.equal(await r.send(LEGACY_ID), 503);
  r.pool.sync(r.pool.accounts.filter((a) => a.id === 'a'), { 'cred-a': r.pool.accounts[0]!.credential });
  assert.equal(await r.send(LEGACY_ID), 503);
  assert.deepEqual(r.hits, [], 'account a must receive nothing');
});

test('re-adopting on the same account is idempotent; another account is refused with 409 and the binding kept', async (t) => {
  const r = await rig(t);
  assert.equal((await r.adopt({ sessionId: LEGACY_ID, account: 'a@example.test' })).status, 201);
  const before = await storeFiles();
  for (const account of ['a@example.test', 'a', 'cred-a']) {
    const again = await r.adopt({ sessionId: LEGACY_ID, account });
    assert.equal(again.status, 200); assert.deepEqual(again.body, { sessionId: LEGACY_ID, account: 'a@example.test', status: 'already_bound' });
  }
  for (const account of ['b@example.test', 'b', 'cred-b']) assert.equal((await r.adopt({ sessionId: LEGACY_ID, account })).status, 409);
  assert.deepEqual(await storeFiles(), before);
  r.pool.accounts[0]!.enabled = false;
  assert.equal(await r.send(LEGACY_ID), 503);
  assert.deepEqual(r.hits, []);
});

test('a session bound by its first request cannot be adopted onto another account', async (t) => {
  const r = await rig(t);
  const id = await issueClaudeSession();
  assert.equal(await r.send(id), 200);
  const before = await storeFiles();
  assert.equal((await r.adopt({ sessionId: id, account: 'b' })).status, 409);
  assert.equal((await r.adopt({ sessionId: id, account: 'a' })).status, 200);
  assert.deepEqual(await storeFiles(), before);
  assert.equal(await r.send(id), 200);
  assert.deepEqual(r.hits, ['Bearer fake-a', 'Bearer fake-a']);
});

test('concurrent adoptions of one session onto two accounts record exactly one', async (t) => {
  const r = await rig(t);
  const asked = ['a', 'b', 'a', 'b'];
  const replies = await Promise.all(asked.map((account) => r.adopt({ sessionId: LEGACY_ID, account })));
  assert.equal(replies.filter((reply) => reply.status === 201).length, 1);
  const winner = asked[replies.findIndex((reply) => reply.status === 201)]!;
  replies.forEach((reply, i) => { if (reply.status !== 201) assert.equal(reply.status, asked[i] === winner ? 200 : 409); });
  assert.equal(await r.send(LEGACY_ID), 200);
  assert.deepEqual(r.hits, [`Bearer fake-${winner}`]);
});

test('a pending registration issued by the relay cannot be adopted', async (t) => {
  const r = await rig(t);
  const id = await issueClaudeSession();
  const before = await storeFiles();
  const reply = await r.adopt({ sessionId: id, account: 'b' });
  assert.equal(reply.status, 409); assert.match(String(reply.body.error), /pending/);
  assert.deepEqual(await storeFiles(), before);
  assert.equal(await r.send(id), 200);
  assert.deepEqual(r.hits, ['Bearer fake-a'], 'the normal first request still binds it');
});

test('adopt refuses unknown, non-Claude, ambiguous, disabled, removed and identity-less accounts without recording', async (t) => {
  const codex: StoredAccount = { id: 'x', provider: 'codex', label: 'x@example.test', enabled: true, priority: null, credentialId: 'cred-x', createdAt: '' };
  const twin: StoredAccount = { id: 'twin', provider: 'claude', label: 'b@example.test', enabled: true, priority: 3, credentialId: 'cred-twin', createdAt: '' };
  const r = await rig(t, { extra: [codex, twin] });
  const expect = async (account: unknown, status: number, pattern: RegExp) => {
    const reply = await r.adopt({ sessionId: LEGACY_ID, account });
    assert.equal(reply.status, status, String(account)); assert.match(String(reply.body.error), pattern);
  };
  await expect('nobody@example.test', 404, /not found/);
  await expect('x@example.test', 404, /not found among Claude/);
  await expect('cred-x', 404, /not found among Claude/);
  await expect('b@example.test', 400, /by id/);
  await expect('', 400, /Missing account/);
  await expect(42, 400, /Missing account/);
  const a = r.pool.accounts.find((x) => x.id === 'a')!;
  a.enabled = false; await expect('a', 400, /disabled/); a.enabled = true;
  a.retired = true; await expect('a', 400, /removed/); a.retired = false;
  const credential = a.credential;
  a.credential = { ...credential, accountId: '' }; await expect('a', 400, /no account id/);
  a.credential = { ...credential, accountId: '   ' }; await expect('a', 400, /no account id/);
  a.credential = credential;
  assert.deepEqual(await storeFiles(), [null, null, null]);
  assert.equal(await r.send(LEGACY_ID), 409);
  assert.deepEqual(r.hits, []);
});

test('adopt validates the session ID like dispatch and refuses malformed requests', async (t) => {
  const r = await rig(t);
  for (const sessionId of ['', '   ', '__proto__', 'constructor', 'prototype', 'x'.repeat(257), 'a,b', 'a b', 'tab\tid', 'non-ascii-é', 42, null, undefined, ['id'], { id: 'x' }]) {
    const reply = await r.adopt({ sessionId, account: 'a' });
    assert.equal(reply.status, 400, JSON.stringify(sessionId)); assert.match(String(reply.body.error), /Invalid sessionId/);
  }
  for (const body of ['not json', '[]', 'null', '"text"']) assert.equal((await r.adopt(body)).status, 400, body);
  assert.equal((await r.adopt(JSON.stringify({ sessionId: LEGACY_ID, account: 'a', pad: 'x'.repeat(5000) }))).status, 413);
  assert.equal((await r.adopt(undefined, { authorization: `Bearer ${TOKEN}` }, 'GET')).status, 405);
  assert.deepEqual(await storeFiles(), [null, null, null]);
  const longest = 'y'.repeat(256);
  assert.equal((await r.adopt({ sessionId: ` ${longest} `, account: 'a' })).status, 201);
  assert.equal(await r.send(longest), 200);
  assert.deepEqual(r.hits, ['Bearer fake-a']);
});

for (const damage of ['missing ledger', 'invalid JSON ledger', 'wrong entry', 'unreadable ledger', 'missing marker', 'partial creation', 'binding without ledger record', 'interrupted commit'] as const) {
  test(`adopt fails closed with 500 and writes nothing on ${damage}`, async (t) => {
    const r = await rig(t);
    const other = await issueClaudeSession();
    assert.equal(await r.send(other), 200);
    if (damage === 'missing ledger' || damage === 'unreadable ledger') { await rm(ledgerPath()); if (damage === 'unreadable ledger') await mkdir(ledgerPath()); }
    else if (damage === 'missing marker') await rm(markerPath());
    else if (damage === 'partial creation') await rm(paths().sessions);
    else if (damage === 'invalid JSON ledger') await writeFile(ledgerPath(), 'not json');
    else if (damage === 'wrong entry') await writeFile(ledgerPath(), JSON.stringify({ [other]: 12 }));
    else if (damage === 'binding without ledger record') await writeFile(ledgerPath(), '{}');
    else await writeFile(ledgerPath(), JSON.stringify({ [other]: 'bound', [LEGACY_ID]: 'bound' }));
    const before = await Promise.all([markerPath(), paths().sessions].map((file) => readFile(file, 'utf8').catch(() => null)));
    const ledgerBefore = damage === 'unreadable ledger' ? null : await readFile(ledgerPath(), 'utf8').catch(() => null);
    const reply = await r.adopt({ sessionId: LEGACY_ID, account: 'b' });
    assert.equal(reply.status, 500); assert.match(String(reply.body.error), /nothing recorded/);
    assert.deepEqual(await Promise.all([markerPath(), paths().sessions].map((file) => readFile(file, 'utf8').catch(() => null))), before);
    if (damage !== 'unreadable ledger') assert.equal(await readFile(ledgerPath(), 'utf8').catch(() => null), ledgerBefore);
    assert.equal(await r.send(LEGACY_ID), 500);
    assert.deepEqual(r.hits, ['Bearer fake-a']);
  });
}

test('adopting into a fresh store creates it, and normal issuance keeps working beside the adopted session', async (t) => {
  const r = await rig(t);
  assert.deepEqual(await storeFiles(), [null, null, null]);
  assert.equal((await r.adopt({ sessionId: LEGACY_ID, account: 'b' })).status, 201);
  const [marker] = await storeFiles(); assert.equal(marker, '1\n');
  const id = await issueClaudeSession();
  assert.equal(await r.send(id), 200);
  assert.equal(await r.send(LEGACY_ID), 200);
  assert.deepEqual(r.hits, ['Bearer fake-a', 'Bearer fake-b']);
  assert.deepEqual(JSON.parse(await readFile(ledgerPath(), 'utf8')), { [LEGACY_ID]: 'bound', [id]: 'bound' });
});

test('an adopted session keeps its account across a restarted pool even when that account is disabled', async (t) => {
  const r = await rig(t);
  assert.equal((await r.adopt({ sessionId: LEGACY_ID, account: 'b' })).status, 201);
  const restarted = r.makePool();
  const proxy = createProxy(restarted, TOKEN, () => {}); const base = await listen(proxy); t.after(() => close(proxy));
  assert.equal(await r.sendVia(base, LEGACY_ID), 200);
  restarted.accounts.find((a) => a.id === 'b')!.enabled = false;
  assert.equal(await r.sendVia(base, LEGACY_ID), 503);
  assert.deepEqual(r.hits, ['Bearer fake-b']);
});

test('an independent child relay preferring the other account serves an adopted session on the adopted account', { timeout: 20_000 }, async (t) => {
  const r = await rig(t, { shape: childShape });
  assert.equal((await r.adopt({ sessionId: LEGACY_ID, account: 'b' })).status, 201);
  for (const disabled of ['', 'b']) {
    const here = new URL('.', import.meta.url);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = fork(fileURLToPath(new URL('claude-session-child.ts', here)), [process.env.TEAMAI_HOME!, r.upstreamBase, LEGACY_ID, 'a', disabled], { execArgv: ['--import', 'tsx', '--import', fileURLToPath(new URL('isolation.ts', here))], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => child.kill());
    let output = ''; child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const exit = once(child, 'exit');
    const [ready] = await Promise.race([once(child, 'message'), exit.then(() => { throw new Error(output || 'child exited early'); })]);
    assert.deepEqual(ready, { ready: true });
    const reply = once(child, 'message'); child.send('go');
    const [result] = await reply as [{ status: number }];
    const [code] = await exit; assert.equal(code, 0, output);
    assert.equal(result.status, disabled === 'b' ? 503 : 200);
  }
  assert.deepEqual(r.hits, ['Bearer fake-b']);
});

test('the real runtime adopts over its authenticated control listener', async (t) => {
  const config = defaultConfig();
  config.accounts = ['a', 'b'].map((id, i) => ({ id, provider: 'claude', label: `${id}@example.test`, enabled: true, priority: i + 1, credentialId: `cred-${id}`, createdAt: '' }));
  await saveCredentials(Object.fromEntries(['a', 'b'].map((id) => [`cred-${id}`, { accountId: `uuid-${id}`, accessToken: `synthetic-${id}`, refreshToken: null, expiresAt: Date.now() + 3600_000 }])));
  await saveConfig(config);
  const server = await startOnAnyPorts(config); t.after(() => server.stop());
  const denied = await requestClaudeAdopt({ ...config, proxy: { ...config.proxy, clientToken: 'wrong' } }, LEGACY_ID, 'b@example.test');
  assert.equal(denied.status, 401);
  assert.equal(Object.keys(await loadSessions()).length, 0);
  const adopted = await requestClaudeAdopt(config, LEGACY_ID, 'b@example.test');
  assert.equal(adopted.status, 201); assert.deepEqual(adopted.body, { sessionId: LEGACY_ID, account: 'b@example.test', status: 'adopted' });
  assert.equal(JSON.stringify(adopted.body).includes('synthetic-b'), false);
  const stored = (await loadSessions())[LEGACY_ID]!;
  assert.deepEqual([stored.accountId, stored.credentialId, stored.actualAccountId], ['b', 'cred-b', 'uuid-b']);
  assert.equal((await requestClaudeAdopt(config, LEGACY_ID, 'a@example.test')).status, 409);
  assert.equal((await loadSessions())[LEGACY_ID]!.accountId, 'b');
});
