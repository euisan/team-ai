import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { createProxy } from '../src/proxy.js';
import { codexProvider, codexUsageQuota } from '../src/providers.js';
import { handleResetCreditControl, isLoopback } from '../src/reset-credit-control.js';
import { classifyConsume, eligibility, parseResetCreditList, resetCreditSettings, type ResetCreditSettings } from '../src/reset-credits.js';
import type { PersistedState, Provider, RuntimeAccount, StoredAccount } from '../src/types.js';

const WEEK = 7 * 24 * 3_600_000;
const ON: ResetCreditSettings = { ...resetCreditSettings({ codexResetCredits: true }), cooldownMs: 30 * 60_000 };

test('the usage read yields a ticket count; headers never touch it', () => {
  const rate = { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } };
  assert.equal(codexUsageQuota({ rate_limit: rate, rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 } })?.resetCredits, 3);
  for (const bad of [undefined, { available_count: 1.5 }, { available_count: -1 }, { available_count: '2' }, { applicable_available_count: 4 }]) {
    assert.equal(codexUsageQuota({ rate_limit: rate, rate_limit_reset_credits: bad })?.resetCredits, null, JSON.stringify(bad));
  }
  const headers = new Headers({ 'x-codex-primary-used-percent': '50' });
  assert.equal('resetCredits' in (codexProvider.readQuota(headers) ?? {}), false);
  const pool = makePool(['a'], {});
  pool.accounts[0]!.resetCredits = 2; pool.accounts[0]!.resetCreditsAt = 5;
  pool.updateQuota(pool.accounts[0]!, headers);
  assert.equal(pool.accounts[0]!.resetCredits, 2, 'a header reading keeps the known count');
});

test('a consume answer is judged by its code, not by its HTTP status', () => {
  const cases: Array<[number, string, string]> = [
    [200, '{"code":"reset","windows_reset":2}', 'reset'],
    [200, '{"code":"reset"}', 'reset'],
    [200, '{"code":"reset","windows_reset":0}', 'spent-no-reset'],
    [200, '{"code":"nothing_to_reset"}', 'no-spend'],
    [200, '{"code":"no_credit"}', 'no-spend'],
    [200, '{"code":"already_redeemed"}', 'no-spend'],
    [200, '{"code":"something_new"}', 'indeterminate'],
    [200, 'not json', 'indeterminate'],
    [503, '{"code":"reset"}', 'indeterminate'],
    [400, '{"detail":"bad"}', 'no-spend'],
    [401, '', 'no-spend'],
  ];
  for (const [status, body, kind] of cases) assert.equal(classifyConsume(status, body).kind, kind, `${status} ${body}`);
  assert.equal(classifyConsume(200, '{"code":"no_credit"}').kind === 'reset', false, 'a 200 refusal is not a success');
  assert.equal(classifyConsume(400, JSON.stringify({ error: { message: 'x'.repeat(500) } })).error!.length, 200);
});

test('the ticket list keeps available ones, soonest expiry first, open-ended last', () => {
  const list = parseResetCreditList({ credits: [
    { id: 'late', status: 'available', expires_at: '2026-12-01T00:00:00Z', granted_at: 1_790_000_000, title: 'Late' },
    { id: 'never', status: 'available' },
    { id: 'used', status: 'redeemed', expires_at: '2026-10-20T00:00:00Z' },
    { id: '', status: 'available' },
    { id: 'soon', status: 'available', expires_at: 1_792_000_000_000 },
  ] });
  assert.deepEqual(list.map((c) => c.id), ['soon', 'late', 'never']);
  assert.equal(list[1]!.grantedAt, 1_790_000_000_000, 'epoch seconds become ms');
  assert.deepEqual(parseResetCreditList({ nope: 1 }), []);
});

function spent(account: RuntimeAccount, credits: number | null): void {
  account.usage = 1; account.resetCredits = credits; account.resetCreditsAt = credits === null ? null : Date.now();
  account.windows = { primary: { usage: 0.3, resetsAt: Date.now() + 3_600_000, minutes: 300 }, secondary: { usage: 1, resetsAt: Date.now() + 3 * 24 * 3_600_000, minutes: 10_080 } };
}

