import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { createProxy, SseWatcher, type StreamEnd } from '../src/proxy.js';
import type { Provider, StoredAccount } from '../src/types.js';

// A client that hangs up the moment its stream has delivered a terminal event
// (Codex CLI does exactly that on response.completed) finished its request; one
// that hangs up before it abandoned it. All data here is synthetic.

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

async function rig(handler: Handler) {
  const upstream = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const provider: Provider = {
    id: 'codex', label: 'Codex', upstreamBase: `http://127.0.0.1:${up.port}`,
    normalizePath: () => '/codex/responses', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c,
    buildHeaders: (incoming) => new Headers(incoming),
    classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }),
  };
  const stored: StoredAccount[] = [{ id: 'a', provider: 'codex', label: 'a@example.com', enabled: true, priority: 1, credentialId: 'a', createdAt: '' }];
  const pool = new AccountPool(provider, stored, { a: { accessToken: 'synthetic', refreshToken: null, expiresAt: null, accountId: 'a' } }, { version: 1, accounts: {} }, 0.98, 16);
  const ends: Array<number | string> = [];
  const sink = { start: () => {}, update: () => {}, end: (_id: string, status: number | string) => { ends.push(status); } };
  const proxy = createProxy(pool, 'local-secret', () => {}, undefined, sink);
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  // Reads the relayed stream raw and hangs up once hangUp says so, or keeps
  // reading to EOF when it never does. Resolves with every byte received.
  const call = (hangUp: (received: Buffer) => boolean = () => false) => new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    const req = request({ host: '127.0.0.1', port: pa.port, path: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' } }, (res) => {
      res.on('data', (chunk: Buffer) => { parts.push(chunk); if (hangUp(Buffer.concat(parts))) { req.destroy(); resolve(Buffer.concat(parts)); } });
      res.on('end', () => resolve(Buffer.concat(parts)));
    });
    req.on('error', (error) => { if (!req.destroyed) reject(error); }); req.end('{}');
  });
  const close = () => { proxy.close(); upstream.close(); proxy.closeAllConnections(); upstream.closeAllConnections(); };
  return { ends, call, close };
}

const until = async (check: () => boolean, ms = 3_000): Promise<void> => { const deadline = Date.now() + ms; while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10)); assert.ok(check(), 'condition not reached in time'); };
const drain = (req: IncomingMessage) => new Promise<void>((r) => { req.resume(); req.once('end', r); });
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const CREATED = sse('response.created', { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress' } });
const DELTA = sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'hello' });
const COMPLETED = sse('response.completed', { type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(4096) }] }] } });

// Upstream writes its parts, then holds the connection open the way a slow
// EOF does, until the relay lets go of it.
const holdOpen = (parts: string[], gapMs = 0, headers: Record<string, string> = { 'content-type': 'text/event-stream' }): Handler => async (req, res) => {
  await drain(req); res.writeHead(200, headers);
  for (const part of parts) { if (res.destroyed) return; res.write(part); if (gapMs) await new Promise((r) => setTimeout(r, gapMs)); }
};

test('(a) a client that hangs up right after response.completed is recorded as 200, not 499', async () => {
  const r = await rig(holdOpen([CREATED, DELTA, COMPLETED]));
  try {
    const got = await r.call((b) => b.toString().endsWith(COMPLETED));
    assert.ok(got.toString().endsWith(COMPLETED));
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [200]);
  } finally { r.close(); }
});

test('(b) a client that hangs up before the completion event is still 499', async () => {
  // Half of the completion event is already out: without its blank line it is
  // not an event yet, and the client never saw the response finish.
  const half = COMPLETED.slice(0, COMPLETED.length - 1);
  const r = await rig(holdOpen([CREATED, DELTA, half], 10));
  try {
    await r.call((b) => b.toString().endsWith(half));
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [499]);
  } finally { r.close(); }
});

test('(c) a completion event split across two chunks is still recognised', async () => {
  // Cut inside the event name and again inside the data's type, so neither
  // field is whole in any one chunk.
  const first = COMPLETED.indexOf('completed') + 4; const second = COMPLETED.indexOf('completed', first) + 4;
  const r = await rig(holdOpen([CREATED, COMPLETED.slice(0, first), COMPLETED.slice(first, second), COMPLETED.slice(second)], 20));
  try {
    await r.call((b) => b.toString().endsWith(COMPLETED));
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [200]);
  } finally { r.close(); }
});

