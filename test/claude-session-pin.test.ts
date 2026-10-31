import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { createProxy } from '../src/proxy.js';
import { claudeProvider, codexProvider } from '../src/providers.js';
import { parseRoutes } from '../src/routes.js';
import { issueClaudeSession, paths, updateSessions } from '../src/storage.js';
import type { OAuthCredential, PersistedState, Provider, StoredAccount } from '../src/types.js';

interface FakeUpstreamOptions {
  onA?: (n: number, req: IncomingMessage, res: ServerResponse) => boolean | void;
  onB?: (n: number, req: IncomingMessage, res: ServerResponse) => boolean | void;
}

async function createClaudeRig(options: FakeUpstreamOptions = {}, poolOptions: { priorityA?: number | null; priorityB?: number | null; maxConcurrent?: number } = {}) {
  const hitsA: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const hitsB: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];

  const upstream = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    await new Promise<void>((resolve) => req.once('end', resolve));
    const body = Buffer.concat(parts).toString('utf8');
    const auth = String(req.headers.authorization || '');
    const account = auth.includes('token-a') ? 'a' : auth.includes('token-b') ? 'b' : 'unknown';

    if (account === 'a') {
      hitsA.push({ path: req.url || '', headers: req.headers, body });
      if (options.onA && options.onA(hitsA.length, req, res)) return;
    } else if (account === 'b') {
      hitsB.push({ path: req.url || '', headers: req.headers, body });
      if (options.onB && options.onB(hitsB.length, req, res)) return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_ok', content: [{ type: 'text', text: 'ok' }] }));
  });

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upAddr = upstream.address();
  assert(upAddr && typeof upAddr !== 'string');

  const provider: Provider = {
    ...claudeProvider,
    upstreamBase: `http://127.0.0.1:${upAddr.port}`,
    readQuota: () => null,
    refresh: async (c) => c,
  };

  const storedA: StoredAccount = { id: 'a', provider: 'claude', label: 'acc-a', enabled: true, priority: poolOptions.priorityA !== undefined ? poolOptions.priorityA : 1, credentialId: 'claude:a', createdAt: '' };
  const storedB: StoredAccount = { id: 'b', provider: 'claude', label: 'acc-b', enabled: true, priority: poolOptions.priorityB !== undefined ? poolOptions.priorityB : 2, credentialId: 'claude:b', createdAt: '' };
  const creds: Record<string, OAuthCredential> = {
    'claude:a': { accessToken: 'token-a', refreshToken: 'ref-a', expiresAt: Date.now() + 3600_000, accountId: 'uuid-a' },
    'claude:b': { accessToken: 'token-b', refreshToken: 'ref-b', expiresAt: Date.now() + 3600_000, accountId: 'uuid-b' },
  };
  const state: PersistedState = { version: 1, accounts: {} };

  const pool = new AccountPool(provider, [storedA, storedB], creds, state, 0.98, poolOptions.maxConcurrent ?? 16);
  const events: string[] = [];
  const proxy = createProxy(pool, 'test-secret', (e) => { if (e) events.push(e); });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddr = proxy.address();
  assert(proxyAddr && typeof proxyAddr !== 'string');

  const send = (headers: Record<string, string>, bodyObj: unknown = { messages: [{ role: 'user', content: 'hello' }] }) => {
    return fetch(`http://127.0.0.1:${proxyAddr.port}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json', ...headers },
      body: typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj),
    });
  };

  const close = () => {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    proxy.close();
    upstream.close();
  };

  return { pool, hitsA, hitsB, events, send, close, provider, creds, port: proxyAddr.port };
}

test.beforeEach(async () => {
  await rm(paths().sessions, { force: true });
});

test.afterEach(async () => {
  await rm(paths().sessions, { force: true });
});

test('1. quota 429: account A quota error is returned to client, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig({
    onA: (n, _req, res) => {
      if (n === 2) {
        res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'retry-after': '60' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'account A quota exhausted' } }));
        return true;
      }
    },
  });
  try {
    const res1 = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res1.status, 200);
    assert.equal(rig.hitsA.length, 1);
    assert.equal(rig.hitsB.length, 0);

    const res2 = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res2.status, 429);
    assert.equal(rig.hitsA.length, 2);
    assert.equal(rig.hitsB.length, 0, 'account B must receive 0 requests on account A quota');

    const res3 = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res3.status, 429);
    assert.equal(rig.hitsB.length, 0, 'subsequent requests for pinned session must not failover to B');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('2. initial request quota 429: first request on account A returns 429, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig({
    onA: (_n, _req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'retry-after': '30' });
      res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'quota exceeded on first turn' } }));
      return true;
    },
  });
  try {
    const res = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res.status, 429);
    assert.equal(rig.hitsA.length, 1);
    assert.equal(rig.hitsB.length, 0, 'first turn quota rejection must never re-request on account B');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('3. auth refresh failure: refresh error on account A fails closed, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig({
    onA: (_n, _req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid token' } }));
      return true;
    },
  });
  rig.provider.refresh = async () => { throw new Error('OAuth token revoked'); };
  try {
    const res = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res.status, 401);
    assert.equal(rig.hitsA.length, 1);
    assert.equal(rig.hitsB.length, 0, 'account B must receive 0 requests when A auth refresh fails');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('4. 403 forbidden: upstream 403 on account A returns 403, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig({
    onA: (_n, _req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'permission_error', message: 'forbidden account' } }));
      return true;
    },
  });
  try {
    const res = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res.status, 403);
    assert.equal(rig.hitsA.length, 1);
    assert.equal(rig.hitsB.length, 0, 'account B must receive 0 requests on 403');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('5. 5xx and network errors: retried on account A only, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  let attempts = 0;
  const rig = await createClaudeRig({
    onA: (_n, _req, res) => {
      attempts++;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'api_error', message: 'internal server error' } }));
      return true;
    },
  });
  try {
    const res = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res.status, 500);
    assert.ok(attempts > 1, '500 error retried on account A');
    assert.equal(rig.hitsA.length, attempts);
    assert.equal(rig.hitsB.length, 0, 'account B must receive 0 requests on 5xx errors');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('5b. upstream socket destruction and connection failure retried on account A only, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  let attempts = 0;
  const rig = await createClaudeRig({
    onA: (_n, req, res) => {
      attempts++;
      if (attempts <= 2) {
        req.destroy(new Error('simulated upstream socket cut'));
        res.destroy();
        return true;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_recovered', content: [{ type: 'text', text: 'recovered' }] }));
      return true;
    },
  });
  try {
    const res = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res.status, 200);
    assert.ok(attempts > 1, 'socket error retried on account A');
    assert.equal(rig.hitsB.length, 0, 'account B must receive 0 requests on network socket errors');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('6. busy concurrency cap: when account A is at max concurrent capacity, returns 429 without calling B', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig({}, { maxConcurrent: 1 });
  try {
    const accA = rig.pool.accounts.find((a) => a.id === 'a')!;
    accA.inflight = 1;
    await updateSessions(async (b) => {
      b[sessionId] = { sessionId, provider: 'claude', accountId: 'a', credentialId: 'claude:a', actualAccountId: 'uuid-a', boundAt: Date.now() };
    });

    const res = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('x-teamai-429-reason'), 'concurrency_saturated');
    assert.equal(rig.hitsA.length, 0);
    assert.equal(rig.hitsB.length, 0, 'account B must receive 0 requests when A is busy');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('7. disabled and removed account: bound session fails closed with 503, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig();
  try {
    const res1 = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res1.status, 200);
    assert.equal(rig.hitsA.length, 1);
    assert.equal(rig.hitsB.length, 0);

    const accA = rig.pool.accounts.find((a) => a.id === 'a')!;
    accA.enabled = false;

    const res2 = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res2.status, 503);
    assert.equal(rig.hitsB.length, 0, 'account B must receive 0 requests when pinned account is disabled');

    accA.retired = true;
    const res3 = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res3.status, 503);
    assert.equal(rig.hitsB.length, 0, 'account B must receive 0 requests when pinned account is retired/removed');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('8. model and route changes do not divert session from account A, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig();
  try {
    const res1 = await rig.send({ 'x-claude-code-session-id': sessionId }, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'step 1' }] });
    assert.equal(res1.status, 200);
    assert.equal(rig.hitsA.length, 1);
    assert.equal(rig.hitsB.length, 0);

    rig.pool.setRoutes(parseRoutes([{ name: 'prefer-b', match: ['claude-opus-*'], accounts: ['b'], mode: 'prefer' }], 'claude'));
    const res2 = await rig.send({ 'x-claude-code-session-id': sessionId }, { model: 'claude-opus-4', messages: [{ role: 'user', content: 'step 2' }] });
    assert.equal(res2.status, 200);
    assert.equal(rig.hitsA.length, 2);
    assert.equal(rig.hitsB.length, 0, 'route preference for B must not divert existing pinned session');

    rig.pool.setRoutes(parseRoutes([{ name: 'exclusive-b', match: ['*'], accounts: ['b'], mode: 'exclusive' }], 'claude'));
    const res3 = await rig.send({ 'x-claude-code-session-id': sessionId }, { model: 'claude-haiku-4', messages: [{ role: 'user', content: 'step 3' }] });
    assert.equal(res3.status, 200);
    assert.equal(rig.hitsA.length, 3);
    assert.equal(rig.hitsB.length, 0, 'route exclusive mode must not divert existing pinned session');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('9. concurrent initial requests for same session atomically bind to one account, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig();
  try {
    const requests = Array.from({ length: 6 }, (_, i) =>
      rig.send({ 'x-claude-code-session-id': sessionId }, { messages: [{ role: 'user', content: `concurrent ${i}` }] })
    );
    const results = await Promise.all(requests);
    for (const r of results) assert.equal(r.status, 200);

    assert.equal(rig.hitsA.length, 6, 'all concurrent initial requests must bind to account A');
    assert.equal(rig.hitsB.length, 0, 'account B must receive 0 requests');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('10. stream cut mid-response releases slot and is not retried on account B', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig({
    onA: (n, _req, res) => {
      if (n === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {}\n\n');
        setTimeout(() => res.destroy(new Error('upstream socket cut')), 30);
        return true;
      }
    },
  });
  try {
    const res = await rig.send({ 'x-claude-code-session-id': sessionId });
    await res.text().catch(() => {});
    assert.equal(rig.hitsA.length, 1);
    assert.equal(rig.hitsB.length, 0, 'mid-stream break must never replay on account B');
    assert.equal(rig.pool.accounts[0]!.inflight, 0, 'account inflight counter must be 0 after cut');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('11. reconnect and relay restart restores persistent binding from disk, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig();
  try {
    const res1 = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res1.status, 200);
    assert.equal(rig.hitsA.length, 1);
    assert.equal(rig.hitsB.length, 0);

    // Stop proxy
    rig.close();

    // Start fresh proxy referencing the same persisted sessions.json in TEAMAI_HOME
    // Construct a brand new AccountPool instance so in-memory state is empty and bindings must be restored from disk
    const storedA: StoredAccount = { id: 'a', provider: 'claude', label: 'acc-a', enabled: true, priority: 1, credentialId: 'claude:a', createdAt: '' };
    const storedB: StoredAccount = { id: 'b', provider: 'claude', label: 'acc-b', enabled: true, priority: 2, credentialId: 'claude:b', createdAt: '' };
    const pool2 = new AccountPool(rig.provider, [storedA, storedB], rig.creds, { version: 1, accounts: {} }, 0.98, 16);
    const proxy2 = createProxy(pool2, 'test-secret', () => {});
    await new Promise<void>((r) => proxy2.listen(0, '127.0.0.1', r));
    const p2Addr = proxy2.address();
    assert(p2Addr && typeof p2Addr !== 'string');

    // Also restart upstream
    const hitsA2: string[] = [];
    const hitsB2: string[] = [];
    const upstream2 = createServer(async (req, res) => {
      const auth = String(req.headers.authorization || '');
      if (auth.includes('token-a')) hitsA2.push('a');
      else if (auth.includes('token-b')) hitsB2.push('b');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_2', content: [] }));
    });
    await new Promise<void>((r) => upstream2.listen(0, '127.0.0.1', r));
    const up2Addr = upstream2.address();
    assert(up2Addr && typeof up2Addr !== 'string');
    rig.pool.provider.upstreamBase = `http://127.0.0.1:${up2Addr.port}`;

    try {
      const res2 = await fetch(`http://127.0.0.1:${p2Addr.port}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json', 'x-claude-code-session-id': sessionId },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'turn 2' }] }),
      });
      assert.equal(res2.status, 200);
      assert.equal(hitsA2.length, 1, 'turn 2 after restart must route to account A');
      assert.equal(hitsB2.length, 0, 'account B must receive 0 requests after relay restart');
    } finally {
      proxy2.closeAllConnections();
      upstream2.closeAllConnections();
      proxy2.close();
      upstream2.close();
    }
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('12. unproven resumed session with conversation history is rejected with 409, account B receives 0 requests', async () => {
  const rig = await createClaudeRig();
  try {
    const multiMessageHistory = {
      messages: [
        { role: 'user', content: 'what is 2+2?' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'add 1' },
      ],
    };
    const res = await rig.send({ 'x-claude-code-session-id': 'sess-unproven-history' }, multiMessageHistory);
    assert.equal(res.status, 409);
    assert.equal(rig.hitsA.length, 0);
    assert.equal(rig.hitsB.length, 0, 'unproven session with history must not be routed to any account');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('13. conflicting session ID between header and metadata is rejected with 400, account B receives 0 requests', async () => {
  const rig = await createClaudeRig();
  try {
    const bodyWithConflictingSession = {
      metadata: {
        user_id: JSON.stringify({ device_id: 'dev1', account_uuid: 'uuid-a', session_id: 'sess-metadata-id' }),
      },
      messages: [{ role: 'user', content: 'test' }],
    };
    const res = await rig.send({ 'x-claude-code-session-id': 'sess-header-id' }, bodyWithConflictingSession);
    assert.equal(res.status, 400);
    assert.equal(rig.hitsA.length, 0);
    assert.equal(rig.hitsB.length, 0, 'conflicting session IDs must reject with 400 without upstream calls');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('14. missing canonical session ID is rejected with 400, account B receives 0 requests', async () => {
  const rig = await createClaudeRig();
  try {
    const res = await fetch(`http://127.0.0.1:${rig.port}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
    });
    assert.equal(res.status, 400);
    assert.equal(rig.hitsA.length, 0);
    assert.equal(rig.hitsB.length, 0, 'missing session identifier must reject with 400');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('15. session ID longer than 200 chars is not truncated and avoids collision', async () => {
  const rig = await createClaudeRig();
  try {
    const prefix = 'x'.repeat(200);
    const id1 = `${prefix}-one`;
    const id2 = `${prefix}-two`;

    // Existing full-length bindings remain distinct when resumed.
    await issueClaudeSession();
    const { dirname, join } = await import('node:path');
    await writeFile(paths().sessions, JSON.stringify(Object.fromEntries([id1, id2].map((id) => [id, { sessionId: id, provider: 'claude', accountId: 'a', credentialId: 'claude:a', actualAccountId: 'uuid-a', boundAt: Date.now() }]))));
    await writeFile(join(dirname(paths().sessions), '.sessions-ledger.json'), JSON.stringify([id1, id2]));

    const res1 = await rig.send({ 'x-claude-code-session-id': id1 });
    assert.equal(res1.status, 200);

    const res2 = await rig.send({ 'x-claude-code-session-id': id2 });
    assert.equal(res2.status, 200);

    // Verify both IDs exist separately in sessions.json
    const { loadSessions } = await import('../src/storage.js');
    const bindings = await loadSessions();
    assert.ok(bindings[id1], 'id1 must be bound under its full untruncated name');
    assert.ok(bindings[id2], 'id2 must be bound under its full untruncated name');
    assert.notEqual(id1, id2);
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('16. corrupt session bindings file triggers strict fail-closed with 500, account B receives 0 requests', async () => {
  const rig = await createClaudeRig();
  try {
    // Write corrupted JSON to sessions.json
    await writeFile(paths().sessions, '{ corrupt json invalid', 'utf8');

    const res = await rig.send({ 'x-claude-code-session-id': 'sess-corrupt-file' });
    assert.equal(res.status, 500);
    assert.equal(rig.hitsA.length, 0);
    assert.equal(rig.hitsB.length, 0, 'corrupt bindings must fail closed without calling upstream accounts');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('17. new sessions are distributed to different accounts and each remains pinned', async () => {
  const sessionA = await issueClaudeSession();
  const sessionB = await issueClaudeSession();
  // Account A and B have equal priority; A takes session 1, B takes session 2
  const rig = await createClaudeRig({}, { priorityA: null, priorityB: null });
  const accA = rig.pool.accounts.find((a) => a.id === 'a')!;
  const accB = rig.pool.accounts.find((a) => a.id === 'b')!;
  accA.usage = 0.1;
  accB.usage = 0.1;
  try {
    const res1 = await rig.send({ 'x-claude-code-session-id': sessionA }, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'first alpha' }] });
    assert.equal(res1.status, 200);

    // Give account A 50% usage and account B 10% usage so B wins the next initial pick
    accA.usage = 0.5;
    accB.usage = 0.1;

    const res2 = await rig.send({ 'x-claude-code-session-id': sessionB }, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'first beta' }] });
    assert.equal(res2.status, 200);

    assert.equal(rig.hitsA.length, 1);
    assert.equal(rig.hitsB.length, 1);

    // Turn 2 of session alpha goes to A
    await rig.send({ 'x-claude-code-session-id': sessionA }, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'second alpha' }] });
    assert.equal(rig.hitsA.length, 2);
    assert.equal(rig.hitsB.length, 1);

    // Turn 2 of session beta goes to B
    await rig.send({ 'x-claude-code-session-id': sessionB }, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'second beta' }] });
    assert.equal(rig.hitsA.length, 2);
    assert.equal(rig.hitsB.length, 2);
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('18. Codex regression: Codex still fails over to next account on quota 429', async () => {
  const hits: string[] = [];
  const upstream = createServer(async (req, res) => {
    const auth = String(req.headers.authorization || '');
    const account = auth.includes('token-a') ? 'a' : 'b';
    hits.push(account);
    req.resume();
    await new Promise<void>((r) => req.once('end', r));
    if (account === 'a') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end('{"code":"usage_limit_reached"}');
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"response.completed"}\n\n');
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upAddr = upstream.address();
  assert(upAddr && typeof upAddr !== 'string');

  const provider: Provider = {
    ...codexProvider,
    upstreamBase: `http://127.0.0.1:${upAddr.port}`,
    readQuota: () => null,
    refresh: async (c) => c,
  };
  const stored = (id: string, priority: number): StoredAccount => ({ id, provider: 'codex', label: id, enabled: true, priority, credentialId: id, createdAt: '' });
  const pool = new AccountPool(provider, [stored('a', 1), stored('b', 2)], {
    a: { accessToken: 'token-a', refreshToken: null, expiresAt: null, accountId: 'a' },
    b: { accessToken: 'token-b', refreshToken: null, expiresAt: null, accountId: 'b' },
  }, { version: 1, accounts: {} });

  const proxy = createProxy(pool, 'test-secret', () => {});
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyAddr = proxy.address();
  assert(proxyAddr && typeof proxyAddr !== 'string');

  try {
    const res = await fetch(`http://127.0.0.1:${proxyAddr.port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(hits, ['a', 'b'], 'Codex must continue to fail over to next account on quota');
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    proxy.close();
    upstream.close();
  }
});

test('19. legacy/corrupt binding missing credentialId or actualAccountId fails closed, account B receives 0 requests', async () => {
  const rig = await createClaudeRig();
  try {
    // Write a session binding directly that lacks actualAccountId (or credentialId)
    await writeFile(paths().sessions, JSON.stringify({
      'sess-missing-identity': {
        sessionId: 'sess-missing-identity',
        provider: 'claude',
        accountId: 'a',
        boundAt: Date.now(),
      },
    }, null, 2), 'utf8');

    const res = await rig.send({ 'x-claude-code-session-id': 'sess-missing-identity' });
    assert.equal(res.status, 500);
    assert.equal(rig.hitsA.length, 0);
    assert.equal(rig.hitsB.length, 0, 'missing credential identity must fail closed without calling upstream');
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('20. concurrent initial session requests across independent AccountPool instances bind to account A under lock, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig();
  try {
    // Create a second pool and proxy sharing the same underlying disk storage (TEAMAI_HOME)
    const storedA: StoredAccount = { id: 'a', provider: 'claude', label: 'acc-a', enabled: true, priority: 1, credentialId: 'claude:a', createdAt: '' };
    const storedB: StoredAccount = { id: 'b', provider: 'claude', label: 'acc-b', enabled: true, priority: 2, credentialId: 'claude:b', createdAt: '' };
    const pool2 = new AccountPool(rig.provider, [storedA, storedB], rig.creds, { version: 1, accounts: {} }, 0.98, 16);
    const proxy2 = createProxy(pool2, 'test-secret', () => {});
    await new Promise<void>((r) => proxy2.listen(0, '127.0.0.1', r));
    const p2Addr = proxy2.address();
    assert(p2Addr && typeof p2Addr !== 'string');

    try {
      const sendPool1 = () => rig.send({ 'x-claude-code-session-id': sessionId }, { messages: [{ role: 'user', content: 'req-pool1' }] });
      const sendPool2 = () => fetch(`http://127.0.0.1:${p2Addr.port}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json', 'x-claude-code-session-id': sessionId },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'req-pool2' }] }),
      });

      const [res1, res2] = await Promise.all([sendPool1(), sendPool2()]);
      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      assert.equal(rig.hitsA.length, 2, 'both independent instances must resolve to account A');
      assert.equal(rig.hitsB.length, 0, 'account B must receive 0 requests');
    } finally {
      proxy2.closeAllConnections();
      proxy2.close();
    }
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});