test('eligibility names the first guard that stops automatic use', () => {
  const pool = makePool(['a'], {}); const a = pool.accounts[0]!; const now = Date.now();
  spent(a, null); assert.equal(eligibility(a, ON, 'codex', now), 'credits-unknown');
  assert.equal(eligibility(a, ON, 'claude', now), 'not-codex-oauth');
  spent(a, 0); assert.equal(eligibility(a, ON, 'codex', now), 'no-credits');
  spent(a, 2); assert.equal(eligibility(a, { ...ON, reserve: 2 }, 'codex', now), 'reserved');
  a.resetCreditsAt = now - 120_000; a.resetCreditLastOutcome = 'pending'; a.resetCreditLastAt = now - 60_000;
  assert.equal(eligibility(a, { ...ON, cooldownMs: 0 }, 'codex', now), 'pending', 'pending holds whatever the cooldown');
  assert.equal(eligibility(a, { ...ON, cooldownMs: 0 }, 'codex', now + 16 * 60_000), 'ok', 'pending lapses after 15 minutes');
  a.resetCreditsAt = now; assert.equal(eligibility(a, { ...ON, cooldownMs: 0 }, 'codex', now), 'ok', 'a fresh count releases pending');
  a.resetCreditLastOutcome = 'nothing_to_reset'; a.resetCreditLastAt = now - 60_000;
  assert.equal(eligibility(a, ON, 'codex', now), 'cooldown');
  a.resetCreditLastAt = null; a.windows.secondary!.usage = 0.5;
  assert.equal(eligibility(a, ON, 'codex', now), 'not-exhausted');
  a.windows.primary!.usage = 1;
  assert.equal(eligibility(a, ON, 'codex', now), 'not-exhausted', 'a full 5-hour window alone does not qualify by default');
  assert.equal(eligibility(a, { ...ON, sessionWindow: true }, 'codex', now), 'ok', 'it does with the session-window option');
  a.windows.secondary!.usage = 1; a.resetCreditPromise = Promise.resolve({ kind: 'reset', code: 'reset', windowsReset: 1, error: null, skipped: false, reason: 'x' });
  a.resetCredits = 0; assert.equal(eligibility(a, ON, 'codex', now), 'in-flight', 'joining a running redemption skips the count checks');
  a.resetCreditPromise = null; a.enabled = false; assert.equal(eligibility(a, ON, 'codex', now), 'disabled');
});

