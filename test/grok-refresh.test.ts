import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectGrok, type ExternalUsage } from '../src/external-usage.js';
import { losslessNumbers, rfc3339Like } from '../src/grok-refresh.js';

// Fake values only; compared with assert.ok so a failure never prints them.
const OLD_KEY = 'xai-OLD-access-111'; const OLD_REFRESH = 'rt-OLD-refresh-222';
const NEW_KEY = 'xai-NEW-access-333'; const NEW_REFRESH = 'rt-NEW-refresh-444'; const OTHER_KEY = 'xai-OTHER-access-555';
const SECRETS = [OLD_KEY, OLD_REFRESH, NEW_KEY, NEW_REFRESH, OTHER_KEY];
const ENTRY = 'https://auth.x.ai::0b1c-uuid';
const hasFlock = spawnSync('flock', ['-V']).status === 0;
const hasPerl = spawnSync('perl', ['-e', '1']).status === 0;

type Answer = { status: number; body: string; delayMs?: number };
async function fakeAuthServer(token: (body: string) => Answer, discovery?: (base: string) => Answer) {
  const posts: string[] = []; const billing: Array<IncomingMessage['headers']> = []; const postTimes: number[] = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      let answer: Answer;
      if (req.url === '/.well-known/openid-configuration') answer = discovery?.(base) ?? { status: 200, body: JSON.stringify({ issuer: base, token_endpoint: `${base}/oauth2/token`, grant_types_supported: ['refresh_token'] }) };
      else if (req.url === '/oauth2/token' && req.method === 'POST') { posts.push(body); postTimes.push(Date.now()); answer = token(body); }
      else if (req.url?.startsWith('/v1/billing')) { billing.push(req.headers); answer = { status: 200, body: JSON.stringify({ config: { creditUsagePercent: 12, subscriptionTier: 'SuperGrok' } }) }; }
      else answer = { status: 404, body: '{}' };
      setTimeout(() => { res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(answer.body); }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return { base, posts, postTimes, billing, close: () => server.close() };
}

function grokHome(issuer: string, expiresAt: string, extra: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'teamai-grok-'));
  const auth = { [ENTRY]: { key: OLD_KEY, refresh_token: OLD_REFRESH, expires_at: expiresAt, create_time: '2026-10-17T00:00:00.000000000Z', oidc_issuer: issuer, oidc_client_id: 'client-abc', auth_mode: 'oidc', user_id: 'u-1', email: 'jane.doe@gmail.com', team_id: 't-9', ...extra }, other: { keep: [1, 2.5, 'x'] } };
  const path = join(home, 'auth.json'); writeFileSync(path, JSON.stringify(auth, null, 2) + '\n'); chmodSync(path, 0o600);
  return { home, path, raw: auth as Record<string, Record<string, unknown>> };
}
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().replace('Z', '123456Z');
const tokenOk = (extra: Record<string, unknown> = {}) => () => ({ status: 200, body: JSON.stringify({ access_token: NEW_KEY, refresh_token: NEW_REFRESH, expires_in: 21_600, token_type: 'Bearer', ...extra }) });
const leftovers = (home: string) => readdirSync(home).filter((f) => f !== 'auth.json' && f !== 'auth.json.lock');
const noSecrets = (value: unknown) => { const textValue = JSON.stringify(value); assert.ok(SECRETS.every((s) => !textValue.includes(s)), 'a secret leaked into the result'); };
const deps = (home: string, base: string, extra: Record<string, unknown> = {}) => ({ env: { GROK_HOME: home, GROK_CLI_CHAT_PROXY_BASE_URL: base }, grokRefresh: { refreshState: new Map(), lockWaitMs: 3_000, ...extra } });

