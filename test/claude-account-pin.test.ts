import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AccountPool } from '../src/account-pool.js';
import { prepareClaudeArgs } from '../src/claude-session-control.js';
import { claudeProvider } from '../src/providers.js';
import { createProxy } from '../src/proxy.js';
import { parseRoutes } from '../src/routes.js';
import { defaultConfig, issueClaudeSession, loadSessions, saveConfig, saveCredentials, saveState } from '../src/storage.js';
import type { OAuthCredential, PersistedState, Provider, StoredAccount, TeamAIConfig } from '../src/types.js';
import { startOnAnyPorts } from './server-ports.js';

const runExec = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface CapturedHit {
  auth: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function createRig(
  t: test.TestContext,
  options: {
    accounts?: StoredAccount[];
    groups?: Record<string, string[]>;
    routes?: TeamAIConfig['routes'];
    maxConcurrent?: number;
  } = {},
) {
  const hits: CapturedHit[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    await new Promise<void>((resolve) => req.once('end', resolve));
    hits.push({
      auth: String(req.headers.authorization || ''),
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_ok', content: [{ type: 'text', text: 'ok' }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address();
  assert(addr && typeof addr !== 'string');

  const previousUpstream = claudeProvider.upstreamBase;
  claudeProvider.upstreamBase = `http://127.0.0.1:${addr.port}`;

  const config = defaultConfig();
  config.maxConcurrentPerAccount = options.maxConcurrent ?? 16;
  if (options.groups !== undefined) config.groups = options.groups;
  if (options.routes !== undefined) config.routes = options.routes;
  config.accounts = options.accounts ?? [
    { id: 'a', provider: 'claude', label: 'a@example.test', enabled: true, priority: 1, credentialId: 'cred-a', createdAt: '' },
    { id: 'b', provider: 'claude', label: 'b@example.test', enabled: true, priority: 2, credentialId: 'cred-b', createdAt: '' },
  ];
  await saveConfig(config);

  const credentials: Record<string, OAuthCredential> = Object.fromEntries(
    config.accounts.map((account) => [
      account.credentialId,
      {
        accountId: `uuid-${account.id}`,
        accessToken: `fake-${account.id}`,
        refreshToken: null,
        expiresAt: Date.now() + 86_400_000,
      },
    ]),
  );
  await saveCredentials(credentials);

  let server: Awaited<ReturnType<typeof startOnAnyPorts>> | undefined;
  t.after(async () => {
    await server?.stop();
    claudeProvider.upstreamBase = previousUpstream;
    upstream.closeAllConnections();
    upstream.close();
  });

  const start = async () => {
    server = await startOnAnyPorts(config);
  };
  const stop = async () => {
    await server?.stop();
    server = undefined;
  };
  const send = async (
    sessionId: string,
    extraHeaders: Record<string, string> = {},
    body: unknown = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'synthetic' }] },
  ) => {
    const response = await fetch(`http://127.0.0.1:${config.proxy.claudePort}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.proxy.clientToken}`,
        'content-type': 'application/json',
        'x-claude-code-session-id': sessionId,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text, json: JSON.parse(text || '{}') as Record<string, unknown> };
  };

  return { config, credentials, hits, start, stop, send };
}

async function createPoolRig(
  t: test.TestContext,
  options: {
    accounts?: StoredAccount[];
    state?: PersistedState;
    maxConcurrent?: number;
  } = {},
) {
  const hits: CapturedHit[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    await new Promise<void>((resolve) => req.once('end', resolve));
    hits.push({
      auth: String(req.headers.authorization || ''),
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upAddr = upstream.address();
  assert(upAddr && typeof upAddr !== 'string');

  const provider: Provider = {
    ...claudeProvider,
    upstreamBase: `http://127.0.0.1:${upAddr.port}`,
    readQuota: () => null,
    refresh: async (c) => c,
  };
  const accounts = options.accounts ?? [
    { id: 'a', provider: 'claude', label: 'a@example.test', enabled: true, priority: 1, credentialId: 'cred-a', createdAt: '' },
    { id: 'b', provider: 'claude', label: 'b@example.test', enabled: true, priority: 2, credentialId: 'cred-b', createdAt: '' },
  ];
  const credentials = Object.fromEntries(
    accounts.map((a) => [a.credentialId, { accountId: `uuid-${a.id}`, accessToken: `fake-${a.id}`, refreshToken: null, expiresAt: Date.now() + 86_400_000 }]),
  );
  const pool = new AccountPool(provider, accounts, credentials, options.state ?? { version: 1, accounts: {} }, 0.98, options.maxConcurrent ?? 16);
  const proxy = createProxy(pool, 'test-token', () => {});
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddr = proxy.address();
  assert(proxyAddr && typeof proxyAddr !== 'string');

  t.after(() => {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    proxy.close();
    upstream.close();
  });

  const send = async (
    sessionId: string,
    extraHeaders: Record<string, string> = {},
    body: unknown = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'synthetic' }] },
  ) => {
    const response = await fetch(`http://127.0.0.1:${proxyAddr.port}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-claude-code-session-id': sessionId,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text, json: JSON.parse(text || '{}') as Record<string, unknown> };
  };

  return { pool, hits, send };
}

async function setupFakeClaude(extraEnv: Record<string, string | undefined> = {}) {
  const bin = join(process.env.TEAMAI_HOME!, 'bin');
  const spawnedMarker = join(process.env.TEAMAI_HOME!, 'claude-spawned');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'claude'),
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnedMarker)}, '1');
console.log(JSON.stringify({ args: process.argv.slice(2), headers: process.env.ANTHROPIC_CUSTOM_HEADERS || '' }));
`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const runCli = (args: string[], overrideEnv?: Record<string, string | undefined>) => {
    const merged: NodeJS.ProcessEnv = { ...env };
    if (overrideEnv) {
      for (const [k, v] of Object.entries(overrideEnv)) {
        if (v === undefined) delete merged[k];
        else merged[k] = v;
      }
    }
    return runExec(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], { env: merged });
  };
  return { spawnedMarker, runCli };
}

test('1. pinned account binds a new session to the named account via --account, --account=, and TEAMAI_ACCOUNT', async (t) => {
  const r = await createRig(t);
  await r.start();
  const { runCli } = await setupFakeClaude({ ANTHROPIC_CUSTOM_HEADERS: 'x-synthetic: preserved' });

  // Account 'b' is priority #2 while 'a' is priority #1: pinning 'b' must select 'b'
  const res1 = await runCli(['claude', '--account', 'b@example.test', '--print', 'hello']);
  const launched1 = JSON.parse(res1.stdout) as { args: string[]; headers: string };
  assert.equal(launched1.args[0], '--session-id');
  assert.deepEqual(launched1.args.slice(2), ['--print', 'hello']);
  assert.equal(launched1.headers, 'x-synthetic: preserved\nx-teamai-account: b');

  const sid1 = launched1.args[1]!;
  const reply1 = await r.send(sid1, { 'x-teamai-account': 'b' });
  assert.equal(reply1.status, 200);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0]!.auth, 'Bearer fake-b');
  assert.equal((await loadSessions())[sid1]!.accountId, 'b');

  // TEAMAI_ACCOUNT supplies default, and explicit --account=<id> overrides TEAMAI_ACCOUNT
  const resEnv = await runCli(['claude'], { TEAMAI_ACCOUNT: 'b@example.test', ANTHROPIC_CUSTOM_HEADERS: undefined });
  const launchedEnv = JSON.parse(resEnv.stdout) as { args: string[]; headers: string };
  assert.equal(launchedEnv.headers, 'x-teamai-account: b');
  assert.equal((await r.send(launchedEnv.args[1]!, { 'x-teamai-account': 'b' })).status, 200);
  assert.equal(r.hits[1]!.auth, 'Bearer fake-b');

  const resOverride = await runCli(['claude', '--account=a'], { TEAMAI_ACCOUNT: 'b@example.test', ANTHROPIC_CUSTOM_HEADERS: undefined });
  const launchedOverride = JSON.parse(resOverride.stdout) as { args: string[]; headers: string };
  assert.equal(launchedOverride.headers, 'x-teamai-account: a');
  assert.equal((await r.send(launchedOverride.args[1]!, { 'x-teamai-account': 'a' })).status, 200);
  assert.equal(r.hits[2]!.auth, 'Bearer fake-a');

  // `tac` dispatches via `run claude`; verify that entry path passes the same header
  const resRun = await runCli(['run', 'claude', '--account', 'b'], { ANTHROPIC_CUSTOM_HEADERS: undefined });
  const launchedRun = JSON.parse(resRun.stdout) as { args: string[]; headers: string };
  assert.equal(launchedRun.headers, 'x-teamai-account: b');
});

