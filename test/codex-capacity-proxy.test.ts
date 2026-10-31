import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { ActivityLog } from '../src/activity.js';
import { codexCapacitySettings, type CodexCapacitySettings } from '../src/codex-capacity.js';
import { buildFrame } from '../src/frame.js';
import { claudeProvider, codexProvider } from '../src/providers.js';
import { BodyBudget, createProxy } from '../src/proxy.js';
import { parseRoutes } from '../src/routes.js';
import { defaultConfig, issueClaudeSession } from '../src/storage.js';
import type { ActivityEvent, ProviderId } from '../src/types.js';

const event = (type: string, extra: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const CREATED = event('response.created', { response: { id: 'attempt' } });
const DELTA = event('response.output_text.delta', { delta: 'hello' });
const COMPLETED = event('response.completed');
const OVERLOAD = event('response.failed', { response: { error: { code: 'server_is_overloaded', message: 'Selected model is at capacity.' } } });
const BODY = JSON.stringify({ model: 'gpt-6-astra', input: 'synthetic input', stream: true });
const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 200 && !check(); i++) await delay(5); assert(check(), 'condition not reached'); };
type Handler = (n: number, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
async function rig(handler: Handler, options: Partial<CodexCapacitySettings> & { provider?: ProviderId; accounts?: number } = {}) {
  const hits: Array<{ account: string; body: string; at: number }> = [];
  const upstream = createServer((req, res) => {
    const parts: Buffer[] = []; req.on('data', (data: Buffer) => parts.push(data));
    req.on('end', () => { hits.push({ account: String(req.headers['chatgpt-account-id'] ?? req.headers.authorization), body: Buffer.concat(parts).toString(), at: Date.now() }); void handler(hits.length, req, res); });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve)); const address = upstream.address(); assert(address && typeof address !== 'string');
  const id = options.provider ?? 'codex';
  const provider = { ...(id === 'codex' ? codexProvider : claudeProvider), upstreamBase: `http://127.0.0.1:${address.port}`, refresh: async (c: Parameters<typeof codexProvider.refresh>[0]) => c };
  const ids = Array.from({ length: options.accounts ?? 2 }, (_, i) => `account-${i}`);
  const pool = new AccountPool(provider, ids.map((id, priority) => ({ id, provider: provider.id, priority, label: id, enabled: true, credentialId: id, createdAt: '' })), Object.fromEntries(ids.map((id) => [id, { accountId: id, accessToken: 'synthetic', refreshToken: null, expiresAt: null }])), { version: 1, accounts: {} }, 0.98, 1);
  pool.codexCapacity = { ...codexCapacitySettings({}), retryMs: 30, ...options };
  const events: ActivityEvent[] = []; const notes: string[] = [];
  const log = new ActivityLog((entry) => events.push(entry)); const budget = new BodyBudget(1024 * 1024);
  const proxy = createProxy(pool, 'synthetic-local', (message) => { if (message) notes.push(message); }, undefined, log, { limit: 1024 * 1024, budget });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  const sessionId = id === 'claude' ? await issueClaudeSession() : 'synthetic-session';
  const call = (signal = AbortSignal.timeout(4000), path = id === 'codex' ? '/v1/responses' : '/v1/messages') => fetch(`http://127.0.0.1:${pa.port}${path}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-local', 'content-type': 'application/json', 'session-id': sessionId }, body: BODY, signal });
  const close = () => { proxy.closeAllConnections(); upstream.closeAllConnections(); proxy.close(); upstream.close(); };
  return { hits, pool, log, events, notes, budget, call, close };
}

for (const body of ['{"error":{"code":"server_is_overloaded"}}', 'The server is overloaded.', 'Selected model is at capacity.']) {
  test(`503 capacity retries unboundedly on the same account with identical bytes: ${body}`, { timeout: 8000 }, async (t) => {
    const r = await rig((n, _req, res) => { if (n <= 6) { res.writeHead(503, { 'retry-after': '120' }); res.end(body); } else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(CREATED + DELTA + COMPLETED); } }); t.after(r.close);
    const response = await r.call(); assert.equal(response.status, 200); assert.equal(await response.text(), CREATED + DELTA + COMPLETED);
    assert.equal(r.hits.length, 7); assert.equal(new Set(r.hits.map((h) => h.account)).size, 1); assert(r.hits.every((h) => h.body === BODY));
    assert(r.hits.slice(1).every((h, i) => h.at - r.hits[i]!.at >= 25), 'each retry honors the configured fixed interval');
    const gaps = r.hits.slice(1).map((h, i) => h.at - r.hits[i]!.at);
    assert(gaps.at(-1)! < gaps[0]! * 3 + 100, `retry delay must stay fixed rather than grow: ${gaps}`);
    assert(r.notes.some((line) => line.includes('capacity retry 6 after 30ms'))); assert(r.pool.accounts.every((a) => a.inflight === 0 && !a.cooldownUntil));
    assert.equal(r.events[0]?.request?.capacityRetries, 6); assert.equal(r.events[0]?.request?.streamEnd, undefined); assert.equal(r.budget.used, 0);
  });
}
for (const mime of ['text/event-stream', '', 'gzip']) {
  test(`200 early stream capacity has one successful preamble and no duplicate (${mime || 'missing MIME'})`, { timeout: 8000 }, async (t) => {
    const r = await rig((n, _req, res) => {
      const bytes = n === 1 ? CREATED + event('response.in_progress') + event('response.queued') + event('response.metadata') + ': keepalive\n\n' + OVERLOAD : CREATED + DELTA + COMPLETED;
      res.writeHead(200, mime === 'gzip' ? { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' } : mime ? { 'content-type': mime } : {});
      res.end(mime === 'gzip' ? gzipSync(bytes) : bytes);
    }); t.after(r.close);
    const response = await r.call(); assert.equal(response.status, 200); assert.equal(await response.text(), CREATED + DELTA + COMPLETED); assert.equal(r.hits.length, 2); assert.equal(r.hits[1]?.account, r.hits[0]?.account);
  });
}
test('late capacity after the hold deadline and a subsequent 503 are retried into the open response', { timeout: 8000 }, async (t) => {
  let release: () => void = () => {}; const held = new Promise<void>((resolve) => { release = resolve; });
  const r = await rig(async (n, _req, res) => {
    if (n === 2) { res.writeHead(503); res.end('model is at capacity'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(CREATED);
    if (n === 1) { await held; res.end(OVERLOAD); } else res.end(DELTA + COMPLETED);
  }, { preambleHoldMs: 20 }); t.after(r.close); t.after(release);
  const response = await r.call(); const reader = response.body!.getReader();
  assert.equal(Buffer.from((await reader.read()).value!).toString(), CREATED); assert.equal(r.hits.length, 1, 'preamble is released before upstream completes'); release();
  const parts = []; for (;;) { const part = await reader.read(); if (part.done) break; parts.push(Buffer.from(part.value)); }
  assert.equal(Buffer.concat(parts).toString(), CREATED + DELTA + COMPLETED); assert.equal(r.hits.length, 3); assert(r.hits.every((h) => h.account === r.hits[0]!.account));
});
test('capacity after output drops the failure and everything after it; client can issue a fresh retry', { timeout: 8000 }, async (t) => {
  const r = await rig((n, _req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(CREATED + DELTA + (n === 1 ? OVERLOAD : '') + COMPLETED); }); t.after(r.close);
  const first = await r.call(); assert.equal(await first.text(), CREATED + DELTA); assert.equal(r.hits.length, 1); assert.equal(r.events[0]?.request?.status, 'cut'); assert(r.notes.some((line) => line.includes('capacity failure after output')));
  const second = await r.call(); assert.equal(await second.text(), CREATED + DELTA + COMPLETED); assert.equal(r.hits.length, 2);
});
test('a spliced retry ending with an unrelated failure closes the original stream without a new status or body', { timeout: 8000 }, async (t) => {
  const r = await rig(async (n, _req, res) => { if (n === 1) { res.writeHead(200); res.write(CREATED); await delay(80); res.end(OVERLOAD); } else { res.writeHead(500); res.end('unrelated failure'); } }, { preambleHoldMs: 10 }); t.after(r.close);
  const response = await r.call(); assert.equal(response.status, 200); assert.equal(await response.text(), CREATED); assert.equal(r.hits.length, 2);
});
test('non-capacity failed events retain their bytes and failed activity status', { timeout: 8000 }, async (t) => {
  const bytes = CREATED + event('response.failed', { response: { error: { code: 'rate_limit_exceeded' } } });
  const r = await rig((_n, _req, res) => { res.writeHead(200); res.end(bytes); }); t.after(r.close);
  assert.equal(await (await r.call()).text(), bytes); assert.equal(r.hits.length, 1); assert.equal(r.events[0]?.request?.streamEnd, 'failed'); assert.equal(r.events[0]?.request?.capacityRetries, undefined);
});
for (const [status, body] of [[500, 'server_is_overloaded'], [503, 'unrelated error'], [429, '{"error":{"code":"rate_limit_exceeded"}}'], [429, '{"error":{"code":"usage_limit_reached"}}']] as const) {
  test(`existing non-capacity HTTP behavior remains: ${status} ${body}`, { timeout: 8000 }, async (t) => {
    const r = await rig((_n, _req, res) => { res.writeHead(status, { 'retry-after': '120' }); res.end(body); }, { accounts: 1 }); t.after(r.close);
    const response = await r.call(); assert.equal(response.status, status); assert.equal(await response.text(), body); assert.equal(r.hits.length, 1); assert(!r.notes.some((line) => line.includes('capacity retry')));
    assert.equal(r.pool.accounts[0]!.cooldownReason, body.includes('usage_limit_reached') ? 'quota' : null);
  });
}
for (const stage of ['503 wait', 'SSE wait', 'splice wait', 'headers', 'held preamble', '503 body'] as const) {
  test(`client disconnect stops capacity retries and releases every slot during ${stage}`, { timeout: 8000 }, async (t) => {
    let closed = false;
    const r = await rig(async (_n, _req, res) => {
      res.once('close', () => { closed = true; });
      if (stage === 'headers') return;
      if (stage.startsWith('503')) { res.writeHead(503); if (stage === '503 body') { res.write('server is'); return; } res.end('model is at capacity'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(CREATED);
      if (stage === 'held preamble') return;
      if (stage === 'splice wait') await delay(50);
      res.end(OVERLOAD);
    }, { retryMs: 2000, preambleHoldMs: stage === 'splice wait' ? 10 : 0 }); t.after(r.close);
    const controller = new AbortController(); const pending = r.call(controller.signal).then((res) => res.text()); const rejection = assert.rejects(pending);
    await until(() => r.hits.length === 1);
    if (stage.endsWith('wait')) await until(() => r.notes.some((line) => line.includes('capacity retry')));
    controller.abort(); await rejection;
    await until(() => r.pool.inFlightProxied === 0); assert(r.pool.accounts.every((a) => a.inflight === 0)); assert.equal(r.log.size, 0); assert.equal(r.budget.used, 0);
    await delay(350); assert.equal(r.hits.length, 1); assert(closed);
  });
}
test('a capacity wait retains its account lease and remains active on wide and narrow dashboards', { timeout: 8000 }, async (t) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const r = await rig(async (n, req, res) => {
    if (n === 1) { res.writeHead(503); res.end('model is at capacity'); return; }
    const account = String(req.headers['chatgpt-account-id']);
    if (account === 'account-0') await held;
    res.writeHead(200, { 'x-synthetic-account': account }); res.end(CREATED + DELTA + COMPLETED);
  }, { retryMs: 200 }); t.after(r.close); t.after(release);
  const pending = r.call(); void pending.catch(() => {});
  await until(() => r.log.snapshot()[0]?.capacityRetries === 1);
  assert.equal(r.pool.accounts[0]!.inflight, 1); assert.equal(r.pool.inFlightProxied, 1); assert.equal(r.events.length, 0);
  for (const width of [160, 60]) {
    const frame = buildFrame(defaultConfig(), { version: 1, accounts: {}, active: r.log.snapshot(), serverPid: process.pid }, { width, height: 35, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).join('\n');
    assert.match(frame, width === 160 ? /capacity retry x1/ : /retry x1/);
  }
  const second = await r.call(); await second.text();
  assert.equal(second.headers.get('x-synthetic-account'), 'account-1', 'a concurrent request cannot steal the reserved account slot');
  assert.equal(r.pool.accounts[0]!.inflight, 1, 'the original account stays reserved until its response is released');
  release(); assert.equal(await (await pending).text(), CREATED + DELTA + COMPLETED);
  assert.equal(r.hits.filter((h) => h.account === 'account-0').length, 2);
});
test('account rotation is opt-in, cycles forever and respects exclusive routes', { timeout: 8000 }, async (t) => {
  const r = await rig((n, _req, res) => { if (n <= 5) { res.writeHead(503); res.end('server is overloaded'); } else { res.writeHead(200); res.end(COMPLETED); } }, { rotateAccounts: true, accounts: 3 }); t.after(r.close);
  r.pool.setRoutes(parseRoutes([{ name: 'fixed-model', match: ['gpt-6-*'], accounts: ['account-0', 'account-1'], mode: 'exclusive' }], 'codex'));
  assert.equal(await (await r.call()).text(), COMPLETED); assert.deepEqual(r.hits.map((h) => h.account), ['account-0', 'account-1', 'account-0', 'account-1', 'account-0', 'account-1']);
});
test('pinned account paths remain pinned even when capacity rotation is enabled', { timeout: 8000 }, async (t) => {
  const r = await rig((n, _req, res) => { if (n < 3) { res.writeHead(503); res.end('server is overloaded'); } else { res.writeHead(200); res.end(COMPLETED); } }, { rotateAccounts: true }); t.after(r.close);
  assert.equal(await (await r.call(undefined, '/tc-acct/account-0/codex')).text(), COMPLETED); assert(r.hits.every((h) => h.account === 'account-0'));
});
for (const provider of ['codex', 'claude'] as const) {
  test(`${provider === 'codex' ? 'disabled Codex capacity retry' : 'Claude'} keeps 503 and SSE failures unchanged`, { timeout: 8000 }, async (t) => {
    const r = await rig((n, _req, res) => { if (n === 1) { res.writeHead(503, { 'retry-after': '120' }); res.end('server is overloaded'); } else { res.writeHead(200); res.end(CREATED + OVERLOAD); } }, { provider, enabled: provider === 'claude', accounts: 1 }); t.after(r.close);
    const response = await r.call(); assert.equal(response.status, 503); assert.equal(await response.text(), 'server is overloaded');
    r.pool.codexCapacity = { ...r.pool.codexCapacity, enabled: true };
    if (provider === 'codex') r.pool.codexCapacity.enabled = false;
    assert.equal(await (await r.call()).text(), CREATED + OVERLOAD); assert.equal(r.hits.length, 2); assert(!r.notes.some((line) => line.includes('capacity retry')));
  });
}

test('fake upstream with an oversized failed frame is cancelled at the buffer limit without leaking a terminal event', { timeout: 8000 }, async (t) => {
  let closed = false;
  const r = await rig((_n, _req, res) => {
    res.once('close', () => { closed = true; }); res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.failed","padding":"');
    for (let i = 0; i < 80; i++) res.write('x'.repeat(64 * 1024));
  }, { preambleHoldMs: 0 }); t.after(r.close);
  const response = await r.call(); assert.equal(await response.text(), '');
  await until(() => closed); assert.equal(r.hits.length, 1); assert(r.notes.some((line) => line.includes('SSE buffer limit'))); assert.equal(r.events[0]?.request?.status, 'cut'); assert(r.pool.accounts.every((a) => !a.inflight));
});

test('client disconnect during a shared token refresh releases admission without dispatching upstream', { timeout: 8000 }, async (t) => {
  const r = await rig((_n, _req, res) => { res.end(COMPLETED); }); t.after(r.close);
  let release: () => void = () => {}; let entered = false;
  const held = new Promise<void>((resolve) => { release = resolve; }); t.after(release);
  r.pool.provider.refresh = async (credential) => { entered = true; await held; return credential; };
  const abort = new AbortController(); const pending = r.call(abort.signal); const rejection = assert.rejects(pending);
  await until(() => entered); abort.abort(); await rejection;
  await until(() => r.pool.inFlightProxied === 0); assert(r.pool.accounts.every((a) => a.inflight === 0)); assert.equal(r.hits.length, 0); assert.equal(r.budget.used, 0);
  release(); await delay(20); assert.equal(r.hits.length, 0);
});