// A fake ChatGPT backend: the responses endpoint answers per account, the
// consume endpoint records every call and answers as told.
interface Backend { consumes: Array<{ account: string | null; auth: string | null; body: Record<string, unknown> }>; responses: string[]; usage: number; consume: (n: number) => { status?: number; body?: string; delayMs?: number; hang?: boolean }; serve: (account: string, n: number) => 'ok' | 'spent'; }
async function backend(setup: Partial<Backend> = {}) {
  const b: Backend = { consumes: [], responses: [], usage: 100, consume: () => ({ body: '{"code":"reset","windows_reset":2}' }), serve: () => 'ok', ...setup };
  const reset = new Set<string>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); const text = Buffer.concat(chunks).toString();
    const account = req.headers['chatgpt-account-id'] as string | undefined ?? null;
    if (req.url === '/wham/rate-limit-reset-credits/consume') {
      const n = b.consumes.push({ account, auth: req.headers.authorization ?? null, body: JSON.parse(text) as Record<string, unknown> });
      const answer = b.consume(n);
      if (answer.hang) return;
      if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
      if (account && (answer.body ?? '').includes('"reset"') && !(answer.body ?? '').includes('"windows_reset":0')) reset.add(account);
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' }); res.end(answer.body ?? '{}'); return;
    }
    if (req.url === '/wham/usage') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rate_limit: { secondary_window: { used_percent: b.usage, limit_window_seconds: 604_800 } }, rate_limit_reset_credits: { available_count: 9 } })); return; }
    if (req.url === '/wham/rate-limit-reset-credits') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ credits: [{ id: 'c1', status: 'available', title: 'Gift', expires_at: '2026-11-01T00:00:00Z' }] })); return; }
    const n = b.responses.push(account ?? '?');
    if (b.serve(account ?? '?', n) === 'ok') { res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-secondary-used-percent': '1', 'x-codex-secondary-window-minutes': '10080' }); res.end('data: {}\n\n'); return; }
    res.writeHead(429, { 'content-type': 'application/json', 'x-codex-secondary-used-percent': '100', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-after-seconds': '200000' }); res.end('{"error":{"code":"usage_limit_reached"}}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert(address && typeof address !== 'string');
  return { b, reset, base: `http://127.0.0.1:${address.port}`, close: () => { server.close(); server.closeAllConnections(); } };
}

function makePool(ids: string[], state: Partial<PersistedState>, base = 'http://127.0.0.1:1', settings: ResetCreditSettings = ON) {
  const provider: Provider = { ...codexProvider, upstreamBase: base };
  const stored = ids.map((id, i): StoredAccount => ({ id, provider: 'codex', label: `${id}@example.com`, enabled: true, priority: i + 1, credentialId: id, createdAt: '' }));
  const credentials = Object.fromEntries(ids.map((id) => [id, { accessToken: `secret-${id}`, refreshToken: null, expiresAt: Date.now() + 3_600_000, accountId: id }]));
  const pool = new AccountPool(provider, stored, credentials, { version: 1, accounts: {}, ...state });
  pool.resetCredits = settings;
  return pool;
}

async function relay(pool: AccountPool) {
  const events: string[] = []; pool.log = (m) => events.push(m);
  const saves: Array<string | null | undefined> = []; pool.saveNow = async () => { saves.push(pool.accounts[0]!.resetCreditLastOutcome); };
  const proxy = createProxy(pool, 'local-secret', (e) => { if (e) events.push(e); });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r)); const address = proxy.address(); assert(address && typeof address !== 'string');
  const call = () => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' }, body: '{"model":"gpt-6-astra"}' });
  return { events, saves, call, close: () => { proxy.close(); proxy.closeAllConnections(); } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('fleet: at the quota dead end one ticket is spent and the same request is served', async () => {
  const up = await backend({ serve: (account) => up.reset.has(account) ? 'ok' : 'spent' });
  const pool = makePool(['a', 'b'], {}, up.base); spent(pool.accounts[0]!, null); spent(pool.accounts[1]!, 3);
  const r = await relay(pool);
  try {
    const res = await r.call(); assert.equal(res.status, 200, r.events.join(' | ')); await res.text();
    assert.equal(up.b.consumes.length, 1);
    const [consume] = up.b.consumes;
    assert.equal(consume!.account, 'b'); assert.equal(consume!.auth, 'Bearer secret-b');
    assert.match(String(consume!.body.redeem_request_id), UUID); assert.equal('credit_id' in consume!.body, false);
    const b = pool.accounts[1]!;
    assert.equal(b.resetCredits, 2); assert.equal(b.usage, 0); assert.equal(b.windows.secondary!.usage, 0); assert.equal(b.resetCreditsConsumed, 1);
    assert.equal(b.resetCreditLastOutcome, 'reset');
    assert.ok(r.events.some((e) => /reset credit redeemed on "b@example\.com" \(fleet-exhausted\): windows_reset=2, credits left=2/.test(e)), r.events.join(' | '));
    // The 1.5s usage re-read still says 100%: within the grace period it may
    // not raise usage back up.
    await new Promise((x) => setTimeout(x, 1_800));
    assert.equal(b.windows.secondary!.usage, 0, 'a late reading does not undo the reset');
    assert.equal(b.resetCredits, 9, 'the re-read refreshed the count');
  } finally { r.close(); up.close(); }
});

test('the ledger is on disk as pending before the call and settled after it', async () => {
  const up = await backend({ serve: (account) => up.reset.has(account) ? 'ok' : 'spent' });
  const pool = makePool(['a'], {}, up.base); spent(pool.accounts[0]!, 1);
  const r = await relay(pool);
  try { await (await r.call()).text(); assert.deepEqual(r.saves.slice(0, 2), ['pending', 'reset']); } finally { r.close(); up.close(); }
});

test('a ticket is spent at most once per request: a second 429 after the reset ends it', async () => {
  const up = await backend({ serve: () => 'spent' });
  const pool = makePool(['a'], {}, up.base); spent(pool.accounts[0]!, 3);
  const r = await relay(pool);
  try {
    const res = await r.call(); assert.equal(res.status, 429); await res.text();
    assert.equal(up.b.consumes.length, 1); assert.equal(up.b.responses.length, 1);
  } finally { r.close(); up.close(); }
});

for (const [name, answer] of [
  ['a timeout', { hang: true }],
  ['a 500', { status: 500, body: '{"error":"x"}' }],
  ['windows_reset=0', { body: '{"code":"reset","windows_reset":0}' }],
  ['an unknown code', { body: '{"code":"mystery"}' }],
] as const) {
  test(`after ${name} no other account is tried`, async () => {
    const up = await backend({ consume: () => answer, serve: () => 'spent' });
    const pool = makePool(['a', 'b'], {}, up.base, { ...ON, timeoutMs: 300 }); spent(pool.accounts[0]!, 2); spent(pool.accounts[1]!, 2);
    const r = await relay(pool);
    try {
      const res = await r.call(); assert.equal(res.status, 429); await res.text();
      assert.equal(up.b.consumes.length, 1);
      if (name !== 'windows_reset=0') assert.ok(r.events.some((e) => /indeterminate/.test(e)), r.events.join(' | '));
      else { assert.equal(pool.accounts[0]!.resetCreditLastOutcome, 'reset_no_windows'); assert.equal(pool.accounts[0]!.usage, 1, 'nothing was reset'); }
    } finally { r.close(); up.close(); }
  });
}

test('a clean refusal moves on, and the cooldown then keeps the account out', async () => {
  const up = await backend({ consume: () => ({ body: '{"code":"nothing_to_reset"}' }), serve: () => 'spent' });
  const pool = makePool(['a'], {}, up.base); spent(pool.accounts[0]!, 2);
  const r = await relay(pool);
  try {
    assert.equal((await r.call()).status, 429); assert.equal(up.b.consumes.length, 1);
    assert.equal((await r.call()).status, 429); assert.equal(up.b.consumes.length, 1, 'cooldown: no second attempt');
    assert.ok(r.events.some((e) => /NOT applied on "a@example\.com" \(fleet-exhausted\): nothing_to_reset/.test(e)));
  } finally { r.close(); up.close(); }
});

test('no ticket while another account can serve, and none when the feature is off', async () => {
  const up = await backend({ serve: (account) => account === 'b' ? 'ok' : 'spent' });
  const pool = makePool(['a', 'b'], {}, up.base); spent(pool.accounts[0]!, 3);
  const r = await relay(pool);
  try { assert.equal((await r.call()).status, 200); assert.equal(up.b.consumes.length, 0); } finally { r.close(); }
  const off = makePool(['a'], {}, up.base, resetCreditSettings({})); spent(off.accounts[0]!, 3);
  const r2 = await relay(off);
  try { assert.equal((await r2.call()).status, 429); assert.equal(up.b.consumes.length, 0); } finally { r2.close(); up.close(); }
});

test('five requests at the dead end share one redemption', async () => {
  const up = await backend({ consume: () => ({ body: '{"code":"reset","windows_reset":1}', delayMs: 150 }), serve: (account) => up.reset.has(account) ? 'ok' : 'spent' });
  const pool = makePool(['a'], {}, up.base); spent(pool.accounts[0]!, 3);
  const r = await relay(pool);
  try {
    const statuses = await Promise.all(Array.from({ length: 5 }, async () => { const res = await r.call(); await res.text(); return res.status; }));
    assert.equal(up.b.consumes.length, 1);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
  } finally { r.close(); up.close(); }
});

test('a 429 sent before the reset and answered after it does not bench the account', async () => {
  let release: () => void = () => {}; const gate = new Promise<void>((x) => { release = x; });
  const up = await backend({ serve: (_account, n) => n === 1 ? 'spent' : 'ok' });
  const pool = makePool(['a'], {}, up.base); const a = pool.accounts[0]!;
  a.usage = 0.5; a.resetCredits = 2; a.resetCreditsAt = Date.now();
  // Hold the first upstream answer until the operator has spent a ticket.
  const r = await relay(pool);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => { const response = await realFetch(input, init); if (String(input).endsWith('/codex/responses') && up.b.responses.length === 1) await gate; return response; }) as typeof fetch;
  try {
    const pending = r.call();
    while (up.b.responses.length === 0) await new Promise((x) => setTimeout(x, 10));
    await pool.redeemResetCredit(a, 'operator', { recheck: false });
    release();
    const res = await pending; assert.equal(res.status, 200, r.events.join(' | ')); await res.text();
    assert.equal(a.cooldownUntil, null, 'not benched by the stale 429');
    assert.equal(up.b.consumes.length, 1, 'no second ticket');
    assert.ok(r.events.some((e) => /predates its reset credit/.test(e)));
  } finally { globalThis.fetch = realFetch; release(); r.close(); up.close(); }
});

test('account policy: the account that just ran out gets a ticket and the request goes back to it', async () => {
  const up = await backend({ serve: (account) => up.reset.has(account) ? 'ok' : 'spent' });
  const pool = makePool(['a', 'b'], {}, up.base, { ...ON, policy: 'account' });
  const a = pool.accounts[0]!; a.usage = 0.5; a.resetCredits = 1; a.resetCreditsAt = Date.now();
  spent(pool.accounts[1]!, null);
  const r = await relay(pool);
  try {
    const res = await r.call(); assert.equal(res.status, 200, r.events.join(' | ')); await res.text();
    assert.equal(up.b.consumes.length, 1); assert.deepEqual(up.b.responses, ['a', 'a']);
    assert.ok(r.events.some((e) => /\(429-exhausted\)/.test(e)));
  } finally { r.close(); up.close(); }
});

test('a pending redemption restored after a restart is never repeated', async () => {
  const up = await backend({ serve: () => 'spent' });
  const now = Date.now();
  const state: Partial<PersistedState> = { accounts: { a: { usage: 1, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { secondary: { usage: 1, resetsAt: now + WEEK, minutes: 10_080 } }, resetCredits: 3, resetCreditsAt: now - 120_000, resetCreditLastAt: now - 60_000, resetCreditLastOutcome: 'pending' } } };
  const pool = makePool(['a'], state, up.base, { ...ON, cooldownMs: 0 });
  assert.equal(pool.accounts[0]!.resetCreditLastOutcome, 'pending', 'the ledger is restored');
  const r = await relay(pool);
  try {
    assert.equal((await r.call()).status, 429); assert.equal(up.b.consumes.length, 0);
    assert.ok(r.events.some((e) => /no eligible account at the quota dead end \(a@example\.com:pending\)/.test(e)), r.events.join(' | '));
  } finally { r.close(); up.close(); }
});

test('control routes: local, authorized, no body, known account', async () => {
  const up = await backend();
  const pool = makePool(['a'], {}, up.base); spent(pool.accounts[0]!, 2); pool.saveNow = async () => {};
  const server = createServer((req, res) => { void handleResetCreditControl(req, res, pool, 'tok').then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert(address && typeof address !== 'string');
  const url = (path: string) => `http://127.0.0.1:${address.port}${path}`; const auth = { authorization: 'Bearer tok' };
  try {
    assert.equal((await fetch(url('/codex/reset-credit?account=a'), { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(url('/codex/reset-credit?account=a'), { method: 'POST', headers: { ...auth, 'x-forwarded-for': '127.0.0.1' }, body: 'x' })).status, 400);
    assert.equal((await fetch(url('/codex/reset-credit?account=a'), { headers: auth })).status, 405);
    assert.equal((await fetch(url('/codex/reset-credit?account=nobody'), { method: 'POST', headers: auth })).status, 404);
    const list = await fetch(url('/codex/reset-credits?account=a@example.com'), { headers: auth });
    assert.equal(list.status, 200); assert.deepEqual(((await list.json()) as { credits: Array<{ id: string }> }).credits.map((c) => c.id), ['c1']);
    const res = await fetch(url(`/codex/reset-credit?account=a&credit_id=${'c'.repeat(600)}`), { method: 'POST', headers: auth });
    assert.equal(res.status, 200); const body = await res.json() as { reset: boolean; outcome: string; resetCredits: number };
    assert.equal(body.reset, true); assert.equal(body.outcome, 'reset');
    assert.equal(String(up.b.consumes[0]!.body.credit_id).length, 512, 'credit id capped');
    assert.equal(isLoopback('10.0.0.2'), false); assert.equal(isLoopback('::ffff:127.0.0.1'), true); assert.equal(isLoopback('::1'), true); assert.equal(isLoopback(undefined), false);
  } finally { server.close(); up.close(); }
});

test('response figures are fenced around a reset: stale before it, held during the grace, 429 always applied', () => {
  const pool = makePool(['a'], {}); const a = pool.accounts[0]!; const resetAt = Date.now() - 1_000;
  a.resetCreditResetAt = resetAt; a.usage = 0; a.windows = { secondary: { usage: 0, resetsAt: null, minutes: 10_080 } };
  const full = new Headers({ 'x-codex-secondary-used-percent': '100', 'x-codex-secondary-window-minutes': '10080' });
  assert.equal(pool.observeResponse(a, full, resetAt - 5_000, 429), 'stale'); assert.equal(a.usage, 0);
  assert.equal(pool.observeResponse(a, full, resetAt + 10, 200), 'held'); assert.equal(a.usage, 0);
  assert.equal(pool.observeResponse(a, full, resetAt + 10, 429), 'applied'); assert.equal(a.usage, 1);
  a.resetCreditResetAt = null; a.usage = 0;
  assert.equal(pool.observeResponse(a, full, Date.now(), 200), 'applied', 'no reset on record: plain updateQuota'); assert.equal(a.usage, 1);
});

test('the dashboard shows tickets on hand and the picker lists them', async () => {
  const { buildFrame } = await import('../src/frame.js');
  const config = { version: 1 as const, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [{ id: 'x', provider: 'codex' as const, label: 'x@example.com', enabled: true, priority: null, credentialId: 'x', createdAt: '' }] };
  const state: PersistedState = { version: 1, accounts: { x: { usage: 0.2, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { primary: { usage: 0.2, resetsAt: null, minutes: 300 } }, resetCredits: 3 } } };
  const strip = (l: string) => l.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const lines = buildFrame(config, state, { width: 100, selectedId: 'x', mode: 'normal', message: '', sortByHeadroom: true }).map(strip);
  assert.ok(lines.some((l) => l.includes('x@example.com') && /RC3/.test(l)));
  const picker = buildFrame(config, state, { width: 100, selectedId: 'x', mode: 'credits', message: '', sortByHeadroom: true, credits: { account: 'x@example.com', phase: 'confirm', items: [{ title: null, grantedAt: null, expiresAt: Date.UTC(2026, 10, 1) }], index: 0 } }).map(strip);
  assert.ok(picker.some((l) => /^> \(untitled\) +granted — {2}expires \d\d\/\d\d \d\d:\d\d/.test(l)), picker.join('\n'));
  assert.match(picker.at(-1)!, /Reset x@example\.com's usage with this credit\? \(y\/n\)/);
});