test('2. pinned account in cooldown returns 429 with reason, no binding, and no failover to other accounts', async (t) => {
  const r = await createPoolRig(t);
  const sessionId = await issueClaudeSession();
  const accB = r.pool.accounts.find((a) => a.id === 'b')!;
  r.pool.cooldown(accB, 60_000, 'quota');

  const refused = await r.send(sessionId, { 'x-teamai-account': 'b' });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('x-teamai-429-reason'), 'pinned_account_cooldown');
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  assert.match(String(refused.json.error), /b@example\.test|\bb\b/);
  assert.match(String(refused.json.error), /cooldown/i);
  assert.equal(r.hits.length, 0, 'must not fall over to account a');
  assert.equal((await loadSessions())[sessionId], undefined, 'must not create a binding when rejected');

  // Once cooldown expires/clears, retrying with the same pending session ID succeeds and binds
  accB.cooldownUntil = null;
  accB.cooldownReason = null;
  const recovered = await r.send(sessionId, { 'x-teamai-account': 'b' });
  assert.equal(recovered.status, 200);
  assert.deepEqual(r.hits.map((h) => h.auth), ['Bearer fake-b']);
  assert.equal((await loadSessions())[sessionId]!.accountId, 'b');

  // CLI also rejects pre-launch when state.json records an active cooldown
  const cliRig = await createRig(t);
  const sessionsBeforeCli = await loadSessions();
  await saveState({
    version: 1,
    accounts: {
      'cred-b': { usage: 0.4, resetsAt: Date.now() + 3600_000, cooldownUntil: Date.now() + 3600_000, cooldownReason: 'quota', lastUsed: null, error: null },
    },
  });
  const { spawnedMarker, runCli } = await setupFakeClaude();
  await assert.rejects(prepareClaudeArgs(['--account', 'b'], cliRig.config), /cooldown/i);
  await assert.rejects(runCli(['claude', '--account', 'b']), (err: { stderr?: string }) => /cooldown/i.test(err.stderr ?? ''));
  await assert.rejects(stat(spawnedMarker));
  assert.deepEqual(await loadSessions(), sessionsBeforeCli);
});

