import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { AccountPool } from './account-pool.js';
import { ActivityLog, type ActivitySink } from './activity.js';
import type { Route } from './routes.js';
import type { Provider, RuntimeAccount } from './types.js';

// Upper bound on waiting for upstream response headers only. Never applies to the body.
const HEADER_TIMEOUT_MS = 300_000;

// The largest request body the relay accepts, in MB (MiB), from
// proxy.maxBodyMb. It used to be a fixed 32 MB, and a long Codex session that
// had opened several screenshots outgrew it: the relay answered 413 itself,
// /compact (which resends the same history) hit the same 413, and the session
// was lost without the request ever reaching OpenAI (2026-10-17). The default
// is not smaller than either upstream: OpenAI documents up to 512 MB per
// request, Anthropic's Messages API 32 MB. Above the upstream's own limit the
// upstream answers, and that answer goes back to the client as it is.
export const DEFAULT_MAX_BODY_MB = 512;
// Node 20's Buffer cannot hold more than 4 GiB.
const MAX_BODY_MB_CEILING = 4096;
const MB = 1024 * 1024;

// proxy.maxBodyMb as bytes, or a startup error that says what is wrong with it.
export function maxBodyBytes(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_BODY_MB * MB;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_BODY_MB_CEILING) throw new Error(`proxy.maxBodyMb must be a number of megabytes above 0 and at most ${MAX_BODY_MB_CEILING}, not ${JSON.stringify(value)}`);
  return Math.floor(value * MB);
}

export function formatBytes(bytes: number): string { return `${(bytes / MB).toFixed(1)} MB (${bytes} bytes)`; }

class BodyTooLarge extends Error {
  constructor(readonly size: number, readonly limit: number) { super(`Request body is ${formatBytes(size)}, over the relay's ${formatBytes(limit)} limit (proxy.maxBodyMb in config.json)`); }
}

export function secureEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b); const size = Math.max(aa.length, bb.length, 1); const pa = Buffer.alloc(size); const pb = Buffer.alloc(size); aa.copy(pa); bb.copy(pb);
  return timingSafeEqual(pa, pb) && aa.length === bb.length;
}
function authorized(req: IncomingMessage, token: string): boolean { const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || ''); return secureEqual(raw, token); }
// The body is held whole, not streamed through: a failover (quota, transient,
// auth refresh, network error, reset credit) resends the same bytes to another
// account, Claude's body is rewritten per account, and the account itself is
// chosen from the body's model and session. Chunks are kept as the socket
// delivered them (no per-chunk copy). Past the limit the rest is read and
// dropped, only counted, so the 413 names the real size and the client is not
// cut off mid-upload before it can read the answer.
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  const parts: Buffer[] = []; let size = 0; let over = Number.isFinite(declared) && declared > limit;
  for await (const chunk of req) { const value = chunk as Buffer; size += value.length; if (size > limit) over = true; if (!over) parts.push(value); }
  if (over) throw new BodyTooLarge(size, limit);
  return parts.length === 1 ? parts[0]! : Buffer.concat(parts, size);
}
// "network error" alone hid whether a token refresh or the upstream call
// failed, and why: fetch wraps the socket error, so the code lives on cause.
export function describeError(error: unknown): string {
  const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const code = err?.cause?.code; const detail = err?.cause?.message || err?.message || String(error);
  return code ? `${code} ${detail}` : detail;
}
function incomingHeaders(req: IncomingMessage): Headers { const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) { if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v !== undefined) headers.set(k, v); } return headers; }
// Which session a request belongs to, for account affinity. The provider reads
// the client's own id (Claude Code's x-claude-code-session-id, Codex's
// session-id); a request that names none is keyed by its connection, so a
// keep-alive client still sticks. Connection identity, not the port number: a
// port is recycled by the OS the moment a connection closes, and two unrelated
// sessions used to share one key that way while one session's parallel
// connections were spread over several accounts.
const connectionIds = new WeakMap<Socket, string>();
function connectionId(socket: Socket): string { let id = connectionIds.get(socket); if (!id) { id = randomUUID(); connectionIds.set(socket, id); } return id; }
function sessionKey(provider: Provider, req: IncomingMessage, body: Buffer): string { return provider.sessionKey?.(incomingHeaders(req), body) || connectionId(req.socket); }