test('(d) the relayed bytes are exactly the upstream bytes', async () => {
  // Multi-byte text split mid-character, CRLF line ends, a comment line and a
  // terminal event in the middle: nothing about watching may touch the bytes.
  const body = Buffer.concat([Buffer.from(': keep-alive\r\n\r\n'), Buffer.from(sse('response.output_text.delta', { delta: '한국어 ✓ 🙂' }).replace(/\n/g, '\r\n')), Buffer.from(COMPLETED), Buffer.from('data: trailing\n\n')]);
  const cuts = [3, 15, body.indexOf('한') + 1, body.indexOf('🙂') + 2, body.indexOf('\r\n', 20) + 1, body.length - 7].sort((x, y) => x - y);
  assert.ok(new Set(cuts).size === cuts.length && cuts[0]! > 0);
  const parts = [0, ...cuts].map((from, i) => body.subarray(from, cuts[i] ?? body.length));
  const r = await rig(async (req, res) => {
    await drain(req); res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const part of parts) { res.write(part); await new Promise((x) => setTimeout(x, 5)); }
    res.end();
  });
  try {
    const got = await r.call();
    assert.ok(got.equals(body), 'relayed body differs from upstream');
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [200]);
  } finally { r.close(); }
});

test('(e) a Claude stream that hangs up after message_stop is recorded as 200', async () => {
  const stop = sse('message_stop', { type: 'message_stop' });
  const r = await rig(holdOpen([sse('message_start', { type: 'message_start', message: { id: 'msg_synthetic' } }), sse('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }), stop]));
  try {
    await r.call((b) => b.toString().endsWith(stop));
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [200]);
  } finally { r.close(); }
});

test('(e) a Claude stream that hangs up before message_stop is still 499', async () => {
  const delta = sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  const r = await rig(holdOpen([sse('message_start', { type: 'message_start' }), delta], 10));
  try {
    await r.call((b) => b.toString().endsWith(delta));
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [499]);
  } finally { r.close(); }
});

// chatgpt.com's /codex/responses was measured sending its SSE stream with no
// content-type header at all (35 headers, none of them content-type). The
// relay must watch such a stream as well as a declared one.
const NO_TYPE = {};

test('(f) no content-type: a client that hangs up right after response.completed is 200', async () => {
  const r = await rig(holdOpen([CREATED, DELTA, COMPLETED], 0, NO_TYPE));
  try {
    await r.call((b) => b.toString().endsWith(COMPLETED));
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [200]);
  } finally { r.close(); }
});

test('(f) no content-type: a client that hangs up before response.completed is still 499', async () => {
  const half = COMPLETED.slice(0, COMPLETED.length - 1);
  const r = await rig(holdOpen([CREATED, DELTA, half], 10, NO_TYPE));
  try {
    await r.call((b) => b.toString().endsWith(half));
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [499]);
  } finally { r.close(); }
});

test('(f) a declared application/json body is not watched, even if it reads like a terminal event', async () => {
  const lookalike = 'data: {"type":"response.completed"}\n\n';
  const r = await rig(holdOpen([lookalike], 0, { 'content-type': 'application/json' }));
  try {
    await r.call((b) => b.toString().endsWith(lookalike));
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [499]);
  } finally { r.close(); }
});

test('(f) no content-type: a JSON body is watched but never mistaken for a finished stream', async () => {
  const body = `${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }, null, 2)}\n\n`;
  const r = await rig(holdOpen([body], 0, NO_TYPE));
  try {
    await r.call((b) => b.toString().endsWith(body));
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [499]);
  } finally { r.close(); }
});

test('(f) regression: the measured Codex response shape — no content-type, one event per chunk, hang-up after completed', async () => {
  // Header names as measured; every value is synthetic.
  const headers = { 'cache-control': 'no-cache', 'x-request-id': 'req_synthetic', 'openai-processing-ms': '1', 'cf-ray': 'synthetic', 'strict-transport-security': 'max-age=0', 'x-content-type-options': 'nosniff', 'set-cookie': 'synthetic=1; Path=/' };
  const parts = [CREATED, sse('response.in_progress', { type: 'response.in_progress', response: { id: 'resp_synthetic' } }), DELTA, sse('response.output_text.done', { type: 'response.output_text.done', text: 'hello' }), COMPLETED];
  const r = await rig(holdOpen(parts, 5, headers));
  try {
    // Codex closes about 2 ms after the last chunk.
    await r.call((b) => b.toString().endsWith(COMPLETED));
    await until(() => r.ends.length === 1);
    assert.deepEqual(r.ends, [200]);
  } finally { r.close(); }
});

// The parser on its own, split at every byte offset.
function watch(chunks: Array<string | Buffer>): StreamEnd | null {
  const seen: StreamEnd[] = []; const w = new SseWatcher((end) => seen.push(end));
  for (const c of chunks) w.feed(typeof c === 'string' ? Buffer.from(c) : c);
  assert.ok(seen.length <= 1, 'reported more than once'); return w.ended;
}

test('the watcher finds a terminal event at every chunk boundary, with LF, CRLF or CR', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const text = [CREATED, DELTA, COMPLETED].join('').replace(/\n/g, eol);
    for (let i = 0; i <= text.length; i++) assert.equal(watch([text.slice(0, i), text.slice(i)]), 'completed', `eol ${JSON.stringify(eol)} split at ${i}`);
    assert.equal(watch([...text]), 'completed', `eol ${JSON.stringify(eol)} one byte at a time`);
  }
});

