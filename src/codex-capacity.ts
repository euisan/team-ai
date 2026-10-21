import type { TeamAIConfig } from './types.js';

const CAPACITY = /\b(?:server_is_overloaded|server is overloaded|model is at capacity)\b/i;
const NON_OUTPUT = new Set(['response.created', 'response.in_progress', 'response.queued', 'response.metadata', 'codex.response.metadata']);
export const SSE_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface CodexCapacitySettings { enabled: boolean; retryMs: number; preambleHoldMs: number; rotateAccounts: boolean }
export const CAPACITY_DEFAULTS: Readonly<CodexCapacitySettings> = { enabled: true, retryMs: 500, preambleHoldMs: 500, rotateAccounts: false };

// Validate before startup or an atomic config reload changes any live pool.
export function codexCapacitySettings(config: Pick<TeamAIConfig, 'codexCapacityEnabled' | 'codexCapacityRetryMs' | 'codexCapacityPreambleHoldMs' | 'codexCapacityRotation'>): CodexCapacitySettings {
  for (const key of ['codexCapacityEnabled', 'codexCapacityRotation'] as const) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key} must be true or false`);
  for (const key of ['codexCapacityRetryMs', 'codexCapacityPreambleHoldMs'] as const) {
    const value = config[key]; const min = key === 'codexCapacityRetryMs' ? 1 : 0;
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > 86_400_000)) throw new Error(`${key} must be a whole number of milliseconds from ${min} to 86400000`);
  }
  return { enabled: config.codexCapacityEnabled ?? true, retryMs: config.codexCapacityRetryMs ?? 500, preambleHoldMs: config.codexCapacityPreambleHoldMs ?? 500, rotateAccounts: config.codexCapacityRotation ?? false };
}

function matches(error: unknown): boolean {
  if (typeof error === 'string') return CAPACITY.test(error);
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const fields = error as Record<string, unknown>;
  return [fields.code, fields.message, fields.type].some((value) => typeof value === 'string' && CAPACITY.test(value));
}

export function isCapacityOverloadPayload(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const value = data as { error?: unknown; response?: { error?: unknown } | null };
  return matches(value.error) || matches(value.response?.error);
}

// HTTP 503 may carry JSON or a plain-text capacity message.
export function isCapacityOverloadBody(body: string): boolean { return CAPACITY.test(body); }

function classify(frame: Buffer): 'capacity' | 'preamble' | 'output' {
  const lines = frame.toString('utf8').split(/\r\n|\r|\n/);
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
  let payload: { type?: unknown } | null = null;
  try { payload = JSON.parse(data) as { type?: unknown } | null; } catch { /* opaque output */ }
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
  const type = typeof payload?.type === 'string' ? payload.type : event;
  if (type === 'response.failed' && isCapacityOverloadPayload(payload)) return 'capacity';
  return !data || (type && NON_OUTPUT.has(type)) ? 'preamble' : 'output';
}

export interface CapacityOutcome { retry: boolean; afterOutput: boolean; holdTimedOut: boolean; bufferLimit: boolean; maxHeldBytes: number }

/**
 * Codex CLI rust-v0.161.0 treats response.failed/server_is_overloaded as fatal
 * (protocol/src/error.rs retry_delay), but a missing response.completed as a
 * retryable Stream error (codex-api/src/sse/responses.rs and
 * core/src/responses_retry.rs). Drop capacity frames after output and close
 * without a terminal event, allowing that client recovery path.
 *
 * Before output, hold preamble bytes for at most holdMs (0 disables the
 * deadline). After the deadline only preamble has been sent, so the caller
 * can still retry into the open response. Every byte is retained verbatim.
 * A frame exceeding the memory ceiling ends the stream without a terminal
 * event; oversized opaque frames must never bypass capacity filtering.
 */
export function gateCodexCapacityPreamble(upstream: ReadableStream<Uint8Array>, holdMs: number): { stream: ReadableStream<Uint8Array>; outcome: CapacityOutcome } {
  const reader = upstream.getReader();
  const outcome: CapacityOutcome = { retry: false, afterOutput: false, holdTimedOut: false, bufferLimit: false, maxHeldBytes: 0 };
  let held: Buffer[] = []; let heldBytes = 0; let pending = Buffer.alloc(0);
  let chunk: Uint8Array | null = null; let offset = 0;
  let scan = 0; let lineStart = 0; let eof = false;
  let output = false; let holding = true; let deadline: number | null = null; let cancelled = false;
  type Frame = { bytes: Buffer; raw: boolean };
  let rawFrame = false;
  let pendingFrame: Promise<Frame | null> | null = null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = Symbol('hold deadline');
  // One queued frame at most; held preamble is yielded one frame per pull.
  const flush = function* (): Generator<Buffer> { for (const frame of held) { heldBytes -= frame.length; yield frame; } held = []; };
  const maximum = (): void => { outcome.maxHeldBytes = Math.max(outcome.maxHeldBytes, pending.length + heldBytes); };
  const takeFrame = (end: number): Buffer => {
    const frame = Buffer.from(pending.subarray(0, end));
    pending = Buffer.from(pending.subarray(end)); scan = 0; lineStart = 0;
    return frame;
  };
  // Incremental LF/CRLF/CR framing. A trailing CR waits for its optional LF,
  // including when the two bytes arrive in different upstream chunks.
  const frameEnd = (): number => {
    while (scan < pending.length) {
      const byte = pending[scan];
      if (byte !== 10 && byte !== 13) { scan++; continue; }
      if (byte === 13 && scan + 1 === pending.length && !eof) return -1;
      const end = scan + (byte === 13 && pending[scan + 1] === 10 ? 2 : 1);
      const blank = scan === lineStart; scan = end; lineStart = end;
      if (blank) return end;
    }
    return -1;
  };
  const takePartial = (): Buffer => { const bytes = pending; pending = Buffer.alloc(0); scan -= bytes.length; lineStart -= bytes.length; return bytes; };
  const readFrame = async (): Promise<Frame | null> => {
    for (;;) {
      const end = frameEnd();
      if (end >= 0) { const raw = rawFrame; rawFrame = false; return { bytes: takeFrame(end), raw }; }
      if (eof || cancelled) return pending.length ? { bytes: takeFrame(pending.length), raw: rawFrame } : null;
      // After output, a frame whose leading data type is already known to be
      // non-failure can flow immediately, including a terminal frame cut short
      // by the client. Continue tracking its boundary before inspecting again.
      const type = /^data:\s*\{\s*"type"\s*:\s*"([^"\\]+)"/m.exec(pending.subarray(0, 1024).toString('utf8'))?.[1];
      const prefix = pending.subarray(0, 24).toString('latin1');
      const opaque = prefix.length > 0 && !['event:', 'data:', 'id:', 'retry:', ':', '\n', '\r'].some((field) => prefix.startsWith(field) || field.startsWith(prefix));
      if (pending.length && (opaque || (output && (rawFrame || (type && type !== 'response.failed'))))) { rawFrame = true; return { bytes: takePartial(), raw: true }; }
      if (!chunk || offset === chunk.length) { const result = await reader.read(); if (cancelled) return null; if (result.done) { eof = true; continue; } chunk = result.value; offset = 0; }
      const room = SSE_MAX_FRAME_BYTES - pending.length - heldBytes;
      if (room === 0) {
        if (heldBytes) return { bytes: Buffer.alloc(0), raw: false }; // release held preamble, then resume this same frame
        outcome.bufferLimit = true; return null;
      }
      const length = Math.min(room, chunk.length - offset);
      if (!length) continue;
      const piece = Buffer.from(chunk.subarray(offset, offset + length)); offset += length;
      pending = pending.length ? Buffer.concat([pending, piece]) : piece; maximum();
    }
  };
  const frames = async function* (): AsyncGenerator<Buffer> {
    try {
      for (;;) {
        let part: Frame | null;
        const read = pendingFrame ?? readFrame(); pendingFrame = null;
        if (holding && heldBytes && holdMs > 0) {
          const remaining = Math.max(0, deadline! - Date.now());
          const wait = new Promise<typeof timeout>((resolve) => { timer = setTimeout(() => resolve(timeout), remaining); });
          let result: Frame | null | typeof timeout;
          try { result = await Promise.race([read, wait]); } finally { clearTimeout(timer); timer = undefined; }
          if (result === timeout) { pendingFrame = read; holding = false; outcome.holdTimedOut = true; yield* flush(); continue; }
          part = result;
        } else part = await read;
        if (cancelled) return;
        if (part === null) { yield* flush(); return; }
        const frame = part.bytes;
        if (!frame.length) { holding = false; yield* flush(); continue; }
        const kind = part.raw ? 'output' : classify(frame);
        if (kind === 'capacity') { if (output) outcome.afterOutput = true; else outcome.retry = true; return; }
        if (kind === 'output') { output = true; holding = false; yield* flush(); yield frame; }
        else if (holding) { if (!heldBytes) deadline = Date.now() + holdMs; held.push(frame); heldBytes += frame.length; maximum(); }
        else yield frame;
      }
    } catch (error) {
      // Preserve a non-capacity tail when upstream breaks mid-frame, before
      // propagating its read error on the next pull.
      yield* flush();
      if (pending.length && classify(pending) !== 'capacity') yield pending;
      throw error;
    } finally { clearTimeout(timer); held = []; heldBytes = 0; pending = Buffer.alloc(0); chunk = null; await reader.cancel().catch(() => {}); }
  };
  const iterator = frames();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) { const next = await iterator.next(); if (cancelled) return; if (next.done) controller.close(); else controller.enqueue(next.value); },
    async cancel() { cancelled = true; clearTimeout(timer); await reader.cancel().catch(() => {}); await iterator.return(undefined); },
  });
  return { stream, outcome };
}
