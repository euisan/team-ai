import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { createProxy, DEFAULT_MAX_BODY_MB, maxBodyBytes } from '../src/proxy.js';
import { defaultConfig } from '../src/storage.js';
import type { Provider, StoredAccount } from '../src/types.js';

const MB = 1024 * 1024;

// A relay with two synthetic accounts in front of a local upstream that counts
// what it receives. Every token here is made up.
async function rig(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void, bodyLimit?: number) {
  const received: number[] = [];
  const upstream = createServer((req, res) => {
    const parts: Buffer[] = []; req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => { const body = Buffer.concat(parts); received.push(body.length); handler(req, res, body); });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: `http://127.0.0.1:${up.port}`,
    normalizePath: () => '/codex/responses', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (incoming, account) => { const h = new Headers(incoming); h.set('authorization', `Bearer ${account.credential.accessToken}`); return h; },
    classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }),
  };
  const stored = ['a', 'b'].map((id, i): StoredAccount => ({ id, provider: 'codex', label: `${id}@example.com`, enabled: true, priority: i + 1, credentialId: id, createdAt: '' }));
  const credentials = Object.fromEntries(['a', 'b'].map((id) => [id, { accessToken: `synthetic-${id}`, refreshToken: null, expiresAt: null, accountId: id }]));
  const pool = new AccountPool(provider, stored, credentials, { version: 1, accounts: {} });
  const events: string[] = [];
  const proxy = createProxy(pool, 'local-secret', (event) => { if (event) events.push(event); }, undefined, undefined, bodyLimit);
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  const url = `http://127.0.0.1:${pa.port}/v1/responses`;
  const headers = { authorization: 'Bearer local-secret', 'content-type': 'application/json' };
  const call = (body: string) => fetch(url, { method: 'POST', headers, body });
  // No content-length: the size is only known once the upload ends.
  const callChunked = (chunks: string[]) => fetch(url, { method: 'POST', headers, duplex: 'half', body: new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close(); } }) } as RequestInit);
  const close = () => { proxy.close(); upstream.close(); proxy.closeAllConnections(); upstream.closeAllConnections(); };
  return { received, events, call, callChunked, close };
}

const ok = (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };
// A body of exactly n bytes that a log line could be caught quoting.
const bodyOf = (n: number) => { const head = '{"input":"MARKER-'; return head + 'x'.repeat(n - head.length - 2) + '"}'; };

test('a body at the limit is relayed whole; one byte over is a 413 that names the size and the limit', async () => {
  const r = await rig(ok, 1 * MB);
  try {
    const fits = await r.call(bodyOf(MB));
    assert.equal(fits.status, 200); await fits.text();
    assert.deepEqual(r.received, [MB], 'upstream got every byte');
    const over = await r.call(bodyOf(MB + 1));
    assert.equal(over.status, 413);
    assert.equal(over.headers.get('x-teamai-413-reason'), 'body_limit');
    const answer = await over.json() as { error: { type: string; message: string } };
    assert.equal(answer.error.type, 'request_too_large');
    assert.match(answer.error.message, /1048577 bytes/); assert.match(answer.error.message, /1048576 bytes/); assert.match(answer.error.message, /proxy\.maxBodyMb/);
    assert.deepEqual(r.received, [MB], 'the oversized body never went upstream');
    const line = r.events.find((e) => / 413 /.test(e));
    assert.ok(line, r.events.join(' | '));
    assert.match(line, /request body 1\.0 MB \(1048577 bytes\) exceeds proxy\.maxBodyMb 1\.0 MB \(1048576 bytes\)/);
    assert.equal(r.events.some((e) => e.includes('MARKER')), false, 'no body content in the log');
  } finally { r.close(); }
});

test('a chunked upload over the limit is counted to its end, so the 413 has its real size', async () => {
  const r = await rig(ok, 1 * MB);
  try {
    const res = await r.callChunked(Array.from({ length: 3 }, () => 'y'.repeat(MB)));
    assert.equal(res.status, 413); await res.text();
    assert.ok(r.events.some((e) => /request body 3\.0 MB \(3145728 bytes\) exceeds/.test(e)), r.events.join(' | '));
    assert.deepEqual(r.received, []);
  } finally { r.close(); }
});

test('without a configured limit the relay takes the 512 MB default, well past the old 32 MB', async () => {
  assert.equal(DEFAULT_MAX_BODY_MB, 512);
  assert.equal(maxBodyBytes(undefined), 512 * MB);
  const r = await rig(ok);
  try {
    const res = await r.call(bodyOf(33 * MB));
    assert.equal(res.status, 200); await res.text();
    assert.deepEqual(r.received, [33 * MB]);
  } finally { r.close(); }
});

test('proxy.maxBodyMb is read as megabytes', () => {
  assert.equal(maxBodyBytes(1), MB);
  assert.equal(maxBodyBytes(64), 64 * MB);
  assert.equal(maxBodyBytes(0.5), MB / 2);
  assert.equal(maxBodyBytes(4096), 4096 * MB);
});

test('an invalid proxy.maxBodyMb is refused with the reason', () => {
  for (const bad of [0, -1, 4097, Number.NaN, Number.POSITIVE_INFINITY, '256', null, true, [256]]) {
    assert.throws(() => maxBodyBytes(bad), /proxy\.maxBodyMb must be a number of megabytes above 0 and at most 4096/, String(bad));
  }
});

test('the server refuses to start on an invalid proxy.maxBodyMb, before anything listens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamai-body-limit-'));
  const previous = process.env.TEAMAI_HOME; process.env.TEAMAI_HOME = root;
  try {
    const config = defaultConfig(); config.proxy.maxBodyMb = 0;
    await writeFile(join(root, 'config.json'), JSON.stringify(config));
    const { runServer } = await import('../src/runtime.js');
    // No accounts either: the limit is reported first, by name.
    await assert.rejects(runServer(), /proxy\.maxBodyMb must be a number of megabytes above 0 and at most 4096, not 0/);
  } finally {
    if (previous === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("upstream's own 413 reaches the client as it was sent, and is not retried on another account", async () => {
  const upstreamBody = '{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}';
  const r = await rig((_req, res) => { res.writeHead(413, { 'content-type': 'application/json', 'x-upstream-marker': 'yes' }); res.end(upstreamBody); }, 64 * MB);
  try {
    const res = await r.call(bodyOf(2 * MB));
    assert.equal(res.status, 413);
    assert.equal(await res.text(), upstreamBody);
    assert.equal(res.headers.get('x-upstream-marker'), 'yes');
    assert.equal(res.headers.get('x-teamai-413-reason'), null, 'not the relay\'s own 413');
    assert.deepEqual(r.received, [2 * MB], 'one account tried, once');
  } finally { r.close(); }
});
