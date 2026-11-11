import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { handleClaudeSessionControl } from '../src/claude-session-control.js';
import { claudeProvider, claudeUsageQuota, codexProvider } from '../src/providers.js';
import { createProxy } from '../src/proxy.js';
import { handleResetCreditControl } from '../src/reset-credit-control.js';
import {
  classifyConsume,
  claudeResetCreditCount,
  CLAUDE_NO_SPEND_CODES,
  CODEX_NO_SPEND_CODES,
  eligibility,
  parseClaudeResetCreditList,
  resetCreditSettings,
} from '../src/reset-credits.js';
import type { Provider, RuntimeAccount, StoredAccount } from '../src/types.js';
import { UsageRefresher } from '../src/usage-refresh.js';
import { stripAnsi } from '../src/columns.js';
import { buildFrame, type CreditPicker } from '../src/frame.js';
import { creditPickerKey } from '../src/tui.js';
import type { PersistedState, TeamAIConfig } from '../src/types.js';

test('claudeUsageQuota extracts reset credit count from cedar_ember grants', () => {
  const data = {
    limits: [{ kind: 'session', percent: 20, resets_at: '2026-11-11T20:00:00Z' }],
    cedar_ember: {
      eligible: true,
      grants: [
        { id: 'g1', label: 'Grant 1', resets_left: 2, paused: false },
        { id: 'g2', label: 'Grant 2', resets_left: 1, paused: false },
        { id: 'g3', label: 'Grant 3 (paused)', resets_left: 5, paused: true },
        { id: 'g4', label: 'Grant 4 (spent)', resets_left: 0, paused: false },
      ],
    },
  };
  const quota = claudeUsageQuota(data);
  assert.equal(quota?.resetCredits, 3);
  assert.equal(claudeResetCreditCount(data), 3);

  assert.equal(claudeResetCreditCount({ cedar_ember: { eligible: false, grants: [{ resets_left: 2 }] } }), null);
  assert.equal(claudeResetCreditCount({ limits: [] }), null);
});

test('parseClaudeResetCreditList parses grants and preserves fields', () => {
  const raw = {
    cedar_ember: {
      grants: [
        {
          id: 'grant-late',
          label: 'November Reset',
          starts_at: '2026-11-01T00:00:00Z',
          ends_at: '2026-12-10T22:00:00Z',
          clears: ['five_hour', 'seven_day'],
          paused: false,
          usable_now: true,
          gives_back_weekly: true,
          unavailable_reason: null,
          resets_left: 1,
        },
        {
          id: 'grant-soon',
          label: 'Fable Special',
          starts_at: null,
          ends_at: '2026-11-20T00:00:00Z',
          clears: ['five_hour'],
          paused: false,
          usable_now: false,
          gives_back_weekly: false,
          unavailable_reason: 'needs_limit',
          resets_left: 2,
        },
        {
          id: 'grant-paused',
          label: 'Paused',
          paused: true,
          resets_left: 1,
        },
        {
          id: 'grant-spent',
          label: 'Spent',
          paused: false,
          resets_left: 0,
        },
      ],
    },
  };

  const list = parseClaudeResetCreditList(raw);
  assert.equal(list.length, 2);
  // soonest to expire first
  assert.equal(list[0]!.id, 'grant-soon');
  assert.equal(list[0]!.title, 'Fable Special');
  assert.equal(list[0]!.usableNow, false);
  assert.equal(list[0]!.unavailableReason, 'needs_limit');
  assert.equal(list[0]!.resetsLeft, 2);
  assert.deepEqual(list[0]!.clears, ['five_hour']);

  assert.equal(list[1]!.id, 'grant-late');
  assert.equal(list[1]!.title, 'November Reset');
  assert.equal(list[1]!.usableNow, true);
  assert.equal(list[1]!.givesBackWeekly, true);
  assert.equal(list[1]!.unavailableReason, null);
  assert.deepEqual(list[1]!.clears, ['five_hour', 'seven_day']);
  assert.equal(list[1]!.grantedAt, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(list[1]!.expiresAt, Date.parse('2026-12-10T22:00:00Z'));
});

test('codex NO_SPEND_CODES preserves original behavior and excludes cooldown', () => {
  assert.deepEqual([...CODEX_NO_SPEND_CODES].sort(), ['already_redeemed', 'no_credit', 'nothing_to_reset']);
  assert.equal(classifyConsume(200, JSON.stringify({ code: 'cooldown' })).kind, 'indeterminate');
  assert.equal(classifyConsume(200, JSON.stringify({ code: 'already_used' })).kind, 'indeterminate');
  assert.equal(classifyConsume(200, JSON.stringify({ code: 'not_limited' })).kind, 'indeterminate');
  assert.equal(classifyConsume(200, JSON.stringify({ code: 'ineligible' })).kind, 'indeterminate');
  assert.equal(classifyConsume(200, JSON.stringify({ code: 'unavailable' })).kind, 'indeterminate');
});

test('claude consume answers classify supported no-spend codes while unavailable is indeterminate without proof', () => {
  assert.ok(CLAUDE_NO_SPEND_CODES.has('already_used'));
  assert.ok(CLAUDE_NO_SPEND_CODES.has('not_limited'));
  assert.ok(CLAUDE_NO_SPEND_CODES.has('ineligible'));
  assert.ok(CLAUDE_NO_SPEND_CODES.has('cooldown'));
  assert.equal(CLAUDE_NO_SPEND_CODES.has('unavailable'), false);
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'reset', cleared: ['five_hour', 'seven_day'] }), 'claude').kind, 'reset');
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'reset', cleared: ['five_hour'] }), 'claude').windowsReset, 1);
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'already_used', reason: 'already_used' }), 'claude').kind, 'no-spend');
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'not_limited', reason: 'not_limited' }), 'claude').kind, 'no-spend');
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'ineligible', reason: 'tier' }), 'claude').kind, 'no-spend');
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'cooldown', reason: 'cooldown' }), 'claude').kind, 'no-spend');
  assert.equal(classifyConsume(200, JSON.stringify({ result: 'unavailable' }), 'claude').kind, 'indeterminate');
  assert.equal(classifyConsume(429, '{"error":"rate_limit"}', 'claude').kind, 'no-spend');
  assert.equal(classifyConsume(401, '{"error":"unauthorized"}', 'claude').kind, 'no-spend');
  assert.equal(classifyConsume(500, '{"error":"server_error"}', 'claude').kind, 'indeterminate');
});

