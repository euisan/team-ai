import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { ActivityLog, clean } from '../src/activity.js';
import { buildFrame } from '../src/frame.js';
import { createProxy } from '../src/proxy.js';
import { redactSnapshot } from '../src/redact.js';
import type { ActivityEvent, PersistedState, Provider, StoredAccount, TeamAIConfig } from '../src/types.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

// A recording sink: the real ActivityLog plus a trace of every call, so a test
// can ask what had happened at a given moment, not just at the end.
function recorder() {
  const events: ActivityEvent[] = []; const calls: string[] = [];
  const log = new ActivityLog((event) => events.push(event));
  const sink = {
    start: (entry: Parameters<ActivityLog['start']>[0]) => { calls.push(`start:${entry.id}`); log.start(entry); },
    update: (id: string, patch: Parameters<ActivityLog['update']>[1]) => { calls.push(`update:${id}:${patch.account}`); log.update(id, patch); },
    end: (id: string, status: number | string) => { calls.push(`end:${id}:${status}`); log.end(id, status); },
  };
  return { events, calls, log, sink, ends: () => calls.filter((c) => c.startsWith('end:')) };
}

async function rig(handler: Handler, options: { accounts?: string[]; maxConcurrent?: number; capacity?: boolean; classify?: Provider['classifyFailure']; bodyLimit?: number } = {}) {
  const upstream = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: `http://127.0.0.1:${up.port}`,
    normalizePath: () => '/codex/responses', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (incoming, account) => { const h = new Headers(incoming); h.set('authorization', `Bearer ${account.credential.accessToken}`); return h; },
    classifyFailure: options.classify ?? (() => ({ kind: 'fatal', retryAfterMs: 0 })),
  };
  const ids = options.accounts ?? ['a'];
  const stored = ids.map((id, i): StoredAccount => ({ id, provider: 'codex', label: `${id}@example.com`, enabled: true, priority: i + 1, credentialId: id, createdAt: '' }));
  const credentials = Object.fromEntries(ids.map((id) => [id, { accessToken: `secret-${id}`, refreshToken: null, expiresAt: null, accountId: id }]));
  const pool = new AccountPool(provider, stored, credentials, { version: 1, accounts: {} }, 0.98, options.maxConcurrent ?? 16);
  const rec = recorder();
  const proxy = createProxy(pool, 'local-secret', () => {}, options.capacity ? () => pool.totalCapacity() : undefined, rec.sink, options.bodyLimit);
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  const url = `http://127.0.0.1:${pa.port}/v1/responses`;
  const call = (body = '{}', signal?: AbortSignal) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' }, body, signal });
  const close = () => { proxy.close(); upstream.close(); proxy.closeAllConnections(); upstream.closeAllConnections(); };
  return { pool, rec, call, close, port: pa.port };
}

const until = async (check: () => boolean, ms = 3_000): Promise<void> => { const deadline = Date.now() + ms; while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10)); assert.ok(check(), 'condition not reached in time'); };
const drain = (req: IncomingMessage) => new Promise<void>((r) => { req.resume(); req.once('end', r); });