// Holds the lock with the real flock(1) for `holdMs`, then runs `then` (a shell
// line) before letting go — the way the grok CLI holds it while refreshing.
async function holdWithFlock(lockPath: string, holdMs: number, then = 'true') {
  const child = spawn('flock', ['-x', lockPath, 'sh', '-c', `echo held; sleep ${holdMs / 1000}; ${then}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((r) => child.stdout.once('data', () => r()));
  // Wrapped, or awaiting this would wait for the holder to finish.
  return { done: new Promise<void>((r) => child.once('close', () => r())) };
}
const tryLock = (lockPath: string) => spawnSync('flock', ['-n', '-x', lockPath, 'true']).status;

test('an expiring Grok sign-in is refreshed: new key used, refresh token rotated, every other field kept, 0600, nothing leaks', async () => {
  const http = await fakeAuthServer(tokenOk());
  const { home, path, raw } = grokHome(http.base, iso(60_000));
  try {
    const before = Date.now(); const reading = await collectGrok(deps(home, http.base));
    assert.equal(reading?.status, 'ok', reading?.note ?? ''); assert.equal(reading?.identity, 'SuperGrok ja•••••e@gm•••.com');
    assert.equal(http.posts.length, 1);
    const form = new URLSearchParams(http.posts[0]);
    assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('client_id'), 'client-abc'); assert.ok(form.get('refresh_token') === OLD_REFRESH, 'the stored refresh token is sent');
    assert.ok(http.billing[0]!.authorization === `Bearer ${NEW_KEY}`, 'billing read with the new key');
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.ok(saved[ENTRY]!.key === NEW_KEY && saved[ENTRY]!.refresh_token === NEW_REFRESH, 'new tokens saved');
    const expires = saved[ENTRY]!.expires_at as string;
    assert.match(expires, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z$/, 'nanosecond RFC3339, as before');
    assert.ok(Math.abs(Date.parse(expires) - (before + 21_600_000)) < 5_000);
    const others = (entry: Record<string, unknown>) => Object.fromEntries(Object.entries(entry).filter(([k]) => !['key', 'refresh_token', 'expires_at'].includes(k)));
    assert.deepEqual(others(saved[ENTRY]!), others(raw[ENTRY]!), 'every other field kept'); assert.deepEqual(saved.other, raw.other);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(leftovers(home), [], 'no temporary file left');
    assert.match(readFileSync(`${path}.lock`, 'utf8'), /^\d+:\d+$/, 'lock file holds pid:epoch like the CLI');
    noSecrets(reading);
    // Valid now: the next read sends no refresh.
    assert.equal((await collectGrok(deps(home, http.base)))?.status, 'ok'); assert.equal(http.posts.length, 1);
  } finally { http.close(); }
});

test('a token answer without a new refresh token keeps the old one', async () => {
  const http = await fakeAuthServer(() => ({ status: 200, body: JSON.stringify({ access_token: NEW_KEY, expires_in: 3600 }) }));
  const { home, path, raw } = grokHome(http.base, '2026-01-01T00:00:00Z'); writeFileSync(path, JSON.stringify(raw));
  try {
    assert.equal((await collectGrok(deps(home, http.base)))?.status, 'ok');
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.ok(saved[ENTRY]!.key === NEW_KEY && saved[ENTRY]!.refresh_token === OLD_REFRESH, 'refresh token kept');
    assert.match(saved[ENTRY]!.expires_at as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'no fraction before, none after');
    assert.equal(readFileSync(path, 'utf8').includes('\n'), false, 'compact file stays compact');
  } finally { http.close(); }
});

const failures: Array<[string, Parameters<typeof fakeAuthServer>[0], Parameters<typeof fakeAuthServer>[1], string, number]> = [
  ['invalid_grant', () => ({ status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: `token ${OLD_REFRESH} revoked` }) }), undefined, 'sign-in expired — refresh token rejected — run grok login', 1],
  ['a server error', () => ({ status: 503, body: `upstream ${OLD_REFRESH}` }), undefined, 'sign-in expired — refresh failed: token HTTP 503', 1],
  ['an unexpected answer', () => ({ status: 200, body: JSON.stringify({ token: NEW_KEY }) }), undefined, 'sign-in expired — refresh failed: unexpected token response', 1],
  ['a token endpoint off the issuer', tokenOk(), () => ({ status: 200, body: JSON.stringify({ token_endpoint: 'https://elsewhere.example/oauth2/token' }) }), 'sign-in expired — refresh failed: unexpected token endpoint', 0],
  ['a failed discovery', tokenOk(), () => ({ status: 500, body: '{}' }), 'sign-in expired — refresh failed: discovery HTTP 500', 0],
];
for (const [name, token, discovery, note, posts] of failures) {
  test(`a refresh failing on ${name} leaves auth.json byte for byte, says why, and backs off ten minutes`, async () => {
    const http = await fakeAuthServer(token, discovery);
    const { home, path } = grokHome(http.base, iso(-60_000));
    const original = readFileSync(path);
    let now = Date.now(); const d = { ...deps(home, http.base), now: () => now };
    try {
      const reading = await collectGrok(d);
      assert.equal(reading?.status, 'expired'); assert.equal(reading?.note, note); assert.equal(http.posts.length, posts);
      assert.ok(readFileSync(path).equals(original), 'auth.json unchanged'); assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(leftovers(home), []); assert.equal(http.billing.length, 0, 'nothing sent with the expired key');
      noSecrets(reading);
      now += 60_000; assert.equal((await collectGrok(d))?.note, note); assert.equal(http.posts.length, posts, 'no retry inside ten minutes');
      now += 10 * 60_000; await collectGrok(d); assert.equal(http.posts.length, posts * 2, 'retried after the back-off');
    } finally { http.close(); }
  });
}

test('a failure while saving leaves the original file and no temporary file', async () => {
  const http = await fakeAuthServer(tokenOk());
  const { home, path } = grokHome(http.base, iso(-1));
  const original = readFileSync(path);
  try {
    const reading = await collectGrok({ ...deps(home, http.base, { rename: async () => { throw new Error('disk gone'); } }) });
    assert.equal(reading?.note, 'sign-in expired — refresh failed: could not save auth.json');
    assert.ok(readFileSync(path).equals(original)); assert.deepEqual(leftovers(home), []); noSecrets(reading);
  } finally { http.close(); }
});

test('a file whose numbers would not survive rewriting is left to the CLI, before any request', async () => {
  const http = await fakeAuthServer(tokenOk());
  const { home, path } = grokHome(http.base, iso(-1), { org_id: 0 });
  writeFileSync(path, readFileSync(path, 'utf8').replace('"org_id": 0', '"org_id": 12345678901234567890'));
  const original = readFileSync(path);
  try {
    assert.equal((await collectGrok(deps(home, http.base)))?.note, 'sign-in expired — refresh failed: auth.json cannot be rewritten safely');
    assert.equal(http.posts.length, 0); assert.ok(readFileSync(path).equals(original));
  } finally { http.close(); }
  assert.equal(losslessNumbers('{"a": "99999999999999999999", "b": [1, -2.5e3, 9007199254740991]}'), true);
  assert.equal(losslessNumbers('{"a": "x\\" 1", "b": 9007199254740993}'), false);
});

test('expires_at keeps the shape the CLI wrote', () => {
  const at = Date.parse('2026-10-17T06:00:00.123Z');
  assert.equal(rfc3339Like(at, '2026-10-17T00:00:00.987654321Z'), '2026-10-17T06:00:00.123000000Z');
  assert.equal(rfc3339Like(at, '2026-10-17T00:00:00.987654+00:00'), '2026-10-17T06:00:00.123000+00:00');
  assert.equal(rfc3339Like(at, '2026-10-17T00:00:00Z'), '2026-10-17T06:00:00Z');
  assert.equal(rfc3339Like(at, undefined), '2026-10-17T06:00:00.123000000Z');
});

for (const helper of ['flock', 'perl'] as const) {
  const skip = !hasFlock ? 'flock(1) not installed' : helper === 'perl' && !hasPerl ? 'perl not installed' : false;

  test(`[${helper}] the refresh waits for a flock(1) holder and reuses what it saved`, { skip }, async () => {
    const http = await fakeAuthServer(tokenOk());
    const { home, path, raw } = grokHome(http.base, iso(-1));
    // What the "CLI" saves while it holds the lock: a fresh sign-in.
    const fresh = { ...raw, [ENTRY]: { ...raw[ENTRY], key: OTHER_KEY, expires_at: iso(6 * 3_600_000) } };
    const freshPath = join(home, 'fresh.json.src'); writeFileSync(freshPath, JSON.stringify(fresh));
    try {
      const held = await holdWithFlock(`${path}.lock`, 400, `cp '${freshPath}' '${path}'`); const started = Date.now();
      const reading = await collectGrok(deps(home, http.base, { lockCommand: helper }));
      assert.ok(Date.now() - started >= 300, 'waited for the holder'); await held.done;
      assert.equal(reading?.status, 'ok'); assert.equal(http.posts.length, 0, 'no refresh: the holder already refreshed');
      assert.ok(http.billing[0]!.authorization === `Bearer ${OTHER_KEY}`, 'the token saved by the other process is used');
      noSecrets(reading);
    } finally { http.close(); }
  });

  test(`[${helper}] a lock held past the wait limit gives up without touching anything`, { skip }, async () => {
    const http = await fakeAuthServer(tokenOk());
    const { home, path } = grokHome(http.base, iso(-1));
    const original = readFileSync(path);
    try {
      const held = await holdWithFlock(`${path}.lock`, 1_500); assert.equal(tryLock(`${path}.lock`), 1, 'held');
      const started = Date.now();
      const reading = await collectGrok(deps(home, http.base, { lockCommand: helper, lockWaitMs: 300 }));
      assert.ok(Date.now() - started < 1_400, 'gave up at the limit');
      assert.equal(reading?.note, 'sign-in expired — refresh failed: auth lock busy'); assert.equal(http.posts.length, 0);
      assert.ok(readFileSync(path).equals(original)); await held.done;
    } finally { http.close(); }
  });

  test(`[${helper}] while refreshing it holds the same lock flock(1) takes, and lets go after`, { skip }, async () => {
    let during: number | null = null; let lockPath = '';
    const http = await fakeAuthServer(() => { during = tryLock(lockPath); return { ...tokenOk()(), delayMs: 50 }; });
    const { home, path } = grokHome(http.base, iso(-1)); lockPath = `${path}.lock`;
    try {
      const reading: ExternalUsage | null = await collectGrok(deps(home, http.base, { lockCommand: helper }));
      assert.equal(reading?.status, 'ok');
      assert.equal(during, 1, 'flock -n fails while the refresh runs: same lock');
      assert.equal(tryLock(lockPath), 0, 'released afterwards');
    } finally { http.close(); }
  });
}