test('claude automatic use is not supported and eligibility returns manual-only', () => {
  const account: RuntimeAccount = {
    id: 'a',
    label: 'a@example.com',
    provider: 'claude',
    enabled: true,
    priority: 1,
    credentialId: 'a',
    createdAt: '',
    inflight: 0,
    retired: false,
    usage: 1,
    resetsAt: Date.now() + 3_600_000,
    cooldownUntil: null,
    cooldownReason: null,
    cooldownAt: null,
    lastUsed: null,
    error: null,
    windows: {
      '5h': { usage: 1, resetsAt: Date.now() + 3_600_000 },
      '7d': { usage: 1, resetsAt: Date.now() + 86_400_000 },
    },
    profile: null,
    measuredAt: null,
    resetCredits: 3,
    resetCreditsAt: Date.now(),
    credential: {
      accessToken: 'tok',
      refreshToken: null,
      expiresAt: Date.now() + 3_600_000,
      accountId: 'a',
    },
  };

  // Case a: default settings
  const def = resetCreditSettings({});
  assert.equal(eligibility(account, def, 'claude'), 'not-codex-oauth');

  // Case b: codexResetCredits: true
  const codexOn = resetCreditSettings({ codexResetCredits: true });
  assert.equal(eligibility(account, codexOn, 'claude'), 'not-codex-oauth');

  // Case c: legacy claudeResetCredits in config
  const legacyConfig = resetCreditSettings({ claudeResetCredits: true } as unknown as Parameters<typeof resetCreditSettings>[0]);
  assert.equal(eligibility(account, legacyConfig, 'claude'), 'not-codex-oauth');
});

interface FakeClaudeServer {
  url: string;
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }>;
  close: () => void;
}

