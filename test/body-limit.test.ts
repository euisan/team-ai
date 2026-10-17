import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { BodyBudget, bodyTimeoutMs, createProxy, DEFAULT_BODY_TIMEOUT_MS, DEFAULT_MAX_BODY_MB, DEFAULT_MAX_INFLIGHT_BODY_MB, maxBodyBytes, maxInflightBodyBytes, type BodyOptions } from '../src/proxy.js';
import { defaultConfig } from '../src/storage.js';
import type { Provider, StoredAccount } from '../src/types.js';

const MB = 1024 * 1024;

// A relay with two synthetic accounts in front of a local upstream that counts
// what it receives. Every token here is made up.
async function rig(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void, bodyLimit?: number | BodyOptions) {
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
  return { received, events, call, callChunked, close, port: pa.port };
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

// A raw upload that sends `first` bytes now and holds the rest back until
// finish() is called (or never). Resolves the response whenever it comes.
function upload(port: number, total: number, first: number) {
  const req = request({ host: '127.0.0.1', port, path: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json', 'content-length': total } });
  const response = new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
    req.on('response', (res) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(parts).toString() })); });
    req.on('error', reject);
  });
  req.write(Buffer.alloc(first, 'a'));
  return { response, finish: () => req.end(Buffer.alloc(total - first, 'a')), abort: () => req.destroy() };
}
const until = async (check: () => boolean, ms = 3_000): Promise<void> => { const deadline = Date.now() + ms; while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5)); assert.ok(check(), 'condition not reached in time'); };

test('bodies held in flight share one budget: past it a request is turned away with a 429 that says so, and the budget comes back', async () => {
  const budget = new BodyBudget(3 * MB);
  let release: () => void = () => {}; const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const r = await rig((_req, res) => { calls++; void (calls === 1 ? gate : Promise.resolve()).then(() => ok(_req, res)); }, { limit: 2 * MB, budget });
  try {
    // The first request holds 2 MB while upstream sits on it.
    const first = r.call(bodyOf(2 * MB));
    await until(() => r.received.length === 1);
    assert.equal(budget.used, 2 * MB);
    // The second does not fit in the remaining 1 MB.
    const second = await r.call(bodyOf(2 * MB));
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('x-teamai-429-reason'), 'body_budget');
    assert.equal(second.headers.get('retry-after'), '5');
    const answer = await second.json() as { error: { type: string; message: string } };
    assert.equal(answer.error.type, 'body_budget_exhausted');
    assert.match(answer.error.message, /proxy\.maxInflightBodyMb/); assert.match(answer.error.message, /3145728 bytes/);
    assert.deepEqual(r.received, [2 * MB], 'the refused body never went upstream');
    assert.equal(budget.used, 2 * MB, 'the refused request gave back what it took');
    const line = r.events.find((e) => / 429 body_budget /.test(e));
    assert.ok(line, r.events.join(' | ')); assert.equal(line.includes('MARKER'), false);
    // A small one still fits beside it.
    const small = await r.call(bodyOf(MB / 2)); assert.equal(small.status, 200); await small.text();
    release();
    assert.equal((await first).status, 200);
    await until(() => budget.used === 0);
    // Once the first is done the same 2 MB fits again.
    const again = await r.call(bodyOf(2 * MB)); assert.equal(again.status, 200); await again.text();
    await until(() => budget.used === 0);
  } finally { release(); r.close(); }
});

test('a body still uploading counts against the budget, and gives it back when the upload is abandoned', async () => {
  const budget = new BodyBudget(1 * MB);
  const r = await rig(ok, { limit: MB, budget });
  try {
    const slow = upload(r.port, MB, 3 * MB / 4);
    slow.response.catch(() => {});
    await until(() => budget.used === 3 * MB / 4);
    // Declared too big for what is left: refused at once, before its body.
    const refused = upload(r.port, MB / 2, 0); refused.finish();
    const answer = await refused.response;
    assert.equal(answer.status, 429); assert.equal(answer.headers['x-teamai-429-reason'], 'body_budget');
    slow.abort();
    await until(() => budget.used === 0);
  } finally { r.close(); }
});

