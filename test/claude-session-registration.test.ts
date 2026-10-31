import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AccountPool } from '../src/account-pool.js';
import { handleClaudeSessionControl, CLAUDE_SESSION_PATH, prepareClaudeArgs } from '../src/claude-session-control.js';
import { claudeWarmToken } from '../src/claude-warm-auth.js';
import { createProxy } from '../src/proxy.js';
import { claudeProvider } from '../src/providers.js';
import { defaultConfig, issueClaudeSession, loadSessions, paths, saveConfig, saveCredentials } from '../src/storage.js';
import { startOnAnyPorts } from './server-ports.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
function close(server: Server): void { server.closeAllConnections(); server.close(); }

async function rig(t: test.TestContext) {
  const hits: string[] = [];
  const upstream = createServer((req, res) => {
    hits.push(String(req.headers.authorization));
    assert.equal(req.headers['x-teamai-warm-token'], undefined);
    req.resume(); req.once('end', () => { res.writeHead(200); res.end('{}'); });
  });
  const upstreamBase = await listen(upstream); t.after(() => close(upstream));
  const pool = new AccountPool({ ...claudeProvider, upstreamBase, readQuota: () => null, refresh: async (credential) => credential }, ['a', 'b'].map((id, i) => ({ id, provider: 'claude', label: id, enabled: true, priority: i + 1, credentialId: id, createdAt: '' })), Object.fromEntries(['a', 'b'].map((id) => [id, { accountId: id, accessToken: `fake-${id}`, refreshToken: null, expiresAt: null }])), { version: 1, accounts: {} });
  const proxy = createProxy(pool, 'synthetic', () => {});
  const base = await listen(proxy); t.after(() => close(proxy));
  const control = createServer(async (req, res) => { if (!(await handleClaudeSessionControl(req, res, 'synthetic'))) res.writeHead(404).end(); });
  const controlBase = await listen(control); t.after(() => close(control));
  const config = defaultConfig(); config.proxy.clientToken = 'synthetic'; config.proxy.controlPort = Number(new URL(controlBase).port);
  const send = async (id: string | null, body: unknown = { messages: [{ role: 'user', content: 'synthetic' }] }, path = '/v1/messages', extra: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json', ...(id ? { 'x-claude-code-session-id': id } : {}), ...extra }, body: JSON.stringify(body) });
    await response.text(); return response.status;
  };
  return { hits, pool, send, config, controlBase, upstreamBase };
}

test('CLI preparation obtains two relay IDs over authenticated control and both sessions bind independently', async (t) => {
  const r = await rig(t);
  const first = await prepareClaudeArgs(['--print', 'synthetic'], r.config);
  const second = await prepareClaudeArgs([], r.config);
  assert.equal(first[0], '--session-id'); assert.deepEqual(first.slice(2), ['--print', 'synthetic']);
  const a = first[1]!; const b = second[1]!; assert.notEqual(a, b);
  assert.equal(await r.send(a), 200);
  r.pool.accounts[0]!.enabled = false;
  assert.equal(await r.send(b), 200);
  assert.equal(await r.send(a), 503);
  assert.deepEqual(r.hits, ['Bearer fake-a', 'Bearer fake-b']);
});

test('real runtime exposes authenticated session issuance on its control listener', async (t) => {
  const config = defaultConfig();
  config.accounts = [{ id: 'a', provider: 'claude', label: 'synthetic', enabled: true, priority: 1, credentialId: 'a', createdAt: '' }];
  await saveCredentials({ a: { accountId: 'a', accessToken: 'synthetic', refreshToken: null, expiresAt: Date.now() + 3600_000 } });
  await saveConfig(config);
  const server = await startOnAnyPorts(config); t.after(() => server.stop());
  const args = await prepareClaudeArgs([], config);
  assert.match(args[1]!, /^[0-9a-f-]{36}$/);
  assert.equal(Object.keys(await loadSessions()).length, 0);
});