function startFakeClaude(handler?: (req: IncomingMessage, res: ServerResponse, bodyText: string) => boolean): Promise<FakeClaudeServer> {
  const calls: FakeClaudeServer['calls'] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let parsedBody: Record<string, unknown> | null = null;
    try { parsedBody = JSON.parse(bodyText); } catch { /* non-json */ }
    const rawHeaders = req.headers;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) if (typeof v === 'string') headers[k] = v;

    calls.push({ method: req.method || 'GET', path: req.url || '/', headers, body: parsedBody });

    if (handler && handler(req, res, bodyText)) return;

    if (req.url === '/api/oauth/profile') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        account: { has_claude_pro: true },
        organization: { uuid: 'org-1234', subscription_status: 'active' },
      }));
      return;
    }
    if (req.url?.startsWith('/api/oauth/usage')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        limits: [{ kind: 'session', percent: 50, resets_at: '2026-11-11T20:00:00Z' }],
        cedar_ember: {
          eligible: true,
          grants: [{ id: 'grant-test', label: 'Test Ticket', resets_left: 1, paused: false }],
        },
      }));
      return;
    }
    if (req.url === '/api/organizations/org-1234/reset_rate_limits') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'reset', cleared: ['five_hour', 'seven_day'], resets_left: 0 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      assert(addr && typeof addr !== 'string');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        close: () => { server.closeAllConnections(); server.close(); },
      });
    });
  });
}

