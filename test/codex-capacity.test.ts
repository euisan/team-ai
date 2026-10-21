import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises';
import { codexCapacitySettings, gateCodexCapacityPreamble, isCapacityOverloadBody, isCapacityOverloadPayload, SSE_MAX_FRAME_BYTES } from '../src/codex-capacity.js';

const sse = (type: string, extra: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const CREATED = sse('response.created');
const DELTA = sse('response.output_text.delta', { delta: '한국어 🙂' });
const COMPLETE = sse('response.completed');
const CAPACITY = sse('response.failed', { response: { error: { code: 'server_is_overloaded' } } });
function source(parts: Array<string | Buffer | { wait: number; data: string }>) {
  let index = 0; let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      const part = parts[index++]; if (part === undefined) { c.close(); return; }
      if (typeof part === 'object' && !Buffer.isBuffer(part)) { await delay(part.wait); if (!cancelled) c.enqueue(Buffer.from(part.data)); }
      else c.enqueue(Buffer.from(part));
    },
    cancel() { cancelled = true; },
  });
  return { stream, cancelled: () => cancelled };
}
async function read(stream: ReadableStream<Uint8Array>): Promise<string> { const reader = stream.getReader(); const parts: Buffer[] = []; for (;;) { const value = await reader.read(); if (value.done) break; parts.push(Buffer.from(value.value)); } return Buffer.concat(parts).toString('utf8'); }

// Every capacity marker is exercised independently of a particular message.
for (const error of [{ code: 'server_is_overloaded' }, { message: 'The server is overloaded, try later.' }, { type: 'Selected model is at capacity.' }, 'MODEL IS AT CAPACITY']) {
  test(`detection: ${JSON.stringify(error)}`, () => {
    assert(isCapacityOverloadPayload({ error }));
    assert(isCapacityOverloadPayload({ response: { error } }));
    assert(isCapacityOverloadBody(JSON.stringify({ error })));
  });
}
test('detection keeps unrelated errors and embedded output text separate', () => {
  for (const data of [null, [], 'server_is_overloaded', { error: { code: 'invalid_request' } }, { delta: 'model is at capacity' }, { response: {} }]) assert.equal(isCapacityOverloadPayload(data), false);
  assert(isCapacityOverloadBody('server is overloaded'));
  assert(isCapacityOverloadBody('{"message":"model is at capacity"}'));
  assert(isCapacityOverloadBody('"server_is_overloaded"'));
});
test('settings default to enabled, 500ms retry, 500ms hold and no rotation; malformed settings are refused', () => {
  assert.deepEqual(codexCapacitySettings({}), { enabled: true, retryMs: 500, preambleHoldMs: 500, rotateAccounts: false });
  assert.equal(codexCapacitySettings({ codexCapacityPreambleHoldMs: 0 }).preambleHoldMs, 0);
  for (const key of ['codexCapacityRetryMs', 'codexCapacityPreambleHoldMs'] as const) for (const value of [-1, 1.5, NaN, Infinity, '500', 86_400_001]) assert.throws(() => codexCapacitySettings({ [key]: value } as never), new RegExp(key));
  for (const key of ['codexCapacityEnabled', 'codexCapacityRotation'] as const) assert.throws(() => codexCapacitySettings({ [key]: 'true' } as never), new RegExp(key));
  assert.throws(() => codexCapacitySettings({ codexCapacityRetryMs: 0 }));
});