test('unregistered IDs are rejected for compact, history, tool and metadata shapes including explicit account paths', async (t) => {
  const r = await rig(t);
  for (const body of [
    {}, { messages: [] }, { messages: [{ role: 'user', content: 'compact' }] },
    { messages: [{ role: 'assistant', content: 'old' }, { role: 'user', content: 'next' }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'old' }] }] },
    { metadata: { user_id: JSON.stringify({ session_id: 'unknown', account_uuid: 'b' }) } },
  ]) {
    assert.equal(await r.send('unknown', body), 409);
    assert.equal(await r.send('unknown', body, '/tc-acct/b/claude/v1/messages'), 409);
  }
  assert.equal(await r.send(null, {}, '/tc-acct/b/claude/v1/messages'), 400);
  assert.deepEqual(r.hits, []);
});

test('only in-process warm requests can use an account path without conversation registration', async (t) => {
  const r = await rig(t);
  assert.equal(await r.send(null, {}, '/tc-acct/b/claude/v1/messages', { 'x-teamai-warm-token': 'forged' }), 400);
  assert.equal(await r.send(null, {}, '/tc-acct/b/claude/v1/messages', { 'x-teamai-warm-token': claudeWarmToken(r.pool) }), 200);
  assert.deepEqual(r.hits, ['Bearer fake-b']);
});

test('control rejects unauthorized issuance and never registers client-selected IDs', async (t) => {
  const r = await rig(t);
  const denied = await fetch(r.controlBase + CLAUDE_SESSION_PATH, { method: 'POST' }); await denied.text(); assert.equal(denied.status, 401);
  const result = await fetch(r.controlBase + CLAUDE_SESSION_PATH, { method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: JSON.stringify({ sessionId: 'chosen' }) });
  assert.equal(result.status, 201); const body = await result.json() as { sessionId: string }; assert.notEqual(body.sessionId, 'chosen');
  assert.equal(await r.send('chosen'), 409); assert.equal(await r.send(body.sessionId), 200);
});

test('resume and continue preserve proven IDs while unproven resume and fork cannot register a new ID', async (t) => {
  const r = await rig(t);
  for (const args of [['--resume', 'unknown'], ['--resume=unknown'], ['--continue'], ['-r', 'unknown'], ['-c'], ['-runknown'], ['-pc'], ['-cr']]) assert.deepEqual(await prepareClaudeArgs(args, r.config), args);
  for (const args of [['--session-id', 'chosen'], ['--session-id=chosen'], ['--fork-session'], ['--resume', 'unknown', '--fork-session']]) await assert.rejects(prepareClaudeArgs(args, r.config), /unsupported/);
  assert.equal(await r.send('unknown'), 409);
  const id = (await prepareClaudeArgs([], r.config))[1]!;
  assert.equal(await r.send(id), 200);
  for (const messages of [[{ role: 'user', content: 'compact' }], [{ role: 'user', content: [{ type: 'tool_result', content: 'subrequest' }] }]]) assert.equal(await r.send(id, { messages }), 200);
  assert.deepEqual(r.hits, ['Bearer fake-a', 'Bearer fake-a', 'Bearer fake-a']);
});

for (const damage of ['missing ledger', 'invalid JSON', 'wrong root', 'wrong entry', 'unreadable ledger', 'missing marker', 'partial creation'] as const) {
  test(`session issuance and dispatch fail closed on ${damage}`, async (t) => {
    const r = await rig(t); const id = await issueClaudeSession();
    const ledger = join(dirname(paths().sessions), '.sessions-ledger.json');
    if (damage === 'missing ledger' || damage === 'unreadable ledger') { await rm(ledger); if (damage === 'unreadable ledger') { const { mkdir } = await import('node:fs/promises'); await mkdir(ledger); } }
    else if (damage === 'missing marker') await rm(join(dirname(paths().sessions), '.sessions-created'));
    else if (damage === 'partial creation') await rm(paths().sessions);
    else await writeFile(ledger, damage === 'invalid JSON' ? 'not json' : damage === 'wrong root' ? 'null' : JSON.stringify({ [id]: 12 }));
    assert.equal(await r.send(id), 500); assert.deepEqual(r.hits, []);
    await assert.rejects(prepareClaudeArgs([], r.config), /control 500/);
  });
}