test('21. deleted sessions.json before a fresh relay restart is recognized as lost file and fails closed, account B receives 0 requests', async () => {
  const sessionId = await issueClaudeSession();
  const rig = await createClaudeRig();
  try {
    const res1 = await rig.send({ 'x-claude-code-session-id': sessionId });
    assert.equal(res1.status, 200);
    assert.equal(rig.hitsA.length, 1);
    assert.equal(rig.hitsB.length, 0);

    rig.close();

    // Delete sessions.json while .sessions-created marker remains
    await rm(paths().sessions);

    // Restart with brand new pool and proxy
    const storedA: StoredAccount = { id: 'a', provider: 'claude', label: 'acc-a', enabled: true, priority: 1, credentialId: 'claude:a', createdAt: '' };
    const storedB: StoredAccount = { id: 'b', provider: 'claude', label: 'acc-b', enabled: true, priority: 2, credentialId: 'claude:b', createdAt: '' };
    const poolRestarted = new AccountPool(rig.provider, [storedA, storedB], rig.creds, { version: 1, accounts: {} }, 0.98, 16);
    const proxyRestarted = createProxy(poolRestarted, 'test-secret', () => {});
    await new Promise<void>((r) => proxyRestarted.listen(0, '127.0.0.1', r));
    const pAddr = proxyRestarted.address();
    assert(pAddr && typeof pAddr !== 'string');

    try {
      const res2 = await fetch(`http://127.0.0.1:${pAddr.port}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json', 'x-claude-code-session-id': sessionId },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'turn 2 after deleted sessions' }] }),
      });
      assert.equal(res2.status, 500);
      assert.equal(rig.hitsA.length, 1);
      assert.equal(rig.hitsB.length, 0, 'lost sessions file across restart must fail closed without calling account B');
    } finally {
      proxyRestarted.closeAllConnections();
      proxyRestarted.close();
    }
  } finally {
    rig.close();
    await rm(paths().sessions, { force: true });
  }
});