test('the watcher names each terminal event for what it is, and ignores the rest', () => {
  assert.equal(watch([sse('response.done', { type: 'response.done' })]), 'completed');
  assert.equal(watch([sse('response.incomplete', { type: 'response.incomplete' })]), 'incomplete');
  assert.equal(watch([sse('response.failed', { type: 'response.failed' })]), 'failed');
  assert.equal(watch([sse('message_stop', { type: 'message_stop' })]), 'completed');
  // No event field: the data's type names it.
  assert.equal(watch(['data: {"type":"response.completed","response":{}}\n\n']), 'completed');
  assert.equal(watch(['data: {"type":"message_stop"}\n\n']), 'completed');
  // Not over yet: no blank line, a delta that merely mentions the name, an
  // unrelated event, a comment.
  assert.equal(watch(['event: response.completed\ndata: {}\n']), null);
  // A CRLF split across chunks is one line end, not a blank line: the LF that
  // opens the next chunk must not end the event early.
  assert.equal(watch(['event: response.completed\r', '\ndata: {}\r\n']), null);
  assert.equal(watch(['event: response.completed\r', '\ndata: {}\r\n', '\r\n']), 'completed');
  assert.equal(watch([sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'response.completed' })]), null);
  assert.equal(watch([sse('message_delta', { type: 'message_delta' }), ': message_stop\n\n']), null);
  // The event field wins over the data's type, and the first terminal event sticks.
  assert.equal(watch(['event: response.output_text.delta\ndata: {"type":"response.completed"}\n\n']), null);
  assert.equal(watch([sse('response.failed', {}), sse('response.completed', {})]), 'failed');
});

test('the watcher leaves the chunks it reads untouched and keeps only line heads', () => {
  const chunk = Buffer.from(COMPLETED); const copy = Buffer.from(chunk);
  const w = new SseWatcher(); w.feed(chunk);
  assert.ok(chunk.equals(copy)); assert.equal(w.ended, 'completed');
  // A huge data line is not buffered whole: a megabyte line ends and the
  // following event is still seen.
  const big = new SseWatcher(); big.feed(Buffer.from(`event: response.output_text.delta\ndata: "${'y'.repeat(1 << 20)}"\n\n`)); big.feed(Buffer.from(sse('response.completed', {})));
  assert.equal(big.ended, 'completed');
});

test('a CRLF split across chunks never ends an event before its blank line, even with an empty chunk between', () => {
  // A short terminal event in CRLF. Its blank line is the CR at length - 2:
  // until that byte arrives the event is not over, however the bytes are cut.
  const text = sse('response.completed', { type: 'response.completed' }).replace(/\n/g, '\r\n');
  const blank = text.length - 2;
  for (let split = 1; split < text.length; split++) {
    if (text[split - 1] !== '\r' || text[split] !== '\n') continue;
    for (let end = split; end <= text.length; end++) {
      const expected = end > blank ? 'completed' : null;
      // fetch's reader can hand over a zero-length chunk; it must not forget
      // that the previous chunk ended on a CR.
      assert.equal(watch([text.slice(0, split), Buffer.alloc(0), text.slice(split, end)]), expected, `split at ${split}, fed to ${end}`);
      assert.equal(watch([text.slice(0, split), text.slice(split, end)]), expected, `split at ${split}, fed to ${end}, no empty chunk`);
    }
  }
});

test('the watcher reads only the first 256 bytes of a line, across chunks too', () => {
  assert.equal(SseWatcher.HEAD, 256);
  // A data line whose "type" closes exactly at byte 256 is read; one byte of
  // padding more and the type falls past the head and is not.
  const line = (pad: number) => `data: {"p":"${'x'.repeat(pad)}","type":"response.completed"}`;
  const fits = Array.from({ length: 300 }, (_, pad) => pad).find((pad) => line(pad).indexOf('"}') === SseWatcher.HEAD - 1);
  assert.ok(fits !== undefined);
  for (const [pad, expected] of [[fits, 'completed'], [fits + 1, null]] as const) {
    const text = `${line(pad)}\n\n`;
    assert.equal(watch([text]), expected, `pad ${pad}`);
    for (let i = 1; i < text.length; i++) assert.equal(watch([text.slice(0, i), text.slice(i)]), expected, `pad ${pad} split at ${i}`);
  }
  // The same for the event field.
  const named = (pad: number) => `event:${' '.repeat(pad)}response.completed\ndata: {}\n\n`;
  assert.equal(watch([named(256 - 'event:response.completed'.length)]), 'completed');
  assert.equal(watch([named(257 - 'event:response.completed'.length)]), null);
  // What is held of a line never exceeds the head, whatever its length, and a
  // long line's tail does not leak into the next line.
  const w = new SseWatcher();
  w.feed(Buffer.from(`data: ${'z'.repeat(5000)}`)); assert.equal(w.held, SseWatcher.HEAD);
  w.feed(Buffer.from('z'.repeat(5000))); assert.equal(w.held, SseWatcher.HEAD);
  w.feed(Buffer.from('\nevent: response.completed\n\n')); assert.equal(w.held, 0);
  assert.equal(w.ended, 'completed');
});