test('an over-limit body and a failed upstream give back their budget', async () => {
  const budget = new BodyBudget(4 * MB);
  const r = await rig((_req, res) => { res.writeHead(500); res.end('{}'); }, { limit: MB, budget });
  try {
    const over = await r.call(bodyOf(2 * MB)); assert.equal(over.status, 413); await over.text();
    assert.equal(budget.used, 0);
    const failed = await r.call(bodyOf(MB / 2)); assert.equal(failed.status, 500); await failed.text();
    await until(() => budget.used === 0);
  } finally { r.close(); }
});

test('proxy.maxInflightBodyMb: 1024 MB by default, never below proxy.maxBodyMb, and refused when invalid', () => {
  assert.equal(DEFAULT_MAX_INFLIGHT_BODY_MB, 1024);
  assert.equal(maxInflightBodyBytes(undefined, 512 * MB), 1024 * MB);
  // A raised maxBodyMb with no budget set raises the default with it, so one
  // body that the limit allows always fits.
  assert.equal(maxInflightBodyBytes(undefined, 2048 * MB), 2048 * MB);
  assert.equal(maxInflightBodyBytes(600, 512 * MB), 600 * MB);
  assert.throws(() => maxInflightBodyBytes(256, 512 * MB), /proxy\.maxInflightBodyMb \(256\) must be at least proxy\.maxBodyMb \(512\)/);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1024', null, 65537]) {
    assert.throws(() => maxInflightBodyBytes(bad, MB), /proxy\.maxInflightBodyMb must be a number of megabytes above 0 and at most 65536/, String(bad));
  }
});

test('a body over 32 MB that is relayed leaves its size in the log, never its content', async () => {
  const r = await rig(ok, 64 * MB);
  try {
    const small = await r.call(bodyOf(32 * MB)); assert.equal(small.status, 200); await small.text();
    assert.equal(r.events.some((e) => /large request body/.test(e)), false, '32 MB is not large');
    const large = await r.call(bodyOf(33 * MB)); assert.equal(large.status, 200); await large.text();
    const line = r.events.find((e) => /large request body/.test(e));
    assert.ok(line, r.events.join(' | '));
    assert.match(line, /Codex POST \/codex\/responses large request body 33\.0 MB \(34603008 bytes\)/);
    assert.equal(line.includes('MARKER'), false);
  } finally { r.close(); }
});

test('an upload that stalls is cut at the body time limit with a 408 that says so, and gives back its budget', async () => {
  const budget = new BodyBudget(4 * MB);
  const r = await rig(ok, { limit: 2 * MB, budget, timeoutMs: 300 });
  try {
    const started = Date.now();
    const slow = upload(r.port, 2 * MB, MB);
    const res = await slow.response;
    assert.ok(Date.now() - started >= 250, 'not before the limit');
    assert.equal(res.status, 408);
    assert.equal(res.headers['x-teamai-408-reason'], 'body_timeout');
    const answer = JSON.parse(res.text) as { error: { type: string; message: string } };
    assert.equal(answer.error.type, 'request_timeout');
    assert.match(answer.error.message, /proxy\.bodyTimeoutMs/); assert.match(answer.error.message, /1048576 bytes\) of 2097152 received/);
    assert.deepEqual(r.received, [], 'never went upstream');
    await until(() => budget.used === 0);
    assert.ok(r.events.some((e) => /→ 408 body_timeout after 0\.3s, 1\.0 MB \(1048576 bytes\) of 2097152 received/.test(e)), r.events.join(' | '));
    // A body that arrives in time is unaffected.
    const fine = await r.call(bodyOf(MB)); assert.equal(fine.status, 200); await fine.text();
  } finally { r.close(); }
});

test('an over-limit upload that stalls while it is drained is cut at the time limit too', async () => {
  const r = await rig(ok, { limit: MB, timeoutMs: 300 });
  try {
    const slow = upload(r.port, 4 * MB, 2 * MB);
    const res = await slow.response;
    assert.equal(res.status, 408);
  } finally { r.close(); }
});

test('proxy.bodyTimeoutMs: 300 s by default, 0 turns it off, anything else invalid is refused', () => {
  assert.equal(DEFAULT_BODY_TIMEOUT_MS, 300_000);
  assert.equal(bodyTimeoutMs(undefined), 300_000);
  assert.equal(bodyTimeoutMs(0), 0);
  assert.equal(bodyTimeoutMs(60_000), 60_000);
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '300000', null, 86_400_001]) {
    assert.throws(() => bodyTimeoutMs(bad), /proxy\.bodyTimeoutMs must be a whole number of milliseconds from 0 \(off\) to 86400000/, String(bad));
  }
});
