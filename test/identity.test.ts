import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { ActivityLog } from '../src/activity.js';
import { buildFrame } from '../src/frame.js';
import { createProxy } from '../src/proxy.js';
import { claudeProvider, codexProvider } from '../src/providers.js';
import { redactSnapshot } from '../src/redact.js';
import type { ActivityEvent, PersistedState, Provider, StoredAccount, TeamAIConfig } from '../src/types.js';

const U1 = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'; const U2 = '0199ffff-0000-7000-8000-000000000002';
const id = (provider: Provider, headers: Record<string, string>, body: unknown) => provider.displayIdentity!(new Headers(headers), body);

test('Codex: session from header, then client_metadata, then thread ids — UUIDs only', () => {
  assert.equal(id(codexProvider, { 'session-id': U1 }, { client_metadata: { session_id: U2 } }).sessionId, U1, 'header wins');
  assert.equal(id(codexProvider, {}, { client_metadata: { session_id: U2 } }).sessionId, U2);
  assert.equal(id(codexProvider, { 'thread-id': U1 }, {}).sessionId, U1);
  assert.equal(id(codexProvider, {}, { client_metadata: { thread_id: U2 } }).sessionId, U2);
  assert.equal(id(codexProvider, { 'x-codex-window-id': `${U1}:3` }, {}).sessionId, U1);
  assert.equal(id(codexProvider, { 'session-id': 'not-a-uuid' }, {}).sessionId, null);
  assert.equal(id(codexProvider, {}, null).sessionId, null, 'unparseable body');
  // The routing handles are not session ids.
  assert.equal(id(codexProvider, {}, { prompt_cache_key: U1, previous_response_id: 'resp_1' }).sessionId, null);
  assert.equal(codexProvider.sessionKey!(new Headers(), Buffer.from(JSON.stringify({ prompt_cache_key: U1 }))), U1, 'routing still uses them');
  assert.deepEqual(id(codexProvider, {}, { model: 'gpt-6-astra', reasoning: { effort: 'high' } }), { sessionId: null, model: 'gpt-6-astra', effort: 'high' });
});

test('Claude: session from the header, else metadata.user_id; effort from output_config', () => {
  const userId = JSON.stringify({ device_id: 'dev', account_uuid: 'acct', session_id: 'abc-123' });
  assert.equal(id(claudeProvider, { 'x-claude-code-session-id': 'hdr_1' }, { metadata: { user_id: userId } }).sessionId, 'hdr_1');
  assert.equal(id(claudeProvider, {}, { metadata: { user_id: userId } }).sessionId, 'abc-123');
  assert.equal(id(claudeProvider, { 'x-claude-code-session-id': 'bad id\x1b' }, {}).sessionId, null);
  assert.deepEqual(id(claudeProvider, {}, { model: 'claude-opus-5', output_config: { effort: 'max' } }), { sessionId: null, model: 'claude-opus-5', effort: 'max' });
  assert.equal(id(claudeProvider, {}, { model: 42 }).model, null);
});