test('3. pinned account with full 5h/7d/Fable window or concurrency cap returns 429 without failover or binding', async (t) => {
  const r = await createPoolRig(t, { maxConcurrent: 1 });
  const future = Date.now() + 3600_000;
  const accB = r.pool.accounts.find((a) => a.id === 'b')!;

  // 5h window full
  const sid5h = await issueClaudeSession();
  accB.usage = 1;
  accB.resetsAt = future;
  accB.windows = { '5h': { usage: 1, resetsAt: future }, '7d': { usage: 0.3, resetsAt: future * 2 } };
  const res5h = await r.send(sid5h, { 'x-teamai-account': 'b' });
  assert.equal(res5h.status, 429);
  assert.equal(res5h.headers.get('x-teamai-429-reason'), 'pinned_account_quota');
  assert.match(String(res5h.json.error), /b@example\.test|\bb\b/);
  assert.equal((await loadSessions())[sid5h], undefined);

  // 7d window full (even if account.usage wasn't copied)
  const sid7d = await issueClaudeSession();
  accB.usage = 0.2;
  accB.resetsAt = null;
  accB.windows = { '5h': { usage: 0.2, resetsAt: future }, '7d': { usage: 1, resetsAt: future } };
  const res7d = await r.send(sid7d, { 'x-teamai-account': 'b' });
  assert.equal(res7d.status, 429);
  assert.equal(res7d.headers.get('x-teamai-429-reason'), 'pinned_account_quota');
  assert.equal((await loadSessions())[sid7d], undefined);

  // Fable weekly window spent: Fable request fails, non-Fable request succeeds
  const sidFable = await issueClaudeSession();
  accB.usage = 0.2;
  accB.windows = { '5h': { usage: 0.2, resetsAt: future }, '7d': { usage: 0.2, resetsAt: future }, '7d_oi': { usage: 1, resetsAt: future } };
  const resFable = await r.send(sidFable, { 'x-teamai-account': 'b' }, { model: 'claude-fable-5-1', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(resFable.status, 429);
  assert.equal(resFable.headers.get('x-teamai-429-reason'), 'pinned_account_quota');
  assert.equal((await loadSessions())[sidFable], undefined);

  // Account lacking Fable window (Pro) rejects Fable request with pinned_account_model_unsupported
  const sidNoFable = await issueClaudeSession();
  accB.windows = { '5h': { usage: 0.2, resetsAt: future }, '7d': { usage: 0.2, resetsAt: future } };
  const resNoFable = await r.send(sidNoFable, { 'x-teamai-account': 'b' }, { model: 'claude-fable-5-1', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(resNoFable.status, 429);
  assert.equal(resNoFable.headers.get('x-teamai-429-reason'), 'pinned_account_model_unsupported');
  assert.equal((await loadSessions())[sidNoFable], undefined);

  // Non-Fable request succeeds when only Fable weekly window is spent
  accB.windows = { '5h': { usage: 0.2, resetsAt: future }, '7d': { usage: 0.2, resetsAt: future }, '7d_oi': { usage: 1, resetsAt: future } };
  const sidSonnet = await issueClaudeSession();
  const resSonnet = await r.send(sidSonnet, { 'x-teamai-account': 'b' }, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(resSonnet.status, 200);
  assert.deepEqual(r.hits.map((h) => h.auth), ['Bearer fake-b']);

  // Concurrency cap reached
  accB.windows = { '5h': { usage: 0.2, resetsAt: future }, '7d': { usage: 0.2, resetsAt: future } };
  accB.inflight = 1;
  const sidBusy = await issueClaudeSession();
  const resBusy = await r.send(sidBusy, { 'x-teamai-account': 'b' });
  assert.equal(resBusy.status, 429);
  assert.equal(resBusy.headers.get('x-teamai-429-reason'), 'pinned_account_busy');
  assert.match(String(resBusy.json.error), /b@example\.test|\bb\b/);
  assert.equal((await loadSessions())[sidBusy], undefined);
  assert.equal(r.hits.filter((h) => h.auth === 'Bearer fake-a').length, 0, 'account a must never receive a failover request');

  // Pre-launch CLI rejection when state.json shows exhausted 5h or 7d window
  const cliRig = await createRig(t);
  const { spawnedMarker, runCli } = await setupFakeClaude();
  await saveState({
    version: 1,
    accounts: {
      'cred-b': { usage: 1, resetsAt: future, cooldownUntil: null, lastUsed: null, error: null, windows: { '5h': { usage: 1, resetsAt: future } } },
    },
  });
  await assert.rejects(prepareClaudeArgs(['--account', 'b'], cliRig.config), /quota|window/i);
  await assert.rejects(runCli(['claude', '--account', 'b']));
  await saveState({
    version: 1,
    accounts: {
      'cred-b': { usage: 0.2, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { '7d': { usage: 1, resetsAt: future } } },
    },
  });
  await assert.rejects(prepareClaudeArgs(['--account', 'b'], cliRig.config), /7d quota window/i);
  await assert.rejects(stat(spawnedMarker));
});

test('4. unknown, ambiguous, wrong-provider, disabled accounts and codex --account fail before launch', async (t) => {
  const accounts: StoredAccount[] = [
    { id: 'a', provider: 'claude', label: 'dup@example.test', enabled: true, priority: 1, credentialId: 'cred-a', createdAt: '' },
    { id: 'b', provider: 'claude', label: 'dup@example.test', enabled: true, priority: 2, credentialId: 'cred-b', createdAt: '' },
    { id: 'off', provider: 'claude', label: 'off@example.test', enabled: false, priority: 3, credentialId: 'cred-off', createdAt: '' },
    { id: 'cx', provider: 'codex', label: 'codex@example.test', enabled: true, priority: 1, credentialId: 'cred-cx', createdAt: '' },
  ];
  const r = await createRig(t, { accounts });
  await r.start();
  const { spawnedMarker, runCli } = await setupFakeClaude();

  // Unknown, ambiguous label, wrong provider, disabled, malformed flags
  await assert.rejects(prepareClaudeArgs(['--account', 'missing'], r.config), /unknown/i);
  await assert.rejects(prepareClaudeArgs(['--account', 'dup@example.test'], r.config), /ambiguous/i);
  await assert.rejects(prepareClaudeArgs(['--account', 'codex@example.test'], r.config), /claude|codex/i);
  await assert.rejects(prepareClaudeArgs(['--account', 'off@example.test'], r.config), /disabled/i);
  for (const bad of [['--account'], ['--account='], ['--account', '--print'], ['--account', 'a', '--account', 'b']]) {
    await assert.rejects(prepareClaudeArgs(bad, r.config), /account/i);
  }

  for (const badArg of ['missing', 'dup@example.test', 'codex@example.test', 'off@example.test']) {
    await assert.rejects(runCli(['claude', '--account', badArg]));
  }
  await assert.rejects(runCli(['codex', '--account', 'a']), (err: { stderr?: string }) => /supported only for Claude/i.test(err.stderr ?? ''));
  await assert.rejects(runCli(['codex'], { TEAMAI_ACCOUNT: 'a' }), (err: { stderr?: string }) => /supported only for Claude/i.test(err.stderr ?? ''));
  await assert.rejects(stat(spawnedMarker), 'claude binary must never be executed on pre-launch failures');
  assert.equal(await readFile(join(process.env.TEAMAI_HOME!, '.sessions-ledger.json'), 'utf8').catch(() => null), null);

  // Ambiguous label resolved by exact id succeeds
  const byId = await prepareClaudeArgs(['--account', 'b'], r.config);
  assert.equal(byId[0], '--session-id');

  // Proxy also rejects unknown, ambiguous, and disabled accounts on unbound sessions without binding
  const sidUnknown = await issueClaudeSession();
  assert.equal((await r.send(sidUnknown, { 'x-teamai-account': 'missing' })).status, 404);
  const sidAmbiguous = await issueClaudeSession();
  assert.equal((await r.send(sidAmbiguous, { 'x-teamai-account': 'dup@example.test' })).status, 400);
  const sidDisabled = await issueClaudeSession();
  assert.equal((await r.send(sidDisabled, { 'x-teamai-account': 'off' })).status, 503);
  assert.equal(r.hits.length, 0);
});

test('5. omitted --account and TEAMAI_ACCOUNT preserve existing automatic selection and pinning', async (t) => {
  const r = await createRig(t);
  await r.start();
  const { runCli } = await setupFakeClaude({ TEAMAI_ACCOUNT: '', ANTHROPIC_CUSTOM_HEADERS: undefined });

  const launched = JSON.parse((await runCli(['claude', '--print', 'auto'])).stdout) as { args: string[]; headers: string };
  assert.equal(launched.headers, '');
  const sid = launched.args[1]!;

  // Priority #1 ('a') wins automatically; second request stays pinned to 'a'
  assert.equal((await r.send(sid)).status, 200);
  assert.equal((await r.send(sid)).status, 200);
  assert.deepEqual(r.hits.map((h) => h.auth), ['Bearer fake-a', 'Bearer fake-a']);
  assert.equal((await loadSessions())[sid]!.accountId, 'a');
});

test('6. session continuity keeps the bound account and rejects mismatched x-teamai-account with 409', async (t) => {
  const r = await createPoolRig(t);
  const sid = await issueClaudeSession();

  // Bind session to priority #2 account 'b'
  assert.equal((await r.send(sid, { 'x-teamai-account': 'b' })).status, 200);
  // Turn 2 without header (resume) continues on 'b'
  assert.equal((await r.send(sid)).status, 200);
  // Turn 3 with matching header (by id or label) continues on 'b'
  assert.equal((await r.send(sid, { 'x-teamai-account': 'b' })).status, 200);
  assert.equal((await r.send(sid, { 'x-teamai-account': 'b@example.test' })).status, 200);

  // Turn 4 with a different account header or unknown account header is rejected with 409
  const mismatch = await r.send(sid, { 'x-teamai-account': 'a' });
  assert.equal(mismatch.status, 409);
  const mismatchUnknown = await r.send(sid, { 'x-teamai-account': 'unknown' });
  assert.equal(mismatchUnknown.status, 409);

  assert.deepEqual(r.hits.map((h) => h.auth), ['Bearer fake-b', 'Bearer fake-b', 'Bearer fake-b', 'Bearer fake-b']);
  assert.equal((await loadSessions())[sid]!.accountId, 'b');
});

test('7. x-teamai-account header is stripped before forwarding upstream', async (t) => {
  const r = await createPoolRig(t);
  const sid = await issueClaudeSession();

  assert.equal((await r.send(sid, { 'X-TeamAI-Account': 'b', 'x-custom-keep': 'yes' })).status, 200);
  assert.equal((await r.send(sid, { 'x-teamai-account': 'b', 'x-custom-keep': 'yes' })).status, 200);
  assert.equal(r.hits.length, 2);
  for (const hit of r.hits) {
    assert.equal(hit.headers['x-teamai-account'], undefined);
    assert.equal(hit.headers['x-teamai-group'], undefined);
    assert.equal(hit.headers['x-custom-keep'], 'yes');
  }
});

test('8. --account with --group allows group members only and exclusive routes are never bypassed', async (t) => {
  const accounts: StoredAccount[] = [
    { id: 'outside', provider: 'claude', label: 'outside@example.test', enabled: true, priority: 1, credentialId: 'cred-outside', createdAt: '' },
    { id: 'a', provider: 'claude', label: 'a@example.test', enabled: true, priority: 2, credentialId: 'cred-a', createdAt: '' },
    { id: 'b', provider: 'claude', label: 'b@example.test', enabled: true, priority: 3, credentialId: 'cred-b', createdAt: '' },
  ];
  const r = await createRig(t, { accounts, groups: { master: ['a@example.test', 'b@example.test'] } });
  await r.start();
  const { spawnedMarker, runCli } = await setupFakeClaude();

  // Outside account combined with --group fails pre-launch without registering a session or spawning claude
  await assert.rejects(prepareClaudeArgs(['--group', 'master', '--account', 'outside'], r.config), /not in group/i);
  await assert.rejects(runCli(['claude', '--group', 'master', '--account', 'outside']));
  await assert.rejects(stat(spawnedMarker));

  // Member account combined with --group succeeds and binds both group and account
  const launched = JSON.parse((await runCli(['claude', '--group', 'master', '--account', 'b'])).stdout) as { args: string[]; headers: string };
  assert.match(launched.headers, /x-teamai-group: master/);
  assert.match(launched.headers, /x-teamai-account: b/);
  const sid = launched.args[1]!;
  const ok = await r.send(sid, { 'x-teamai-group': 'master', 'x-teamai-account': 'b' });
  assert.equal(ok.status, 200);
  assert.equal(r.hits[0]!.auth, 'Bearer fake-b');
  const stored = (await loadSessions())[sid]!;
  assert.equal(stored.group, 'master');
  assert.equal(stored.accountId, 'b');

  // Proxy also enforces group membership and exclusive routes without bypassing
  const poolRig = await createPoolRig(t, { accounts });
  poolRig.pool.setGroups({ master: ['a', 'b'] });
  const sidGroupMismatch = await issueClaudeSession('master');
  const groupRefused = await poolRig.send(sidGroupMismatch, { 'x-teamai-group': 'master', 'x-teamai-account': 'outside' });
  assert.equal(groupRefused.status, 400);
  assert.equal((await loadSessions())[sidGroupMismatch], undefined);

  poolRig.pool.setRoutes(parseRoutes([{ name: 'opus-only', match: ['claude-opus-*'], accounts: ['a'], mode: 'exclusive' }], 'claude'));
  const sidRoute = await issueClaudeSession();
  const routeRefused = await poolRig.send(
    sidRoute,
    { 'x-teamai-account': 'b' },
    { model: 'claude-opus-4', messages: [{ role: 'user', content: 'hi' }] },
  );
  assert.equal(routeRefused.status, 429);
  assert.equal(routeRefused.headers.get('x-teamai-429-reason'), 'pinned_account_route_excluded');
  assert.match(String(routeRefused.json.error), /opus-only/);
  assert.match(String(routeRefused.json.error), /b@example\.test|\bb\b/);
  assert.equal((await loadSessions())[sidRoute], undefined);
  assert.equal(poolRig.hits.length, 0);

  // Prefer routes do not exclude an explicitly pinned account
  poolRig.pool.setRoutes(parseRoutes([{ name: 'opus-prefer', match: ['claude-opus-*'], accounts: ['a'], mode: 'prefer' }], 'claude'));
  const preferAllowed = await poolRig.send(
    sidRoute,
    { 'x-teamai-account': 'b' },
    { model: 'claude-opus-4', messages: [{ role: 'user', content: 'hi' }] },
  );
  assert.equal(preferAllowed.status, 200);
  assert.deepEqual(poolRig.hits.map((h) => h.auth), ['Bearer fake-b']);
});