async function childRelay(upstreamBase: string, id: string, preferred: string, disabled = '') {
  const here = new URL('.', import.meta.url);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = fork(fileURLToPath(new URL('claude-session-child.ts', here)), [process.env.TEAMAI_HOME!, upstreamBase, id, preferred, disabled], { execArgv: ['--import', 'tsx', '--import', fileURLToPath(new URL('isolation.ts', here))], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exit = once(child, 'exit');
  const [ready] = await Promise.race([once(child, 'message'), exit.then(() => { throw new Error(output || 'Child exited before readiness'); })]);
  assert.deepEqual(ready, { ready: true });
  return { child, async run() { const reply = once(child, 'message'); child.send('go'); const [result] = await reply as [{ status: number }]; const [code] = await exit; assert.equal(code, 0, output); return result.status; } };
}

test('two independent child relays atomically bind the same registered ID despite opposite account preferences', { timeout: 20_000 }, async (t) => {
  const r = await rig(t); const id = await issueClaudeSession();
  const children = await Promise.all([childRelay(r.upstreamBase, id, 'a'), childRelay(r.upstreamBase, id, 'b')]);
  t.after(() => children.forEach(({ child }) => child.kill()));
  assert.deepEqual(await Promise.all(children.map((child) => child.run())), [200, 200]);
  assert.equal(r.hits.length, 2); assert.equal(new Set(r.hits).size, 1, 'both processes must use the same actual account');
});

test('fresh child relay refuses a deleted bound entry with corrupt ledger after disk restoration', { timeout: 20_000 }, async (t) => {
  const r = await rig(t); const id = await issueClaudeSession();
  assert.equal(await r.send(id), 200);
  const original = JSON.parse(await readFile(paths().sessions, 'utf8'));
  delete original[id]; await writeFile(paths().sessions, JSON.stringify(original));
  await writeFile(join(dirname(paths().sessions), '.sessions-ledger.json'), 'not json');
  const child = await childRelay(r.upstreamBase, id, 'b', 'a'); t.after(() => child.child.kill());
  assert.equal(await child.run(), 500); assert.deepEqual(r.hits, ['Bearer fake-a']);
});


test('authentication refresh cannot replace the actual account before forwarding a bound request', async (t) => {
  const r = await rig(t); const id = await issueClaudeSession();
  r.pool.provider.refresh = async (credential) => ({ ...credential, accountId: 'b', accessToken: 'fake-b' });
  assert.equal(await r.send(id), 500);
  assert.deepEqual(r.hits, [], 'changed identity must not reach either account');
});

test('deleting pending registrations or the entire store never authorizes an old ID', async (t) => {
  const r = await rig(t); const id = await issueClaudeSession();
  const ledger = join(dirname(paths().sessions), '.sessions-ledger.json');
  await writeFile(ledger, '{}');
  assert.equal(await r.send(id), 409);
  for (const file of [paths().sessions, ledger, join(dirname(paths().sessions), '.sessions-created')]) await rm(file);
  assert.equal(await r.send(id), 409);
  const freshId = await issueClaudeSession(); assert.notEqual(freshId, id);
  assert.equal(await r.send(freshId), 200);
  assert.equal(await r.send(id), 409);
  assert.deepEqual(r.hits, ['Bearer fake-a']);
});

test('an interrupted binding commit consumes registration and fails closed on the next request', async (t) => {
  const r = await rig(t); const id = await issueClaudeSession();
  await writeFile(join(dirname(paths().sessions), '.sessions-ledger.json'), JSON.stringify({ [id]: 'bound' }));
  assert.equal(await r.send(id), 500);
  assert.deepEqual(r.hits, []);
});