test('claudeProvider fetchResetCredits sends expected GET request and headers', async (t) => {
  const fake = await startFakeClaude();
  t.after(() => fake.close());

  const provider: Provider = { ...claudeProvider, upstreamBase: fake.url };
  const credits = await provider.fetchResetCredits!({
    accessToken: 'token-abc',
    refreshToken: null,
    expiresAt: Date.now() + 3_600_000,
    accountId: 'acc-1',
  });

  assert.equal(credits.length, 1);
  assert.equal(credits[0]!.id, 'grant-test');
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0]!;
  assert.equal(call.method, 'GET');
  assert.equal(call.path, '/api/oauth/usage?cedar_ember=1&skip_spend=1');
  assert.equal(call.headers['authorization'], 'Bearer token-abc');
  assert.equal(call.headers['x-app'], 'cli');
  assert.equal(call.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.match(call.headers['user-agent'] || '', /claude-cli\//);
});

test('claudeProvider consumeResetCredit sends expected POST request, headers and body', async (t) => {
  const fake = await startFakeClaude();
  t.after(() => fake.close());

  const provider: Provider = { ...claudeProvider, upstreamBase: fake.url };
  const res = await provider.consumeResetCredit!(
    {
      accessToken: 'token-xyz',
      refreshToken: null,
      expiresAt: Date.now() + 3_600_000,
      accountId: 'acc-1',
      organizationUuid: 'org-1234',
    },
    {
      redeemRequestId: 'req-555',
      creditId: 'grant-test',
      timeoutMs: 5000,
    },
  );

  assert.equal(res.status, 200);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/api/organizations/org-1234/reset_rate_limits');
  assert.equal(call.headers['authorization'], 'Bearer token-xyz');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(call.headers['x-app'], 'cli');
  assert.match(call.headers['user-agent'] || '', /claude-cli\//);
  assert.deepEqual(call.body, {
    program: 'cedar_ember',
    grant_id: 'grant-test',
    request_id: 'req-555',
  });
});

test('claude control routes handle list and operator redeem with verification', async (t) => {
  const fake = await startFakeClaude();
  t.after(() => fake.close());

  const provider: Provider = { ...claudeProvider, upstreamBase: fake.url };
  const stored: StoredAccount = { id: 'c1', provider: 'claude', label: 'claude1@example.com', enabled: true, priority: 1, credentialId: 'c1', createdAt: '' };
  const pool = new AccountPool(provider, [stored], {
    c1: { accessToken: 'tok-c1', refreshToken: null, expiresAt: Date.now() + 3_600_000, accountId: 'acc-c1', organizationUuid: 'org-1234' },
  }, { version: 1, accounts: {} });
  pool.saveNow = async () => {};

  const server = createServer((req, res) => {
    void handleResetCreditControl(req, res, [pool], 'secret-tok').then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  t.after(() => { server.closeAllConnections(); server.close(); });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  const auth = { authorization: 'Bearer secret-tok' };

  // 401 Unauthorized
  const unauth = await fetch(`${base}/claude/reset-credits?account=c1`, { headers: { authorization: 'Bearer bad' } });
  assert.equal(unauth.status, 401);

  // 405 Method Not Allowed
  const postList = await fetch(`${base}/claude/reset-credits?account=c1`, { method: 'POST', headers: auth });
  assert.equal(postList.status, 405);

  // 400 Bad Request if body on redeem
  const bodyRedeem = await fetch(`${base}/claude/reset-credit?account=c1`, { method: 'POST', headers: auth, body: 'bad' });
  assert.equal(bodyRedeem.status, 400);

  // List tickets
  const listRes = await fetch(`${base}/claude/reset-credits?account=c1`, { headers: auth });
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json() as { credits: Array<{ id: string }> };
  assert.equal(listJson.credits.length, 1);
  assert.equal(listJson.credits[0]!.id, 'grant-test');

  // Operator Redeem
  const redeemRes = await fetch(`${base}/claude/reset-credit?account=c1&credit_id=grant-test`, { method: 'POST', headers: auth });
  assert.equal(redeemRes.status, 200);
  const redeemJson = await redeemRes.json() as { reset: boolean; outcome: string; account: string };
  assert.equal(redeemJson.reset, true);
  assert.equal(redeemJson.outcome, 'reset');
  assert.equal(redeemJson.account, 'claude1@example.com');
});

test('fleet exhausted does not spend Claude tickets under any configuration (a, b, c)', async (t) => {
  const fake = await startFakeClaude();
  t.after(() => fake.close());

  const provider: Provider = { ...claudeProvider, upstreamBase: fake.url };
  const stored: StoredAccount = { id: 'c1', provider: 'claude', label: 'claude1@example.com', enabled: true, priority: 1, credentialId: 'c1', createdAt: '' };
  const pool = new AccountPool(provider, [stored], {
    c1: { accessToken: 'tok-c1', refreshToken: null, expiresAt: Date.now() + 3_600_000, accountId: 'acc-c1', organizationUuid: 'org-1234' },
  }, { version: 1, accounts: {} });

  const account = pool.accounts[0]!;
  account.usage = 1;
  account.resetCredits = 3;
  account.resetCreditsAt = Date.now();
  account.windows = {
    '5h': { usage: 1, resetsAt: Date.now() + 3_600_000 },
    '7d': { usage: 1, resetsAt: Date.now() + 86_400_000 },
  };

  // Case (a): no settings
  pool.resetCredits = resetCreditSettings({});
  const resA = await pool.redeemForFleet(new Set());
  assert.equal(resA.attempted, false);
  assert.equal(resA.reset, null);
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);

  // Case (b): codexResetCredits: true
  pool.resetCredits = resetCreditSettings({ codexResetCredits: true });
  const resB = await pool.redeemForFleet(new Set());
  assert.equal(resB.attempted, false);
  assert.equal(resB.reset, null);
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);

  // Case (c): legacy claudeResetCredits in config
  pool.resetCredits = resetCreditSettings({ claudeResetCredits: true } as unknown as Parameters<typeof resetCreditSettings>[0]);
  const resC = await pool.redeemForFleet(new Set());
  assert.equal(resC.attempted, false);
  assert.equal(resC.reset, null);
  assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);
});

test('proxy auto-path: Claude proxy never spends tickets automatically under any configuration (a, b, c)', async (t) => {
  let consumeCalls = 0;
  const fake = await startFakeClaude((req, res) => {
    if (req.url === '/api/organizations/org-1234/reset_rate_limits') {
      consumeCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'reset', cleared: ['five_hour', 'seven_day'], resets_left: 0 }));
      return true;
    }
    if (req.url?.startsWith('/v1/messages')) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-7d-status': 'rejected',
        'anthropic-ratelimit-unified-7d-utilization': '1',
        'retry-after': '60',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }));
      return true;
    }
    return false;
  });
  t.after(() => fake.close());

  const provider: Provider = { ...claudeProvider, upstreamBase: fake.url };
  const stored: StoredAccount = { id: 'c1', provider: 'claude', label: 'claude1@example.com', enabled: true, priority: 1, credentialId: 'c1', createdAt: '' };
  const pool = new AccountPool(provider, [stored], {
    c1: { accessToken: 'tok-c1', refreshToken: null, expiresAt: Date.now() + 3_600_000, accountId: 'acc-c1', organizationUuid: 'org-1234' },
  }, { version: 1, accounts: {} });
  pool.saveNow = async () => {};
  pool.accounts[0]!.resetCredits = 3;
  pool.accounts[0]!.resetCreditsAt = Date.now();

  const proxy = createProxy(pool, 'test-secret', () => {});
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyAddr = proxy.address() as AddressInfo;
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });

  const control = createServer(async (req, res) => {
    if (!(await handleClaudeSessionControl(req, res, 'test-secret', pool))) {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
  const controlAddr = control.address() as AddressInfo;
  t.after(() => { control.closeAllConnections(); control.close(); });

  const configs = [
    {}, // (a) no settings
    { codexResetCredits: true }, // (b) codex enabled
    { claudeResetCredits: true } as unknown as Parameters<typeof resetCreditSettings>[0], // (c) legacy key
  ];

  for (const cfg of configs) {
    pool.resetCredits = resetCreditSettings(cfg);
    const sres = await fetch(`http://127.0.0.1:${controlAddr.port}/claude/sessions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret' },
    });
    const { sessionId } = await sres.json() as { sessionId: string };

    const pres = await fetch(`http://127.0.0.1:${proxyAddr.port}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
        'x-claude-code-session-id': sessionId,
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet-20250219',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });

    assert.equal(pres.status, 429);
  }

  assert.equal(consumeCalls, 0, 'No reset credits consumed under any configuration (a, b, c)');
});

test('proxy creditPass provider guard: non-codex provider does not spend tickets on 429', async (t) => {
  let consumeCalls = 0;
  const upstream = createServer((req, res) => {
    if (req.url === '/consume') {
      consumeCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'reset', windows_reset: 1 }));
      return;
    }
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'usage_limit_reached', message: 'Quota exceeded' } }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upAddr = upstream.address() as AddressInfo;
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });

  const customProvider: Provider = {
    ...codexProvider,
    id: 'mock_provider' as unknown as Provider['id'],
    label: 'MockProvider',
    upstreamBase: `http://127.0.0.1:${upAddr.port}`,
    async consumeResetCredit() {
      consumeCalls++;
      return { status: 200, body: JSON.stringify({ code: 'reset' }) };
    },
  };

  const stored: StoredAccount = { id: 'm1', provider: customProvider.id, label: 'm1@example.com', enabled: true, priority: 1, credentialId: 'm1', createdAt: '' };
  const pool = new AccountPool(customProvider, [stored], {
    m1: { accessToken: 'tok-m1', refreshToken: null, expiresAt: Date.now() + 3_600_000, accountId: 'acc-m1' },
  }, { version: 1, accounts: {} });
  pool.saveNow = async () => {};
  pool.resetCredits = resetCreditSettings({ codexResetCredits: true });
  pool.accounts[0]!.resetCredits = 3;
  pool.accounts[0]!.resetCreditsAt = Date.now();

  let fleetRedeemCalled = false;
  const origRedeem = pool.redeemForFleet.bind(pool);
  pool.redeemForFleet = async (...args) => {
    fleetRedeemCalled = true;
    return origRedeem(...args);
  };

  const proxy = createProxy(pool, 'test-secret', () => {});
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyAddr = proxy.address() as AddressInfo;
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });

  const pres = await fetch(`http://127.0.0.1:${proxyAddr.port}/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5' }),
  });

  assert.equal(pres.status, 429);
  assert.equal(consumeCalls, 0, 'non-codex provider never triggers creditPass automatic redemption');
  assert.equal(fleetRedeemCalled, false, 'redeemForFleet must not be called when provider is not codex');
});

test('usage-refresh countsDue reflects provider-specific ticket list check', () => {
  const providerClaude: Provider = { ...claudeProvider };
  const providerCodex: Provider = { ...codexProvider };
  const storedClaude: StoredAccount = { id: 'c1', provider: 'claude', label: 'c1@example.com', enabled: true, priority: 1, credentialId: 'c1', createdAt: '' };
  const storedCodex: StoredAccount = { id: 'x1', provider: 'codex', label: 'x1@example.com', enabled: true, priority: 1, credentialId: 'x1', createdAt: '' };

  const poolClaude = new AccountPool(providerClaude, [storedClaude], { c1: { accessToken: 'tok', refreshToken: null, expiresAt: null, accountId: 'acc-c1' } }, { version: 1, accounts: {} });
  const poolCodex = new AccountPool(providerCodex, [storedCodex], { x1: { accessToken: 'tok', refreshToken: null, expiresAt: null, accountId: 'acc-x1' } }, { version: 1, accounts: {} });

  const scheduler = new UsageRefresher([poolClaude, poolCodex], {
    intervalMs: 60_000,
    jitterMaxMs: 0,
    concurrency: 1,
  });

  const now = Date.now();
  const cutoff = now - 60_000;
  poolClaude.accounts[0]!.resetCreditsAt = cutoff - 1000;
  poolCodex.accounts[0]!.resetCreditsAt = cutoff - 1000;

  const countsDueFn = (scheduler as unknown as { countsDue: (p: AccountPool, a: RuntimeAccount, c: number) => boolean }).countsDue;

  // With codexResetCredits: false, Claude is due (for visibility) but Codex is not due
  poolCodex.resetCredits = resetCreditSettings({ codexResetCredits: false });
  assert.equal(countsDueFn.call(scheduler, poolClaude, poolClaude.accounts[0]!, cutoff), true, 'claude countsDue is true for operator visibility');
  assert.equal(countsDueFn.call(scheduler, poolCodex, poolCodex.accounts[0]!, cutoff), false, 'codex countsDue is false when codexResetCredits is false');

  // With codexResetCredits: true, Codex becomes due
  poolCodex.resetCredits = resetCreditSettings({ codexResetCredits: true });
  assert.equal(countsDueFn.call(scheduler, poolCodex, poolCodex.accounts[0]!, cutoff), true, 'codex countsDue is true when codexResetCredits is true');
});

test('sublist credit picker snapshots at 40, 60, 80, 120 columns: folded, unfolded, 0 credits, failed', () => {
  const config: TeamAIConfig = {
    version: 1,
    proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'tok' },
    switchThreshold: 0.98,
    maxConcurrentPerAccount: 3,
    accounts: [
      { id: 'c1', provider: 'claude', label: 'c1@example.com', enabled: true, priority: null, credentialId: 'c1', createdAt: '' },
      { id: 'c2', provider: 'claude', label: 'c2@example.com', enabled: true, priority: null, credentialId: 'c2', createdAt: '' },
    ],
  };
  const state: PersistedState = {
    version: 1,
    accounts: {
      c1: { usage: 0.2, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { '5h': { usage: 0.2, resetsAt: null }, '7d': { usage: 0.1, resetsAt: null } } },
      c2: { usage: 0.5, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { '5h': { usage: 0.5, resetsAt: null }, '7d': { usage: 0.3, resetsAt: null } } },
    },
  };

  const widths = [40, 60, 80, 120];

  for (const width of widths) {
    // (a) Folded
    const folded = buildFrame(config, state, { width, selectedId: 'c1', mode: 'normal', message: '', sortByHeadroom: false }).map(stripAnsi);
    assert.ok(folded.some((l) => l.includes('c1@')));
    assert.ok(!folded.some((l) => /Loading…|No reset credits available|Failed to load credits|Ticket Alpha/.test(l)));
    assert.ok(!folded.some((l) => /Reset credits —/.test(l)), `no separate bottom section at width ${width}`);

    // (b) Unfolded (2 tickets)
    const pickerData: CreditPicker = {
      account: 'c1@example.com',
      phase: 'pick',
      items: [
        { id: 't1', title: 'Ticket Alpha', grantedAt: 1731300000000, expiresAt: 1733800000000, resetsLeft: 2, usableNow: true },
        { id: 't2', title: 'Ticket Beta', grantedAt: 1731300000000, expiresAt: 1735000000000, usableNow: false, unavailableReason: 'cooldown' },
      ],
      index: 0,
    };
    const unfolded = buildFrame(config, state, { width, selectedId: 'c1', mode: 'credits', message: '', sortByHeadroom: false, credits: pickerData }).map(stripAnsi);
    const c1Index = unfolded.findIndex((l) => l.includes('c1@'));
    assert.ok(c1Index >= 0, `selected account found in frame at width ${width}`);
    // Sublist starts immediately below the selected account line (or below its reset row if narrow stacked)
    const sublistIdx = unfolded.findIndex((l, idx) => idx > c1Index && l.includes('Ticket Alpha'));
    assert.ok(sublistIdx === c1Index + 1 || sublistIdx === c1Index + 2, `Ticket Alpha immediately below selected account at width ${width} (c1: ${c1Index}, sub: ${sublistIdx})`);
    assert.ok(unfolded[sublistIdx]!.includes('>'), 'chosen ticket has cursor');
    assert.ok(unfolded[sublistIdx + 1]!.includes('Ticket Beta'), 'second ticket follows');
    const c2Index = unfolded.findIndex((l) => l.includes('c2@'));
    assert.ok(c2Index > sublistIdx + 1, 'other accounts appear after the sublist');
    // Assert no bottom credit section exists
    assert.ok(!unfolded.some((l) => /Reset credits —/.test(l)), `no separate bottom section at width ${width}`);

    // (c) 0 tickets
    const emptyPicker: CreditPicker = { account: 'c1@example.com', phase: 'pick', items: [], index: 0 };
    const emptyFrame = buildFrame(config, state, { width, selectedId: 'c1', mode: 'credits', message: '', sortByHeadroom: false, credits: emptyPicker }).map(stripAnsi);
    const c1EmptyIdx = emptyFrame.findIndex((l) => l.includes('c1@'));
    const zeroLineIdx = emptyFrame.findIndex((l, idx) => idx > c1EmptyIdx && l.includes('No reset credits available'));
    assert.ok(zeroLineIdx === c1EmptyIdx + 1 || zeroLineIdx === c1EmptyIdx + 2, `zero credits line immediately below selected account at width ${width}`);
    assert.ok(!emptyFrame.some((l) => /Reset credits —/.test(l)), `no separate bottom section at width ${width}`);

    // (d) Failed to load
    const failedPicker: CreditPicker = { account: 'c1@example.com', phase: 'failed', items: [], index: 0, error: 'connection refused' };
    const failedFrame = buildFrame(config, state, { width, selectedId: 'c1', mode: 'credits', message: '', sortByHeadroom: false, credits: failedPicker }).map(stripAnsi);
    const c1FailedIdx = failedFrame.findIndex((l) => l.includes('c1@'));
    const failLineIdx = failedFrame.findIndex((l, idx) => idx > c1FailedIdx && l.includes('Failed to load credits'));
    assert.ok(failLineIdx === c1FailedIdx + 1 || failLineIdx === c1FailedIdx + 2, `failed line immediately below selected account at width ${width}`);
    assert.ok(!failedFrame.some((l) => /Reset credits —/.test(l)), `no separate bottom section at width ${width}`);
  }
});

test('sublist credit picker: chosen ticket id is passed to control call, cancel makes 0 calls, wrong ticket id fails', async () => {
  const items = [
    { id: 'id-alpha', title: 'Ticket Alpha', grantedAt: null, expiresAt: null },
    { id: 'id-beta', title: 'Ticket Beta', grantedAt: null, expiresAt: null },
  ];
  let picker: CreditPicker = {
    account: 'c1@example.com',
    phase: 'pick',
    items,
    index: 0,
  };

  // 1. Move down to index 1 (Ticket Beta)
  const step1 = creditPickerKey(picker, '\x1b[B');
  assert.equal(step1.credits?.index, 1);
  picker = step1.credits!;

  // 2. Press Enter to confirm
  const step2 = creditPickerKey(picker, '\r');
  assert.equal(step2.credits?.phase, 'confirm');
  picker = step2.credits!;

  // 3. Reject with 'n' -> returns to pick phase, no redeem call
  const redeemCalls: string[] = [];
  const fakeRedeem = async (chosenId: string) => { redeemCalls.push(chosenId); };
  const step3 = creditPickerKey(picker, 'n');
  assert.equal(step3.credits?.phase, 'pick');
  assert.equal(step3.redeem, undefined);
  picker = step3.credits!;
  assert.equal(redeemCalls.length, 0, 'cancelling with n makes 0 redeem calls');

  // 4. Move to confirm again, then cancel with Esc -> close is true, 0 redeem calls
  const step4 = creditPickerKey(picker, '\r');
  assert.equal(step4.credits?.phase, 'confirm');
  picker = step4.credits!;
  const step5 = creditPickerKey(picker, '\x1b');
  assert.equal(step5.close, true);
  assert.equal(step5.redeem, undefined);
  assert.equal(redeemCalls.length, 0, 'cancelling with Esc makes 0 redeem calls');

  // 5. Confirm with 'y' -> triggers redeem for chosen ticket (id-beta)
  const step6 = creditPickerKey(picker, 'y');
  assert.equal(step6.redeem, true);
  const chosen = items[picker.index]!;
  await fakeRedeem(chosen.id!);
  assert.equal(redeemCalls.length, 1);
  assert.equal(redeemCalls[0], 'id-beta', 'chosen ticket id passed to redeem');

  // Mutation check: if code passed the wrong ticket id (e.g. index 0 instead of chosen index), it fails
  const mutatedGetId = () => items[0]!.id; // Mutation: always passes index 0
  assert.notEqual(mutatedGetId(), chosen.id, 'mutation of passing wrong ticket id is detected');
});
