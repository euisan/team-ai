import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CLAUDE_MANUAL_REDIRECT_URI, loginClaude, loginCodex, parseAuthCode, type ClaudeLoginOptions } from '../src/auth.js';

// Stands in for Anthropic: records every request and answers the token
// exchange and the profile lookup. Nothing leaves the process.
function fakeAnthropic() {
  const exchanges: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === 'https://platform.claude.com/v1/oauth/token') { exchanges.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }); }
    if (target === 'https://api.anthropic.com/api/oauth/profile') return Response.json({ account: { uuid: 'uuid-1', email: 'one@example.com' } });
    throw new Error(`unexpected request to ${target}`);
  }) as typeof fetch;
  return { exchanges, fetchImpl };
}

// A login with a fake browser, terminal and network. `authorize` resolves to
// the authorization URL once the login has printed it (and opened the browser).
function startLogin(options: ClaudeLoginOptions = {}) {
  const input = new PassThrough(); const output = new PassThrough(); let printed = '';
  const anthropic = fakeAnthropic(); const opened: string[] = [];
  const authorize = new Promise<URL>((resolve) => output.on('data', (chunk: Buffer) => { printed += chunk.toString(); const match = /https:\/\/claude\.ai\/oauth\/authorize\S+/.exec(printed); if (match) resolve(new URL(match[0])); }));
  const login = loginClaude({ interactive: true, input, output, fetch: anthropic.fetchImpl, openBrowser: (url) => opened.push(url), ...options });
  return { input, login, authorize, opened, exchanges: anthropic.exchanges, printed: () => printed };
}

const callback = (redirect: string, query: Record<string, string>): Promise<number> => new Promise((resolve, reject) => {
  const url = new URL(redirect); for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.hostname = '127.0.0.1';
  get(url, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
});
const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(check(), 'condition never held'); };

test('parseAuthCode takes a redirect URL, code#state or a bare code, and refuses a foreign state', () => {
  assert.equal(parseAuthCode('http://localhost:4000/callback?code=abc&state=s1', 's1'), 'abc');
  assert.equal(parseAuthCode('  abc#s1\n', 's1'), 'abc');
  assert.equal(parseAuthCode('abc', 's1'), 'abc');
  assert.equal(parseAuthCode('   ', 's1'), null);
  assert.throws(() => parseAuthCode('http://localhost:4000/callback?code=abc&state=other', 's1'), /state mismatch/);
  assert.throws(() => parseAuthCode('abc#other', 's1'), /state mismatch/);
  assert.throws(() => parseAuthCode('http://localhost:4000/callback?error=access_denied&state=s1', 's1'), /access_denied/);
});

test('the browser callback finishes the login and releases the paste prompt', async () => {
  const run = startLogin(); const url = await run.authorize; const redirect = url.searchParams.get('redirect_uri')!;
  assert.match(redirect, /^http:\/\/localhost:\d+\/callback$/); assert.deepEqual(run.opened, [url.toString()]);
  await until(() => run.input.listenerCount('data') > 0);
  assert.equal(await callback(redirect, { code: 'from-callback', state: url.searchParams.get('state')! }), 200);
  const result = await run.login;
  assert.equal(result.label, 'one@example.com'); assert.equal(result.credential.accessToken, 'access-1'); assert.equal(result.credential.accountId, 'uuid-1');
  assert.equal(run.exchanges.length, 1); assert.equal(run.exchanges[0]!.code, 'from-callback'); assert.equal(run.exchanges[0]!.redirect_uri, redirect);
  assert.equal(run.input.listenerCount('data'), 0);
});