// Request ids for the activity log: unique per process, shared by the main
// port and its legacy aliases.
let requestCounter = 0;

// Per-request bookkeeping dispatch fills in for the activity line. cut marks
// an upstream stream that broke after the headers went out; finished is the
// terminal SSE event the stream delivered, if any.
interface RequestTrack { cut: boolean; finished?: StreamEnd | null; setAccount(label: string, outsideRoute?: boolean): void }

// The body parsed once, for the fields the activity line shows. Not kept.
function parsedBody(body: Buffer): unknown {
  if (body.length === 0) return null;
  try { return JSON.parse(body.toString('utf8')) as unknown; } catch { return null; }
}

// Never let the activity log take a request down with it.
function safely(fn: () => void): void { try { fn(); } catch { /* activity is best-effort */ } }

// What the client ended up with. A finished response says it; a response the
// client abandoned first is 499; a stream upstream broke is 'cut'. A stream
// whose terminal event went out is finished even if the client hung up before
// upstream's EOF: Codex CLI closes the moment it reads response.completed, and
// 38 of 39 Codex requests were logged as 499 that way (2026-10-17), every one
// of them a complete answer, indistinguishable from a real abort.
function finalStatus(res: ServerResponse, track: RequestTrack): number | string {
  if (track.cut) return 'cut';
  if (res.writableEnded || (track.finished && res.headersSent)) return res.statusCode;
  return res.headersSent || res.destroyed ? 499 : 502;
}