test('gate holds preamble and metadata, then preserves all successful frames in the same chunk', async () => {
  const bytes = CREATED + sse('response.queued') + sse('response.in_progress') + sse('response.metadata') + sse('codex.response.metadata') + ': keepalive\n\n' + DELTA + COMPLETE;
  const gate = gateCodexCapacityPreamble(source([bytes]).stream, 500);
  assert.equal(await read(gate.stream), bytes); assert.equal(gate.outcome.retry, false);
});
test('gate suppresses early capacity and every held preamble frame', async () => {
  const gate = gateCodexCapacityPreamble(source([CREATED, sse('response.metadata'), CAPACITY, COMPLETE]).stream, 500);
  assert.equal(await read(gate.stream), ''); assert.equal(gate.outcome.retry, true);
});
for (const newline of ['\n', '\r\n', '\r']) {
  test(`gate filters capacity after output across every byte boundary (${JSON.stringify(newline)})`, async () => {
    const before = (CREATED + DELTA).replace(/\n/g, newline);
    const bytes = Buffer.from(before + (CAPACITY + COMPLETE).replace(/\n/g, newline));
    const upstream = source(Array.from(bytes, (byte) => Buffer.from([byte])));
    const gate = gateCodexCapacityPreamble(upstream.stream, 0);
    assert.equal(await read(gate.stream), before); assert.equal(gate.outcome.retry, false); assert.equal(gate.outcome.afterOutput, true); assert(upstream.cancelled());
  });
}
test('gate drops a final unterminated capacity frame after output', async () => {
  const gate = gateCodexCapacityPreamble(source([DELTA, CAPACITY.trimEnd()]).stream, 0);
  assert.equal(await read(gate.stream), DELTA); assert(gate.outcome.afterOutput);
});
test('gate passes non-capacity failures, opaque data, DONE and text mentioning capacity', async () => {
  const bytes = CREATED + sse('response.output_text.delta', { delta: 'model is at capacity' }) + sse('response.failed', { response: { error: { code: 'rate_limit_exceeded' } } }) + 'data: [DONE]\n\ndata: invalid json\n\n';
  const gate = gateCodexCapacityPreamble(source([bytes]).stream, 0);
  assert.equal(await read(gate.stream), bytes); assert.equal(gate.outcome.afterOutput, false); assert.equal(gate.outcome.retry, false);
});
test('hold deadline releases preamble promptly and still protects a late capacity failure', { timeout: 8000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release: () => void = () => {};
  const upstream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(CREATED)); release = () => { c.enqueue(Buffer.from(CAPACITY)); c.close(); }; } });
  const gate = gateCodexCapacityPreamble(upstream, 20);
  const reader = gate.stream.getReader(); t.after(() => reader.cancel());
  let delivered = false;
  const first = reader.read().then((part) => { delivered = true; return part; });
  await turn(); t.mock.timers.tick(19); await turn();
  assert.equal(delivered, false, 'the preamble stays held before the configured deadline');
  t.mock.timers.tick(1); await turn();
  assert.equal(delivered, true, 'preamble is released at the configured deadline');
  assert.equal(Buffer.from((await first).value!).toString(), CREATED);
  assert(gate.outcome.holdTimedOut, 'the exact configured deadline releases preamble without upstream progress');
  release(); assert((await reader.read()).done); assert(gate.outcome.retry);
});
test('hold deadline is absolute, not renewed by a trickle of preamble events', async () => {
  const gate = gateCodexCapacityPreamble(source([CREATED, ...Array.from({ length: 10 }, () => ({ wait: 20, data: CREATED })), CAPACITY]).stream, 50);
  const reader = gate.stream.getReader(); const first = await reader.read(); assert(first.value); assert(gate.outcome.holdTimedOut);
  await reader.cancel();
});
test('zero hold deadline keeps preamble hidden until delayed capacity arrives', async () => {
  const gate = gateCodexCapacityPreamble(source([CREATED, { wait: 60, data: CAPACITY }]).stream, 0);
  assert.equal(await read(gate.stream), ''); assert(gate.outcome.retry); assert.equal(gate.outcome.holdTimedOut, false);
});
test('memory ceiling releases accumulated preamble while keeping late capacity retryable', async () => {
  const preamble = sse('response.created', { padding: 'x'.repeat(256 * 1024) });
  const gate = gateCodexCapacityPreamble(source([...Array<string>(20).fill(preamble), CAPACITY]).stream, 0);
  const bytes = await read(gate.stream); assert(bytes.length > 0); assert(!bytes.includes('server_is_overloaded')); assert(gate.outcome.retry); assert(gate.outcome.maxHeldBytes <= SSE_MAX_FRAME_BYTES);
});
test('memory ceiling closes an oversized unfinished frame and cancels upstream without leaking it', async () => {
  const upstream = source(['data: {"type":"response.failed","padding":"', ...Array<string>(80).fill('x'.repeat(64 * 1024)), CAPACITY]);
  const gate = gateCodexCapacityPreamble(upstream.stream, 0);
  assert.equal(await read(gate.stream), ''); assert(gate.outcome.bufferLimit); assert(gate.outcome.maxHeldBytes <= SSE_MAX_FRAME_BYTES); assert(upstream.cancelled());
});
test('gate preserves incomplete non-failure bytes and opaque bodies', async () => {
  for (const bytes of [CREATED + 'event: response.in_progress\ndata: {"partial', 'ordinary text', DELTA + COMPLETE.slice(0, -1)]) {
    const gate = gateCodexCapacityPreamble(source([bytes]).stream, 0); assert.equal(await read(gate.stream), bytes);
  }
});
test('cancellation during held preamble cancels a pending upstream read', async () => {
  let cancelled = false;
  const upstream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(CREATED)); }, cancel() { cancelled = true; } });
  const gate = gateCodexCapacityPreamble(upstream, 0); const reader = gate.stream.getReader(); const pending = reader.read();
  await delay(10); await reader.cancel(); await pending; assert(cancelled);
});
test('an upstream read error preserves its non-capacity partial frame before propagating', async () => {
  let index = 0;
  const tail = 'event: response.output_text.delta\ndata: {"partial';
  const upstream = new ReadableStream<Uint8Array>({ pull(c) { if (index++ === 0) c.enqueue(Buffer.from(DELTA + tail)); else c.error(new Error('synthetic read failure')); } });
  const gate = gateCodexCapacityPreamble(upstream, 0); const reader = gate.stream.getReader(); const parts: Buffer[] = [];
  await assert.rejects(async () => { for (;;) { const part = await reader.read(); if (part.done) break; parts.push(Buffer.from(part.value)); } }, /synthetic read failure/);
  assert.equal(Buffer.concat(parts).toString(), DELTA + tail);
});