for (const [shape, paste] of [
  ['the full redirect URL', (redirect: string, state: string) => `${redirect}?code=from-paste&state=${state}`],
  ['code#state', (_redirect: string, state: string) => `from-paste#${state}`],
  ['a bare code', () => 'from-paste'],
] as const) {
  test(`pasting ${shape} finishes the login and closes the callback server`, async () => {
    const run = startLogin(); const url = await run.authorize; const redirect = url.searchParams.get('redirect_uri')!;
    run.input.write(`${paste(redirect, url.searchParams.get('state')!)}\n`);
    await run.login;
    assert.equal(run.exchanges.length, 1); assert.equal(run.exchanges[0]!.code, 'from-paste');
    assert.equal(run.exchanges[0]!.redirect_uri, redirect, 'the exchange names the redirect the code was issued for');
    await assert.rejects(callback(redirect, { code: 'late', state: url.searchParams.get('state')! }), /ECONNREFUSED/);
  });
}

test('a paste with a foreign state is refused and asked for again', async () => {
  const run = startLogin(); const url = await run.authorize; const state = url.searchParams.get('state')!;
  run.input.write('stolen#not-our-state\n');
  await until(() => /state mismatch/.test(run.printed()));
  assert.equal(run.exchanges.length, 0);
  run.input.write(`good#${state}\n`);
  await run.login;
  assert.deepEqual(run.exchanges.map((body) => body.code), ['good']);
});

test('a callback with a foreign state gets 400 and the login keeps waiting', async () => {
  const run = startLogin(); const url = await run.authorize; const redirect = url.searchParams.get('redirect_uri')!; const state = url.searchParams.get('state')!;
  assert.equal(await callback(redirect, { code: 'stolen', state: 'not-our-state' }), 400);
  assert.equal(await callback(redirect, { error: 'access_denied' }), 400);
  assert.equal(run.exchanges.length, 0);
  assert.equal(await callback(redirect, { code: 'good', state }), 200);
  await run.login;
  assert.deepEqual(run.exchanges.map((body) => body.code), ['good']);
});

test('--manual sends the browser to the code page, starts no server and exchanges with that redirect', async () => {
  const run = startLogin({ manual: true }); const url = await run.authorize;
  assert.equal(url.searchParams.get('redirect_uri'), CLAUDE_MANUAL_REDIRECT_URI); assert.deepEqual(run.opened, []);
  run.input.write(`manual-code#${url.searchParams.get('state')!}\n`);
  await run.login;
  assert.equal(run.exchanges[0]!.code, 'manual-code'); assert.equal(run.exchanges[0]!.redirect_uri, CLAUDE_MANUAL_REDIRECT_URI);
});

test('--manual fails when input ends without a code', async () => {
  const run = startLogin({ manual: true }); await run.authorize;
  run.input.end();
  await assert.rejects(run.login, /No authorization code provided/);
  assert.equal(run.exchanges.length, 0);
});

test('a non-interactive login (the dashboard) leaves stdin alone and waits for the callback', async () => {
  const run = startLogin({ interactive: false }); const url = await run.authorize;
  run.input.write(`ignored#${url.searchParams.get('state')!}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(run.input.listenerCount('data'), 0); assert.equal(run.exchanges.length, 0);
  await callback(url.searchParams.get('redirect_uri')!, { code: 'from-callback', state: url.searchParams.get('state')! });
  await run.login;
  assert.deepEqual(run.exchanges.map((body) => body.code), ['from-callback']);
});

test('loginCodex passes --device-auth through to codex login', async (t) => {
  const bin = await mkdtemp(join(tmpdir(), 'teamai-fake-codex-')); const record = join(bin, 'args');
  const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const auth = JSON.stringify({ tokens: { access_token: jwt({ exp: 100, 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace' } }), id_token: jwt({ email: 'c@example.com' }), account_id: 'workspace' } });
  await writeFile(join(bin, 'codex'), `#!/bin/sh\necho "$@" >> '${record}'\nprintf '%s' '${auth}' > "$CODEX_HOME/auth.json"\n`); await chmod(join(bin, 'codex'), 0o755);
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`; t.after(() => { process.env.PATH = path; });
  assert.equal((await loginCodex({ deviceAuth: true })).label, 'c@example.com');
  await loginCodex();
  assert.equal(await readFile(record, 'utf8'), 'login --device-auth\nlogin\n');
});