export function createProxy(pool: AccountPool, clientToken: string, onChange: (event?: string) => void, capacity?: () => number, activity: ActivitySink = new ActivityLog((event) => onChange(event.message)), bodyLimit = DEFAULT_MAX_BODY_MB * MB): Server {
  return createServer(async (req, res) => {
    let opened: string | null = null; let track: RequestTrack = { cut: false, setAccount: () => {} };
    try {
      if (!authorized(req, clientToken)) return json(res, 401, { error: 'Unauthorized local client' });
      const path = pool.provider.normalizePath(req.url || '/');
      if (!path) return json(res, 404, { error: 'Unsupported proxy path' });
      const id = String(++requestCounter);
      const begin = (): void => safely(() => activity.start({ id, provider: pool.provider.id, providerLabel: pool.provider.label, method: req.method || 'GET', path, account: null, startedAt: Date.now() }));
      // Admission control: reject before buffering a body. localhost is trusted,
      // so a flood of local clients could otherwise pin one full body each.
      // The counter lives on the pool so the main port and its legacy aliases
      // share one budget. Drain the request first or the socket leaks. The
      // refusal still gets its line, or a saturated relay looks idle.
      if (capacity && pool.inFlightProxied >= capacity()) {
        req.resume(); begin(); opened = id;
        return json(res, 429, { error: `${pool.provider.label} relay is at capacity` }, { 'retry-after': '5', 'x-teamai-429-reason': 'concurrency_saturated' });
      }
      pool.inFlightProxied++;
      // The line opens before the body is read, so a large upload already shows.
      begin(); opened = id;
      track = { cut: false, setAccount: (label, outsideRoute) => safely(() => activity.update(id, outsideRoute === undefined ? { account: label } : { account: label, routeFallback: outsideRoute })) };
      try {
        let body: Buffer;
        try { body = await readBody(req, bodyLimit); } catch (error) {
          if (!(error instanceof BodyTooLarge)) throw error;
          // Never forwarded, so nothing upstream records it: the size and the
          // limit go to the log; the body itself is not kept or shown.
          onChange(`${pool.provider.label} ${req.method} ${path} → 413 request body ${formatBytes(error.size)} exceeds proxy.maxBodyMb ${formatBytes(error.limit)}`);
          return json(res, 413, { error: { type: 'request_too_large', message: error.message } }, { 'x-teamai-413-reason': 'body_limit' });
        }
        // Session, model and effort for the activity line — three fields, read
        // once; nothing else from the body leaves this function.
        const parsed = parsedBody(body);
        const identity = pool.provider.displayIdentity?.(incomingHeaders(req), parsed);
        if (identity) safely(() => activity.update(id, identity));
        // A model route, if the requested model matches one.
        const model = (parsed as { model?: unknown } | null)?.model;
        const route = pool.routeFor(typeof model === 'string' ? model : null);
        if (route) safely(() => activity.update(id, { route: route.name }));
        await dispatch(req, res, body, path, pool, sessionKey(pool.provider, req, body), onChange, track, route);
      } finally { pool.inFlightProxied--; }
    } catch (error) { if (!res.headersSent) json(res, (error as { status?: number }).status || 502, { error: (error as Error).message }); else res.destroy(error as Error); }
    finally {
      // Every line that opened is closed exactly once, whatever happened above.
      if (opened) { const id = opened; const status = finalStatus(res, track); safely(() => activity.end(id, status)); }
    }
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse, body: Buffer, path: string, pool: AccountPool, session: string, onChange: (event?: string) => void, track: RequestTrack, route: Route | null = null): Promise<void> {
  const excluded = new Set<string>(); let authRetried = false;
  // Decided once from the request body: the retry loop must not re-read a body
  // it has already forwarded, and the answer cannot change between failovers.
  const wantsFable = pool.provider.usesFableBudget?.(path, body) ?? false;
  let lastFailure: { response: Response; body: string; transient: boolean } | null = null;
  const transientAccounts = new Set<string>();
  // A 403 benches an account for 30 minutes, but the same 403 from every
  // account means the request is refused, not the accounts: one such request
  // swept the whole Codex fleet into a simultaneous 30-minute cooldown at 16-19%
  // weekly usage (2026-10-09/10, three times). Hold the bench until another
  // account proves it can serve this request.
  const forbidden: Array<{ account: RuntimeAccount; ms: number }> = [];
  let retryRounds = 0;
  let retryWaitMs = 0;
  let nextRetryAt = 0;
  // Reset credits (Codex): one chance per request to spend a ticket, used up
  // by any attempt that reached the backend. creditRetried keeps a request
  // from going back to one account twice on a ticket; staleRetried does the
  // same for an answer that predates a reset; retryOn is that account.
  let creditPass = pool.resetCredits.enabled && pool.provider.id === 'codex';
  const creditRetried = new Set<string>(); const staleRetried = new Set<string>();
  let retryOn: RuntimeAccount | null = null;
  while (!res.destroyed) {
    const forced: RuntimeAccount | null = retryOn; retryOn = null;
    const account: RuntimeAccount | null = forced && pool.claim(forced, excluded, wantsFable) ? forced : pool.acquire(session, excluded, wantsFable, route);
    if (!account) {
      // Exhausting this request's candidates does not mean exhausting quota.
      // Only retry explicit pre-stream transient HTTP failures; never replay a
      // successful/partially streamed response. Keep retries in the relay.
      if (lastFailure) {
        const delay = Math.max(1000 * 2 ** retryRounds, nextRetryAt - Date.now()) + Math.floor(Math.random() * 200);
        if (lastFailure.transient && transientAccounts.size && retryRounds < 2 && delay <= 10_000 && retryWaitMs + delay <= 20_000) {
          retryRounds++; retryWaitMs += delay;
          onChange(`${pool.provider.label} transient retry ${retryRounds}/2 after ${delay}ms`);
          await waitForRetry(delay, res);
          if (res.destroyed) return;
          for (const id of transientAccounts) excluded.delete(id);
          transientAccounts.clear(); nextRetryAt = 0;
          continue;
        }
      }
      // The quota dead end: no account has budget (a busy fleet is not one).
      // A reset credit can reopen an account; on a reset, that account is back
      // in play for this request.
      if (creditPass && pool.explainShortfall(excluded, wantsFable, route).reason === 'quota_exhausted') {
        const redeemed = await pool.redeemForFleet(excluded, wantsFable, (a) => route?.mode !== 'exclusive' || pool.isMember(route, a));
        if (redeemed.attempted) creditPass = false;
        if (res.destroyed) return;
        if (redeemed.reset) { excluded.delete(redeemed.reset.id); continue; }
        if (redeemed.yielded) continue;
      }
      if (lastFailure) {
        copyHeaders(lastFailure.response, res);
        res.writeHead(lastFailure.response.status); res.end(lastFailure.body);
        onChange(`${pool.provider.label} ${req.method} ${path} → ${lastFailure.response.status} upstream failure preserved`);
        return;
      }
      // Say what is actually short — a free slot (retry in a moment) or budget
      // (and whose, and until when) — and leave a trace in the activity log:
      // this 429 never reached upstream, so nothing else records it.
      const shortfall = pool.explainShortfall(excluded, wantsFable, route);
      onChange(`${pool.provider.label} ${req.method} ${path} → 429 ${shortfall.reason}${wantsFable ? ' (fable)' : ''}${shortfall.retryAfterMs ? `, next reset ${AccountPool.formatDuration(shortfall.retryAfterMs)}` : ''}`);
      const headers: Record<string, string> = { 'x-teamai-429-reason': shortfall.reason };
      // Claude Code honours retry-after; cap it so a days-away weekly reset
      // does not park a session for days when a session window may roll first.
      if (shortfall.retryAfterMs) headers['retry-after'] = String(Math.min(900, Math.ceil(shortfall.retryAfterMs / 1000)));
      return json(res, 429, { error: shortfall.message }, headers);
    }
    track.setAccount(account.label, route ? !pool.isMember(route, account) : undefined);
    let response: Response;
    let phase = 'token refresh';
    let dispatchedAt = Date.now();
    try {
      await pool.refresh(account);
      phase = 'upstream';
      const headers = pool.provider.buildHeaders(incomingHeaders(req), account);
      const sendBody = pool.provider.rewriteBody(body, account);
      headers.set('content-length', String(sendBody.length));
      // Handed to fetch as it is: fetch copies the bytes once on its own, and
      // a second copy made here held a large body three times per attempt.
      // Every Buffer here is backed by a plain ArrayBuffer.
      // AbortSignal.timeout(300_000) used to sit here, and it kept running
      // while the body streamed: a turn that thought for more than five
      // minutes was cut at exactly 300s and Claude Code showed "Connection
      // lost mid-response" (2026-09-20, two turns). The guard is only meant
      // to stop a request that never answers, so it is disarmed the moment
      // headers arrive; a streaming body has no time limit. A client that
      // goes away mid-stream is handled in pipeStream, so no slot leaks.
      const headerGuard = new AbortController();
      dispatchedAt = Date.now();
      const headerTimer = setTimeout(() => headerGuard.abort(new Error('upstream sent no response headers within 300s')), HEADER_TIMEOUT_MS);
      try {
        response = await fetch(`${pool.provider.upstreamBase}${path}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : sendBody as Uint8Array<ArrayBuffer>, signal: headerGuard.signal });
      } finally { clearTimeout(headerTimer); }
    } catch (error) {
      // A dropped connection is the network, not the account: on 2026-10-14
      // ETIMEDOUT bursts hit every account within seconds, the fleet was
      // exhausted in one pass and Claude Code got a bare 502. Mark it transient
      // so the relay's bounded retry rounds (≤2, ≤20s) get another try first.
      lastFailure = { response: new Response(null, { status: 502 }), body: JSON.stringify({ error: 'Upstream connection failed' }), transient: true };
      // The retry must outwait the 2s network cooldown, or a small fleet finds
      // every account still cooling and gives up on the first round.
      transientAccounts.add(account.id); nextRetryAt = Math.max(nextRetryAt, Date.now() + 2_100);
      pool.release(account); pool.cooldown(account, 2_000, 'network'); excluded.add(account.id); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} network error (${phase}: ${describeError(error)}); failover`);
      continue;
    }
    const observed = pool.observeResponse(account, response.headers, dispatchedAt, response.status);
    if (!response.ok) {
      // Read the error body before releasing the slot, but never leak the slot
      // if the read itself fails: an upstream that closes the connection
      // mid-body used to throw out of here with inflight still counted, and
      // after enough such cuts the account sat at its concurrency cap with
      // quota to spare, shown active, serving nothing until a restart.
      let errorBody: string;
      try { errorBody = await response.text(); } catch (error) { pool.release(account); throw error; }
      const decision = pool.provider.classifyFailure(response.status, response.headers, errorBody);
      pool.release(account);
      // A transient failure keeps its place as the request's failure of record:
      // a later quota or forbidden rejection on another account must not turn
      // a retryable 503 into a quota answer while retry rounds remain.
      if (!(lastFailure?.transient && transientAccounts.size && decision.kind !== 'transient')) lastFailure = { response, body: errorBody, transient: decision.kind === 'transient' };
      if (decision.kind === 'auth' && !authRetried) {
        authRetried = true;
        try { await pool.refresh(account, true); } catch (error) { pool.fail(account, (error as Error).message); excluded.add(account.id); }
        onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} auth refresh`); continue;
      }
      if (decision.kind === 'quota' || decision.kind === 'model-quota') pool.commitProbeFromQuotaRejection(path, incomingHeaders(req), body, response.headers);
      // Only the top model's budget is gone. Benching the account would idle it
      // for days over a window that other models never touch, so it is skipped
      // for this request only — and its Fable window is marked spent so ranking
      // stops sending Fable here without another rejection to learn from.
      if (decision.kind === 'model-quota') {
        pool.markFableSpent(account, decision.retryAfterMs);
        excluded.add(account.id);
        onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} fable-quota; failover`);
        if (excluded.size < pool.accounts.length) continue;
      }
      // A transient 429 is a request-rate spike, not exhaustion: the account
      // still has token quota, it is just being hit too fast. Do NOT cool it
      // down — a request-rate/global 429 throttled onto the account would poison
      // the fleet for unrelated requests, and a burst across the fleet would
      // bench every account at once. Exclude it for THIS request only and fail
      // over; when no account remains, bounded retry rounds run above before
      // the original error is returned. No quota state is mutated.
      if (decision.kind === 'transient') {
        excluded.add(account.id); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} transient; failover`);
        transientAccounts.add(account.id);
        nextRetryAt = Math.max(nextRetryAt, Date.now() + decision.retryAfterMs);
        continue;
      }
      onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} ${decision.kind} body: ${errorBody.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (decision.kind === 'forbidden') {
        excluded.add(account.id);
        if (forbidden.length) {
          copyHeaders(response, res); res.writeHead(response.status); res.end(errorBody);
          onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} on a second account; request refused, no cooldown`);
          return;
        }
        forbidden.push({ account, ms: decision.retryAfterMs });
        onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} forbidden; failover (bench pending)`);
        continue;
      }
      if (decision.kind === 'quota') {
        // Sent before a reset credit was spent on this account: the rejection
        // describes the old windows. Try the account again rather than bench it.
        if (observed === 'stale' && !staleRetried.has(account.id)) {
          staleRetried.add(account.id); retryOn = account;
          onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} predates its reset credit; retrying`);
          continue;
        }
        // Account policy: spend a ticket on the account that just ran out and
        // go straight back to it, once.
        if (creditPass && pool.resetCredits.policy === 'account' && !creditRetried.has(account.id)) {
          const redeemed = await pool.redeemResetCredit(account, '429-exhausted', { enforce: true });
          if (!redeemed.skipped) creditPass = false;
          if (!redeemed.skipped && redeemed.kind === 'reset') { creditRetried.add(account.id); retryOn = account; continue; }
        }
        pool.cooldown(account, decision.retryAfterMs, decision.kind); excluded.add(account.id); onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} ${decision.kind}; failover`);
        // A spent account after a transient one must not end the request: the
        // transient account still has its retry rounds, and the decision block
        // at the top of the loop owns that — it returns the preserved failure
        // itself when no retry applies. Returning here abandoned the transient
        // retry and answered a 2-second 503 with a quota 429.
        if (transientAccounts.size) lastFailure = { response: lastFailure!.response, body: lastFailure!.body, transient: true };
        continue;
      }
      copyHeaders(response, res); res.writeHead(response.status); res.end(errorBody); return;
    }
    for (const item of forbidden) { pool.cooldown(item.account, item.ms, 'forbidden'); onChange(`${pool.provider.label} ${item.account.label} benched: 403 while ${account.label} served the same request`); }
    pool.commitProbe(path, incomingHeaders(req), body, response.headers);
    copyHeaders(response, res); res.writeHead(response.status);
    // A stream that breaks after the 200 was written used to be logged as a
    // plain 200, indistinguishable from success; the client saw a destroyed
    // socket ("error decoding response body") and the relay showed nothing.
    let cut: string | null = null;
    try {
      if (!response.body) res.end();
      else await pipeStream(response.body, res, isEventStream(response.headers) ? new SseWatcher((end) => { track.finished = end; }) : null);
    } catch (error) { cut = (error as Error).message; track.cut = true; throw error; }
    // The finished-request line itself comes from the activity log; only a
    // cut, with its cause, needs a sentence of its own.
    finally { pool.release(account); if (cut) onChange(`${pool.provider.label} ${req.method} ${path} → ${account.label} ${response.status} stream cut mid-body: ${cut}`); }
    return;
  }
}

// Cancellation must release admission capacity without waiting out backoff.
async function waitForRetry(ms: number, res: ServerResponse): Promise<void> {
  if (res.destroyed) return;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); res.removeListener('close', done); resolve(); };
    const timer = setTimeout(done, ms);
    res.once('close', done);
  });
}

// Forward the upstream body chunk by chunk, honouring backpressure. The client
// can vanish mid-stream (Esc, a cancelled tool, a retry): a destroyed response
// returns false from write() and never emits 'drain', so waiting on drain alone
// hung here forever and the account's inflight slot leaked until restart. On
// close the upstream read is cancelled too, so the model stops generating into
// the void instead of spending the account's quota on a response nobody reads.
async function pipeStream(body: ReadableStream<Uint8Array>, res: ServerResponse, watcher: SseWatcher | null = null): Promise<void> {
  const reader = body.getReader();
  const closed = new Promise<void>((resolve) => { if (res.destroyed) resolve(); else res.once('close', () => resolve()); });
  const onClose = () => { void reader.cancel().catch(() => {}); };
  res.once('close', onClose);
  try {
    while (!res.destroyed) {
      const part = await reader.read(); if (part.done) break;
      if (res.destroyed) break;
      // The watcher reads what was just written, after it is on its way:
      // the bytes are untouched and nothing waits on the parse.
      const flowing = res.write(Buffer.from(part.value)); watcher?.feed(part.value);
      if (!flowing && !res.destroyed) await Promise.race([new Promise<void>((resolve) => res.once('drain', resolve)), closed]);
    }
    if (!res.destroyed) res.end();
  } finally { res.removeListener('close', onClose); await reader.cancel().catch(() => {}); }
}

// How a streamed response said it was over. Codex Responses ends with
// response.completed (response.done in some versions), response.incomplete
// (stopped early, e.g. at max_output_tokens) or response.failed; Claude
// Messages with message_stop. Each is the last event of a response that
// upstream finished, so a client hanging up after one has abandoned nothing.
export type StreamEnd = 'completed' | 'incomplete' | 'failed';
const STREAM_ENDS: Record<string, StreamEnd> = { 'response.completed': 'completed', 'response.done': 'completed', 'response.incomplete': 'incomplete', 'response.failed': 'failed', message_stop: 'completed' };

// chatgpt.com's /codex/responses sends its SSE stream with no content-type at
// all, so an absent type is watched too. Any other declared type (JSON, text)
// is not: the watcher only ever turns a 499 into a finished request, and a body
// that says it is not an event stream has no terminal event to find.
function isEventStream(headers: Headers): boolean { const type = headers.get('content-type')?.trim() ?? ''; return type === '' || /^text\/event-stream\b/i.test(type); }

// Watches an SSE body for its terminal event without holding it: events are
// cut at blank lines across chunk boundaries (LF, CRLF or CR), and of each
// line only the first bytes are kept — enough for `event: <name>` or the
// leading `"type"` of a data line, never a whole response.completed payload.
// The event name comes from the event field, else from the data's type.
export class SseWatcher {
  static readonly HEAD = 256;
  private head: Buffer[] = []; private headBytes = 0; private afterCr = false;
  private event = ''; private dataType = ''; private sawData = false;
  ended: StreamEnd | null = null;
  constructor(private readonly onEnd: (end: StreamEnd) => void = () => {}) {}

  // Bytes kept of the line being read; never more than HEAD.
  get held(): number { return this.headBytes; }

  feed(chunk: Uint8Array): void {
    // fetch's reader can deliver an empty chunk. It says nothing, and must not
    // clear afterCr: the LF that follows would then end a blank line that was
    // never sent, and an event would count as finished before it is.
    if (chunk.length === 0) return;
    let start = 0;
    // A CRLF split across chunks: the LF belongs to the line already ended.
    if (this.afterCr && chunk[0] === 10) start = 1;
    this.afterCr = false;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start); const cr = chunk.indexOf(13, start);
      const stop = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
      if (stop < 0) { this.keep(chunk, start, chunk.length); return; }
      this.keep(chunk, start, stop); this.line();
      start = stop + 1;
      if (chunk[stop] === 13) { if (start === chunk.length) this.afterCr = true; else if (chunk[start] === 10) start++; }
    }
  }

  private keep(chunk: Uint8Array, from: number, to: number): void {
    const room = SseWatcher.HEAD - this.headBytes; if (room <= 0 || to <= from) return;
    const piece = Buffer.from(chunk.buffer, chunk.byteOffset + from, Math.min(to - from, room));
    this.head.push(piece); this.headBytes += piece.length;
  }

  private line(): void {
    const text = this.head.length === 1 ? this.head[0]!.toString('latin1') : Buffer.concat(this.head).toString('latin1');
    this.head = []; this.headBytes = 0;
    if (text === '') return this.dispatch();
    if (text.startsWith('event:')) this.event = text.slice(6).trim();
    else if (text.startsWith('data:') && !this.sawData) { this.sawData = true; this.dataType = /"type"\s*:\s*"([^"\\]+)"/.exec(text)?.[1] ?? ''; }
  }

  private dispatch(): void {
    const end = STREAM_ENDS[this.event || this.dataType];
    this.event = ''; this.dataType = ''; this.sawData = false;
    if (end && !this.ended) { this.ended = end; this.onEnd(end); }
  }
}

// fetch decompresses the upstream body transparently, so what we forward is
// already plain text. Passing its content-encoding through would tell the
// client to decompress it a second time — the client then fails on a body that
// was never compressed (BrotliDecompressionError). content-length is dropped
// for the same reason: it describes the compressed length.
function copyHeaders(response: Response, res: ServerResponse): void { for (const [key, value] of response.headers) if (!['connection', 'transfer-encoding', 'content-length', 'content-encoding'].includes(key)) res.setHeader(key, value); }
function json(res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); }