test('a request shows as in flight with its account before upstream answers, then closes once', async () => {
  let release: () => void = () => {}; const gate = new Promise<void>((r) => { release = r; });
  const r = await rig(async (req, res) => { await drain(req); await gate; await new Promise((x) => setTimeout(x, 20)); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {}\n\n'); });
  try {
    const pending = r.call();
    await until(() => r.rec.calls.some((c) => c.startsWith('update:')));
    assert.deepEqual(r.rec.ends(), [], 'nothing has ended while upstream holds the response');
    const open = r.rec.log.snapshot();
    assert.equal(open.length, 1); assert.equal(open[0]!.account, 'a@example.com'); assert.equal(open[0]!.path, '/codex/responses'); assert.equal(open[0]!.method, 'POST');
    release();
    const res = await pending; assert.equal(res.status, 200); await res.text();
    await until(() => r.rec.ends().length === 1);
    assert.equal(r.rec.log.size, 0);
    const done = r.rec.events.find((e) => e.request)!;
    assert.equal(done.request!.status, 200); assert.ok(done.request!.durationMs >= 20);
    assert.equal(done.request!.account, 'a@example.com');
    assert.match(done.message, /^Codex POST \/codex\/responses → a@example\.com 200 \(\d+\.\ds\)$/);
  } finally { release(); r.close(); }
});

test('a slow SSE stream stays in flight until its last chunk', async () => {
  let finish: () => void = () => {}; const last = new Promise<void>((r) => { finish = r; });
  const r = await rig(async (req, res) => { await drain(req); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: 1\n\n'); await last; res.end('data: 2\n\n'); });
  try {
    const res = await r.call(); const reader = res.body!.getReader(); await reader.read();
    await new Promise((x) => setTimeout(x, 50));
    assert.deepEqual(r.rec.ends(), [], 'first chunk delivered, stream still open');
    assert.equal(r.rec.log.size, 1);
    finish(); while (!(await reader.read()).done) { /* drain */ }
    await until(() => r.rec.ends().length === 1);
    assert.equal(r.rec.ends()[0]!.endsWith(':200'), true);
  } finally { finish(); r.close(); }
});

test('two concurrent requests get separate lines, each closed once', async () => {
  let release: () => void = () => {}; const gate = new Promise<void>((r) => { release = r; });
  const r = await rig(async (req, res) => { await drain(req); await gate; res.writeHead(200); res.end('ok'); });
  try {
    const both = [r.call(), r.call()];
    await until(() => r.rec.log.size === 2);
    const ids = r.rec.log.snapshot().map((e) => e.id); assert.notEqual(ids[0], ids[1]);
    release(); await Promise.all((await Promise.all(both)).map((res) => res.text()));
    await until(() => r.rec.ends().length === 2);
    assert.deepEqual(new Set(r.rec.ends().map((c) => c.split(':')[1])), new Set(ids));
  } finally { release(); r.close(); }
});

test('a client that leaves mid-stream closes its line as 499', async () => {
  const r = await rig(async (req, res) => {
    await drain(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    const tick = setInterval(() => { if (!res.destroyed) res.write(`data: ${'x'.repeat(1024)}\n\n`); }, 5); res.once('close', () => clearInterval(tick));
  });
  try {
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port: r.port, path: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' } }, (res) => { res.once('data', () => { req.destroy(); resolve(); }); });
      req.on('error', () => {}); req.end('{}');
    });
    await until(() => r.rec.ends().length === 1);
    assert.equal(r.rec.ends()[0]!.endsWith(':499'), true, r.rec.ends().join());
    assert.equal(r.rec.log.size, 0);
  } finally { r.close(); }
});

test('a client that leaves during a retry wait still closes its line (it used to leave none)', async () => {
  let hits = 0;
  const r = await rig(async (req, res) => { await drain(req); hits++; res.writeHead(503, { 'retry-after': '5' }); res.end('busy'); }, { classify: (status) => status === 503 ? { kind: 'transient', retryAfterMs: 5_000 } : { kind: 'fatal', retryAfterMs: 0 } });
  try {
    const controller = new AbortController();
    const pending = r.call('{}', controller.signal).catch(() => null);
    await until(() => hits >= 1);
    await new Promise((x) => setTimeout(x, 100));
    assert.deepEqual(r.rec.ends(), [], 'waiting out the retry, not finished');
    controller.abort(); await pending;
    await until(() => r.rec.ends().length === 1);
    assert.equal(r.rec.ends()[0]!.endsWith(':499'), true, r.rec.ends().join());
    await new Promise((x) => setTimeout(x, 100));
    assert.equal(r.rec.ends().length, 1, 'closed exactly once');
  } finally { r.close(); }
});

test('an upstream stream that breaks after the headers closes as cut', async () => {
  const r = await rig(async (req, res) => { await drain(req); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: 1\n\n'); setTimeout(() => res.socket?.destroy(), 30); });
  try {
    const res = await r.call(); await res.text().catch(() => '');
    await until(() => r.rec.ends().length === 1);
    assert.equal(r.rec.ends()[0]!.endsWith(':cut'), true, r.rec.ends().join());
  } finally { r.close(); }
});

test('refusals before dispatch still leave exactly one closed line', async () => {
  let release: () => void = () => {}; const gate = new Promise<void>((r) => { release = r; });
  const r = await rig(async (req, res) => { await drain(req); await gate; res.writeHead(200); res.end('ok'); }, { maxConcurrent: 1, capacity: true, bodyLimit: 32 * 1024 * 1024 });
  try {
    const first = r.call();
    await until(() => r.pool.inFlightProxied === 1);
    const second = await r.call(); assert.equal(second.status, 429); await second.text();
    await until(() => r.rec.ends().length === 1);
    assert.equal(r.rec.ends()[0]!.endsWith(':429'), true);
    release(); await (await first).text();
    await until(() => r.rec.ends().length === 2);
    // Too large: 413 after the line opened, and it is closed.
    const big = await r.call('x'.repeat(33 * 1024 * 1024)).catch(() => null);
    if (big) { assert.equal(big.status, 413); await big.text(); }
    await until(() => r.rec.ends().length === 3);
    assert.equal(r.rec.ends()[2]!.endsWith(':413'), true, r.rec.ends().join());
    assert.equal(r.rec.log.size, 0);
  } finally { release(); r.close(); }
});

test('a sink that throws never breaks the request', async () => {
  const r = await rig(async (req, res) => { await drain(req); res.writeHead(200); res.end('ok'); });
  r.rec.sink.start = () => { throw new Error('boom'); }; r.rec.sink.end = () => { throw new Error('boom'); };
  try { const res = await r.call(); assert.equal(res.status, 200); assert.equal(await res.text(), 'ok'); } finally { r.close(); }
});

test('client text is stripped of control characters and capped', () => {
  assert.equal(clean('/v1/\x1b[31mred\x07', 256), '/v1/ [31mred');
  assert.equal(clean('x'.repeat(300), 256)!.length, 256);
  assert.equal(clean(42, 10), null);
});

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (line: string): string => line.replace(ANSI, '');
const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [{ id: 'x', provider: 'codex', label: 'x@example.com', enabled: true, priority: null, credentialId: 'x', createdAt: '' }] };

test('the dashboard counts and draws in-flight requests above the finished ones', () => {
  const now = Date.now();
  const state: PersistedState = {
    version: 1, accounts: {},
    active: [
      { id: '1', provider: 'codex', providerLabel: 'Codex', method: 'POST', path: '/codex/responses', account: 'x@example.com', startedAt: now - 3_000 },
      { id: '2', provider: 'codex', providerLabel: 'Codex', method: 'POST', path: '/codex/responses', account: null, startedAt: now - 500 },
    ],
    events: [{ at: now - 10_000, message: 'Codex POST /codex/responses → x@example.com 200 (1.2s)', request: { provider: 'codex', providerLabel: 'Codex', method: 'POST', path: '/codex/responses', account: 'x@example.com', status: 200, durationMs: 1_200 } }],
  };
  const lines = buildFrame(config, state, { width: 100, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).map(plain);
  const header = lines.findIndex((l) => l.startsWith(' Activity'));
  assert.match(lines[header]!, /^ Activity {2}2 active ─+$/);
  assert.match(lines[header + 1]!, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d\d:\d\d:\d\d {2}Codex POST \/codex\/responses → x@example\.com \(3\.\ds\.\.\.\)/);
  assert.match(lines[header + 2]!, /Codex POST \/codex\/responses \(0\.\ds\.\.\.\) *$/, 'no account yet: no arrow');
  assert.match(lines[header + 3]!, /^ {2}\d\d:\d\d:\d\d {2}Codex POST \/codex\/responses → x@example\.com \(200, 1\.2s\)/);
  assert.ok(lines.every((l) => [...l].length <= 100));
  const idle = buildFrame(config, { ...state, active: [] }, { width: 100, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).map(plain);
  assert.ok(idle.some((l) => /^ Activity ─+$/.test(l)), 'no count while nothing is in flight');
});

test('capture redaction masks accounts on in-flight and finished request lines', () => {
  const state: PersistedState = { version: 1, accounts: {}, active: [{ id: '1', provider: 'codex', providerLabel: 'Codex', method: 'POST', path: '/', account: 'x@example.com', startedAt: 0 }], events: [{ at: 0, message: 'Codex POST / → x@example.com 200 (1.0s)', request: { provider: 'codex', providerLabel: 'Codex', method: 'POST', path: '/', account: 'x@example.com', status: 200, durationMs: 1000 } }] };
  const masked = redactSnapshot(config, state, 'partial').state;
  assert.equal(JSON.stringify(masked).includes('x@example.com'), false);
  assert.equal(masked.active?.[0]?.account, '•@ex•••••.com');
});

test('in-flight lines are drawn only while the server that wrote them is running', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { liveState } = await import('../src/runtime.js');
  const root = await mkdtemp(join(tmpdir(), 'teamai-live-')); process.env.TEAMAI_HOME = root;
  const active = [{ id: '1', provider: 'codex' as const, providerLabel: 'Codex', method: 'POST', path: '/', account: null, startedAt: 0 }];
  try {
    assert.deepEqual((await liveState({ version: 1, accounts: {}, active, serverPid: process.pid })).active, [], 'no server.json: nothing is running');
    await writeFile(join(root, 'server.json'), JSON.stringify({ pid: process.pid }));
    assert.equal((await liveState({ version: 1, accounts: {}, active, serverPid: process.pid })).active?.length, 1);
    assert.deepEqual((await liveState({ version: 1, accounts: {}, active, serverPid: process.pid + 1 })).active, [], 'left behind by another process');
  } finally { delete process.env.TEAMAI_HOME; }
});