test('model and effort are cleaned and capped before they are stored', () => {
  const events: ActivityEvent[] = []; const log = new ActivityLog((e) => events.push(e));
  log.start({ id: '1', provider: 'codex', providerLabel: 'Codex', method: 'POST', path: '/', account: null, startedAt: 0 });
  log.update('1', { model: `gpt\x1b[2J  six${'x'.repeat(80)}`, effort: 'very-very-high-effort-indeed', sessionId: U1 });
  const entry = log.snapshot()[0]!;
  assert.equal(entry.model!.includes('\x1b'), false); assert.equal(entry.model!.length, 64); assert.match(entry.model!, /^gpt \[2J six/);
  assert.equal(entry.effort!.length, 16);
  log.end('1', 200, 1);
  assert.equal(events[0]!.request!.sessionId, U1); assert.match(events[0]!.message, /\(gpt \[2J six/);
});

test('the relay reports the client session and model, and never its own connection id', async () => {
  const upstream = createServer((req, res) => { req.resume(); req.once('end', () => { res.writeHead(200); res.end('ok'); }); });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r)); const up = upstream.address(); assert(up && typeof up !== 'string');
  const provider: Provider = { ...codexProvider, upstreamBase: `http://127.0.0.1:${up.port}` };
  const stored: StoredAccount = { id: 'a', provider: 'codex', label: 'a', enabled: true, priority: 1, credentialId: 'a', createdAt: '' };
  const pool = new AccountPool(provider, [stored], { a: { accessToken: 's', refreshToken: null, expiresAt: Date.now() + 3_600_000, accountId: 'a' } }, { version: 1, accounts: {} });
  const events: ActivityEvent[] = []; const updates: unknown[] = []; const log = new ActivityLog((e) => events.push(e));
  const proxy = createProxy(pool, 'tok', () => {}, undefined, { start: (e) => log.start(e), update: (i, p) => { updates.push(p); log.update(i, p); }, end: (i, s) => log.end(i, s) });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const pa = proxy.address(); assert(pa && typeof pa !== 'string');
  const call = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${pa.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: 'gpt-6-astra', reasoning: { effort: 'high' }, input: 'secret prompt' }) });
  try {
    await (await call({ 'session-id': U1 })).text();
    await (await call({})).text();
    assert.equal(events[0]!.request!.sessionId, U1); assert.equal(events[0]!.request!.model, 'gpt-6-astra'); assert.equal(events[0]!.request!.effort, 'high');
    assert.equal(events[1]!.request!.sessionId, null, 'no session named: blank, not a made-up connection id');
    assert.equal(JSON.stringify([events, updates]).includes('secret prompt'), false, 'the body itself is never stored');
  } finally { proxy.close(); upstream.close(); }
});

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (line: string): string => line.replace(ANSI, '');
const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [] };
const req = (sessionId: string | null, model: string | null, effort: string | null = null) => ({ provider: 'codex' as const, providerLabel: 'Codex', method: 'POST', path: '/codex/responses', account: 'acct-2', status: 200, durationMs: 41_700, sessionId, model, effort });

test('session tags keep methods aligned and a session keeps its colour', () => {
  const state: PersistedState = { version: 1, accounts: {}, events: [
    { at: 1, message: 'm', request: req(U1, 'gpt-6-astra', 'high') },
    { at: 2, message: 'm', request: req(null, 'gpt-6-astra') },
    { at: 3, message: 'm', request: req(U1, null) },
  ] };
  const raw = buildFrame(config, state, { width: 120, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true });
  const lines = raw.map(plain); const rows = lines.filter((l) => l.includes('Codex POST'));
  assert.equal(rows.length, 3);
  const columns = rows.map((l) => l.indexOf('Codex POST')); assert.equal(new Set(columns).size, 1, 'method column fixed');
  assert.match(rows[2]!, /^ {2}\d\d:\d\d:\d\d {2}0199a1 Codex POST \/codex\/responses \(gpt-6-astra·high\) → acct-2 \(200, 41\.7s\)/);
  assert.match(rows[1]!, /^ {2}\d\d:\d\d:\d\d {9}Codex POST \/codex\/responses \(gpt-6-astra\) → acct-2/);
  const colours = raw.filter((l) => plain(l).includes('0199a1')).map((l) => new RegExp(`${String.fromCharCode(27)}\\[(\\d+)m0199a1`).exec(l)?.[1]);
  assert.equal(colours.length, 2); assert.equal(colours[0], colours[1]); assert.notEqual(colours[0], '31');
  const narrow = buildFrame(config, { ...state, events: [{ at: 1, message: 'm', request: req(U1, 'm'.repeat(64), 'x'.repeat(16)) }] }, { width: 80, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).map(plain);
  assert.ok(narrow.every((l) => [...l].length <= 80), 'long lines are cut to the width');
  const off = buildFrame({ ...config, activity: { sessionIds: false, models: false } }, state, { width: 120, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true }).map(plain);
  assert.ok(off.some((l) => /\d {2}Codex POST \/codex\/responses → acct-2/.test(l)), 'both can be switched off');
});

test('full redaction drops session ids; partial keeps them', () => {
  const state: PersistedState = { version: 1, accounts: {}, events: [{ at: 1, message: 'm', request: req(U1, 'x') }], active: [{ id: '1', provider: 'codex', providerLabel: 'Codex', method: 'POST', path: '/', account: null, startedAt: 0, sessionId: U1 }] };
  assert.equal(JSON.stringify(redactSnapshot(config, state, 'full').state).includes(U1), false);
  assert.equal(redactSnapshot(config, state, 'partial').state.events![0]!.request!.sessionId, U1);
});
