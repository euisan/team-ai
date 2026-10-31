import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { createProxy } from '../src/proxy.js';
import { claudeProvider } from '../src/providers.js';
import { paths } from '../src/storage.js';
import type { Provider, StoredAccount } from '../src/types.js';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function rig() {
  const received: string[] = [];
  const upstream = createServer(async (req, res) => {
    req.resume();
    await new Promise<void>((r) => req.once('end', r));
    received.push(String(req.headers.authorization));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  const base = await listen(upstream);
  const provider: Provider = { ...claudeProvider, upstreamBase: base, readQuota: () => null, refresh: async (c) => c };
  const accounts: StoredAccount[] = ['a', 'b'].map((id, i) => ({ id, provider: 'claude', label: id, enabled: true, priority: i + 1, credentialId: `cred-${id}`, createdAt: '' }));
  const credentials = Object.fromEntries(['a', 'b'].map((id) => [`cred-${id}`, { accessToken: `fake-${id}`, refreshToken: '', expiresAt: Date.now() + 3600000, accountId: `uuid-${id}` }]));
  const pool = new AccountPool(provider, accounts, credentials, { version: 1, accounts: {} }, 0.98, 16);
  const proxy = createProxy(pool, 'synthetic-local-only', () => {});
  const proxyBase = await listen(proxy);
  async function send(id: string, path = '/v1/messages', extra: Record<string, string> = {}, body: unknown = { messages: [{ role: 'user', content: 'synthetic first or compact turn' }] }) {
    const res = await fetch(proxyBase + path, { method: 'POST', headers: { authorization: 'Bearer synthetic-local-only', 'content-type': 'application/json', 'x-claude-code-session-id': id, ...extra }, body: JSON.stringify(body) });
    await res.text(); return res.status;
  }
  function close() { proxy.closeAllConnections(); upstream.closeAllConnections(); proxy.close(); upstream.close(); }
  return { pool, received, send, close };
}

test('a lost binding must never route the same compact conversation to B', async () => {
  const r = await rig();
  try {
    assert.equal(await r.send('audit-lost'), 200);
    assert.deepEqual(r.received, ['Bearer fake-a']);
    await rm(paths().sessions);
    r.pool.accounts[0]!.enabled = false;
    await r.send('audit-lost');
    assert.deepEqual(r.received, ['Bearer fake-a'], 'lost binding must fail closed instead of rebinding to B');
  } finally { r.close(); }
});

test('an explicit account path cannot bypass an established conversation binding', async () => {
  const r = await rig();
  try {
    assert.equal(await r.send('audit-explicit'), 200);
    await r.send('audit-explicit', '/tc-acct/b/claude/v1/messages');
    assert.deepEqual(r.received, ['Bearer fake-a'], 'B must receive zero requests even on account-specific path');
  } finally { r.close(); }
});

test('conflicting canonical headers must fail before either account receives a request', async () => {
  const r = await rig();
  try {
    await r.send('audit-one', '/v1/messages', { 'session-id': 'audit-two' });
    assert.deepEqual(r.received, [], 'both supplied canonical headers must agree');
  } finally { r.close(); }
});

test('a client account UUID is not evidence of the first upstream account for an unknown resumed conversation', async () => {
  const r = await rig();
  try {
    await r.send('audit-unknown-history', '/v1/messages', {}, { metadata: { user_id: JSON.stringify({ session_id: 'audit-unknown-history', account_uuid: 'uuid-b' }) }, messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'earlier reply' }, { role: 'user', content: 'next' }] });
    assert.deepEqual(r.received, [], 'unknown history cannot establish provenance from client metadata');
  } finally { r.close(); }
});

test('replacing credentials on a stored logical account cannot change the actual account of a bound conversation', async () => {
  const r = await rig();
  try {
    assert.equal(await r.send('audit-replaced-credential'), 200);
    r.pool.accounts[0]!.credential = { ...r.pool.accounts[0]!.credential, accountId: 'uuid-b', accessToken: 'fake-b' };
    await r.send('audit-replaced-credential');
    assert.deepEqual(r.received, ['Bearer fake-a'], 'logical id reuse must not change the actual bound account');
  } finally { r.close(); }
});

test('G123: restart plus deleted entry must not rebind a compact resumed conversation to B', async () => {
  const first = await rig();
  try {
    assert.equal(await first.send('g123-keep'), 200);
    assert.equal(await first.send('g123-lost'), 200);
    assert.deepEqual(first.received, ['Bearer fake-a', 'Bearer fake-a']);
  } finally { first.close(); }
  const { readFile, writeFile } = await import('node:fs/promises');
  const stored = JSON.parse(await readFile(paths().sessions, 'utf8'));
  delete stored['g123-lost'];
  await writeFile(paths().sessions, JSON.stringify(stored));
  const second = await rig();
  try {
    second.pool.accounts[0]!.enabled = false;
    await second.send('g123-lost');
    assert.deepEqual(second.received, [], 'restarted relay must not route a known-but-deleted conversation to B');
  } finally { second.close(); }
});

