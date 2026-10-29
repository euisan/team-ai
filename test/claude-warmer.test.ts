import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildClaudeWarmRequest, CLAUDE_WARM_MODEL, sendClaudeWarm } from '../src/claude-warm.js';
import { claudeProvider } from '../src/providers.js';
import { startOnAnyPorts, anyPorts } from './server-ports.js';
import { defaultConfig, saveConfig } from '../src/storage.js';
import type { RunningServer } from '../src/runtime.js';
import { Warmer } from '../src/warmer.js';

const wait = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function fakeClock(start: number) {
  type FakeTimer = { at: number; fn: () => void; unref(): void };
  let now = start;
  const timers = new Set<FakeTimer>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const t: FakeTimer = { at: now + ms, fn, unref() {} };
      timers.add(t);
      return t;
    },
    clearTimeout: (timer: { at?: number; fn?: () => void; unref?: () => void }) => {
      timers.delete(timer as FakeTimer);
    },
    async advance(ms: number) {
      const target = now + ms;
      while (true) {
        const due = [...timers].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        timers.delete(due);
        due.fn();
        await wait();
      }
      now = target;
      await wait();
    },
    pending: () => timers.size,
  };
}

function claudeAccount(id: string, usageRequestedAt: number) {
  const now = Date.now();
  return {
    id,
    label: `claude-${id}`,
    enabled: true,
    measuredAt: usageRequestedAt,
    usageRequestedAt,
    windows: {
      '5h': { usage: 0, resetsAt: now + 5 * 60 * 60_000 },
      '7d': { usage: 0.1, resetsAt: now + 3 * 86_400_000 },
    },
    cooldownUntil: null as number | null,
    error: null,
    warmFailures: 0,
    warmRetryAt: null,
    warmGaveUp: false,
    warmTransientFailure: null as string | null,
    warmConfirmAt: null as number | null,
    warmSignature: undefined as string | undefined,
  };
}

function fakeClaude(clock: { now(): number }, opens = true) {
  const SPAN = 5 * 60 * 60_000;
  let openedAt: number | null = null;
  const open = (): boolean => openedAt !== null && clock.now() < openedAt + SPAN;
  return {
    warm(): void { if (opens && !open()) openedAt = clock.now(); },
    read(a: ReturnType<typeof claudeAccount>): void {
      const now = clock.now();
      a.usageRequestedAt = now;
      a.measuredAt = now;
      a.windows!['5h'] = { usage: 0, resetsAt: open() ? openedAt! + SPAN : now + SPAN };
    },
  };
}

test('Claude provider normalizes pinned account path and extracts account', () => {
  assert.equal(claudeProvider.pinnedAccount?.('/tc-acct/test%40account/claude'), 'test@account');
  assert.equal(claudeProvider.pinnedAccount?.('/tc-acct/user-123/claude/v1/messages?beta=true'), 'user-123');
  assert.equal(claudeProvider.pinnedAccount?.('/v1/messages'), null);

  assert.equal(claudeProvider.normalizePath('/tc-acct/test%40account/claude'), '/v1/messages');
  assert.equal(claudeProvider.normalizePath('/tc-acct/test%40account/claude/v1/messages?beta=true'), '/v1/messages?beta=true');
  assert.equal(claudeProvider.normalizePath('/tc-acct/test%40account/claude/unsupported'), null);
});

test('buildClaudeWarmRequest creates minimal Haiku request to pinned path', () => {
  const req = buildClaudeWarmRequest(3456, 'my-acct', {
    token: 'test-token',
    probeTemplate: {
      path: '/v1/messages',
      query: '?beta=true',
      model: 'claude-sonnet-5',
      version: '2023-06-01',
      beta: 'oauth-2025-04-20',
      userAgent: 'claude-cli/2.1.260',
      system: [{ type: 'text', text: 'system prompt' }],
      elicitsModelWeekly: false,
    },
  });

  assert.equal(req.url, 'http://127.0.0.1:3456/tc-acct/my-acct/claude/v1/messages?beta=true');
  assert.equal(req.headers.authorization, 'Bearer test-token');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(req.headers['user-agent'], 'claude-cli/2.1.260');

  const body = JSON.parse(req.body);
  assert.equal(body.model, CLAUDE_WARM_MODEL);
  assert.equal(body.max_tokens, 1);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(body.system, [{ type: 'text', text: 'system prompt' }]);
});

test('sendClaudeWarm succeeds on 200, handles 500 transient, and 429 non-transient', async () => {
  const fakeFetchSuccess: typeof fetch = async () => new Response('{"ok":true}', { status: 200 });
  const successRes = await sendClaudeWarm({
    url: 'http://localhost/test',
    headers: {},
    body: '{}',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    fetchFn: fakeFetchSuccess,
  });
  assert.equal(successRes, 0);

  const fakeFetch500: typeof fetch = async () => new Response('Internal error', { status: 500 });
  const res500 = await sendClaudeWarm({
    url: 'http://localhost/test',
    headers: {},
    body: '{}',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    fetchFn: fakeFetch500,
  });
  assert.deepEqual(res500, { code: 500, transient: true, reason: 'HTTP 500: Internal error' });

  const fakeFetch429: typeof fetch = async () => new Response('Rate limited', { status: 429 });
  const res429 = await sendClaudeWarm({
    url: 'http://localhost/test',
    headers: {},
    body: '{}',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    fetchFn: fakeFetch429,
  });
  assert.deepEqual(res429, { code: 429, transient: false, reason: 'HTTP 429: Rate limited' });
});

test('Claude 계정 창 리셋 -> 0% 확인 -> 요청 1회', async () => {
  const now = Date.now();
  const clock = fakeClock(now);
  const a = claudeAccount('reset-test', now);
  a.windows!['5h'] = { usage: 0.25, resetsAt: now + 60 * 60_000 };
  a.usageRequestedAt = now;

  let refreshes = 0;
  let warms = 0;
  const requests: Array<{ account: string; spec: unknown }> = [];

  const warmer = new Warmer(
    { accounts: [a], provider: { id: 'claude' } },
    {
      providerId: 'claude',
      port: 3456,
      nowFn: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      refreshUsage: async () => {
        refreshes++;
        if (refreshes > 1) {
          a.windows!['5h'] = { usage: 0, resetsAt: clock.now() + 5 * 60 * 60_000 };
          a.usageRequestedAt = clock.now();
        }
      },
      warmFn: async (account, spec) => {
        warms++;
        requests.push({ account: account.id, spec });
        return 0;
      },
    },
  );

  warmer.start();
  await wait();
  assert.equal(warms, 0, 'no warm while window is still running');

  // Advance to reset + 9.999s: not yet reset + 10s
  await clock.advance(60 * 60_000 + 9_999);
  assert.equal(warms, 0);

  // Advance 1ms to hit reset + 10s: re-reads usage and confirms 0%
  await clock.advance(1);
  assert.equal(refreshes, 2);
  assert.equal(warms, 1, '1 warm sent after 0% confirmed');
  assert.equal(requests[0]!.account, 'reset-test');
  warmer.stop();
});

test('Claude 계정 창 리셋 -> 0% 가 아니면 요청 0회', async () => {
  const now = Date.now();
  const clock = fakeClock(now);
  const a = claudeAccount('nonzero-test', now);
  a.windows!['5h'] = { usage: 0.2, resetsAt: now + 60 * 60_000 };
  a.usageRequestedAt = now;

  let refreshes = 0;
  let warms = 0;

  const warmer = new Warmer(
    { accounts: [a], provider: { id: 'claude' } },
    {
      providerId: 'claude',
      port: 3456,
      nowFn: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      refreshUsage: async () => {
        refreshes++;
        if (refreshes > 1) {
          // Window has usage > 0 (e.g. 0.05), so it is not empty
          a.windows!['5h'] = { usage: 0.05, resetsAt: clock.now() + 5 * 60 * 60_000 };
          a.usageRequestedAt = clock.now();
        }
      },
      warmFn: async () => {
        warms++;
        return 0;
      },
    },
  );

  warmer.start();
  await wait();
  assert.equal(warms, 0);

  // Advance to reset + 10s
  await clock.advance(60 * 60_000 + 10_000);
  assert.equal(refreshes, 2);
  assert.equal(warms, 0, 'no warm sent because window usage is not 0%');
  warmer.stop();
});

test('Claude 계정 실패 -> 10분 뒤 1회 재시도 -> 포기', async () => {
  const start = Date.now();
  const clock = fakeClock(start);
  const a = claudeAccount('fail-retry', start + 100);
  let warms = 0;

  const warmer = new Warmer(
    { accounts: [a], provider: { id: 'claude' } },
    {
      providerId: 'claude',
      port: 3456,
      nowFn: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      warmFn: async () => {
        warms++;
        return 1; // fails
      },
    },
  );

  warmer.start();
  await wait();
  assert.equal(warms, 1, 'first warm attempted immediately for fresh idle account');
  assert.equal(a.warmFailures, 1);
  assert.equal(a.warmGaveUp, false);

  // Advance 9 mins (before 10-minute retry)
  await clock.advance(9 * 60_000);
  assert.equal(warms, 1);

  // Advance past 10 mins (retry timer fires)
  await clock.advance(1 * 60_000);
  assert.equal(warms, 2, 'second warm attempted 10 minutes later');
  assert.equal(a.warmFailures, 2);
  assert.equal(a.warmGaveUp, true, 'gave up after two permanent failures');

  // Advance 30 mins
  await clock.advance(30 * 60_000);
  assert.equal(warms, 2, 'no further warm attempts while gave-up');

  // Advance past 1 hour give-up expiry
  await clock.advance(30 * 60_000);
  assert.equal(warms, 3, 'retried after 1-hour give-up expiry');
  warmer.stop();
});

test('Claude 비활성 계정 및 쿨다운 계정 건너뜀', async () => {
  const now = Date.now();
  const disabled = claudeAccount('disabled', now + 100);
  disabled.enabled = false;

  const cooldown = claudeAccount('cooldown', now + 100);
  cooldown.cooldownUntil = now + 60 * 60_000;

  let warms = 0;
  const warmer = new Warmer(
    { accounts: [disabled, cooldown], provider: { id: 'claude' } },
    {
      providerId: 'claude',
      port: 3456,
      warmFn: async () => {
        warms++;
        return 0;
      },
    },
  );

  warmer.start();
  await wait();
  assert.equal(warms, 0, 'disabled and cooldown accounts are skipped');
  warmer.stop();
});

test('warmup.claude=false 면 Claude warmer 비활성화로 0회', async () => {
  const account = claudeAccount('off-test', Date.now() + 100);
  let warms = 0;

  // With enabled: false (as runtime sets when warmup.claude=false or warmup.enabled=false)
  const warmer = new Warmer(
    { accounts: [account], provider: { id: 'claude' } },
    {
      providerId: 'claude',
      enabled: false,
      port: 3456,
      warmFn: async () => {
        warms++;
        return 0;
      },
    },
  );

  warmer.start();
  await wait();
  assert.equal(warms, 0, 'no warm when warmer is disabled');
  warmer.stop();
});

test('두 풀(Claude, Codex)이 서로 간섭하지 않음', async () => {
  const now = Date.now();
  const clock = fakeClock(now);

  const claudeAcct = claudeAccount('claude-acct', now + 100);
  const codexAcct = {
    id: 'codex-acct',
    label: 'codex-acct',
    enabled: true,
    measuredAt: now + 100,
    usageRequestedAt: now + 100,
    windows: {
      primary: { usage: 0, resetsAt: now + 5 * 60 * 60_000 },
      secondary: { usage: 0.1, resetsAt: now + 7 * 86_400_000 },
    },
    cooldownUntil: null as number | null,
    error: null,
    warmFailures: 0,
    warmRetryAt: null,
    warmGaveUp: false,
    warmTransientFailure: null as string | null,
    warmConfirmAt: null as number | null,
  };

  const claudeWarms: string[] = [];
  const codexWarms: string[] = [];

  const claudeWarmer = new Warmer(
    { accounts: [claudeAcct], provider: { id: 'claude' } },
    {
      providerId: 'claude',
      port: 3456,
      nowFn: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      warmFn: async (a) => {
        claudeWarms.push(a.id);
        return 0;
      },
    },
  );

  const codexWarmer = new Warmer(
    { accounts: [codexAcct], provider: { id: 'codex' } },
    {
      providerId: 'codex',
      port: 3457,
      nowFn: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      warmFn: async (a) => {
        codexWarms.push(a.id);
        return 0;
      },
    },
  );

  claudeWarmer.start();
  codexWarmer.start();
  await wait();

  assert.equal(claudeWarms.length, 1);
  assert.equal(claudeWarms[0], 'claude-acct');
  assert.equal(codexWarms.length, 1);
  assert.equal(codexWarms[0], 'codex-acct');

  claudeWarmer.stop();
  codexWarmer.stop();
});

test('Claude keep-warm traces provider name and account index', async () => {
  const start = Date.now();
  const clock = fakeClock(start);
  const claude = fakeClaude(clock);
  const a = claudeAccount('trace-test', start - 60_000);
  const lines: string[] = [];

  const warmer = new Warmer(
    { accounts: [a], provider: { id: 'claude' } },
    {
      providerId: 'claude',
      port: 3456,
      nowFn: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      trace: (line) => lines.push(line),
      refreshUsage: async (x) => {
        claude.read(x as typeof a);
        warmer.onAccountChanged(x);
      },
      warmFn: async () => {
        claude.warm();
        return 0;
      },
    },
  );

  warmer.start();
  await wait();
  assert.ok(lines.some((line) => line.startsWith('claude #1: awaiting-usage') || line.startsWith('claude #1: warm sent')));
  assert.ok(lines.some((line) => line === 'claude #1: warm ok'));
  assert.ok(lines.every((line) => !line.includes('trace-test')), 'no account id or label leaked');
  warmer.stop();
});

test('startServer with background enabled attaches Claude warmer and warms fresh idle Claude account', async () => {
  const messagesReceived: Array<{ url: string; headers: unknown; body: Record<string, unknown> }> = [];
  const up = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/oauth/usage') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          limits: [
            { kind: 'session', percent: 0, resets_at: new Date(Date.now() + 5 * 3_600_000).toISOString() },
            { kind: 'weekly_all', percent: 10, resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString() },
          ],
        }));
        return;
      }
      if (req.url === '/api/oauth/profile') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ account: { has_claude_max: true }, organization: { subscription_status: 'active' } }));
        return;
      }
      if (req.url?.startsWith('/v1/messages')) {
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { parsed = {}; }
        messagesReceived.push({ url: req.url, headers: req.headers, body: parsed });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const upAddr = up.address();
  assert(upAddr && typeof upAddr !== 'string');

  const root = await mkdtemp(join(tmpdir(), 'teamai-claude-warm-'));
  const prevHome = process.env.TEAMAI_HOME;
  process.env.TEAMAI_HOME = root;
  const origClaudeBase = claudeProvider.upstreamBase;
  claudeProvider.upstreamBase = `http://127.0.0.1:${upAddr.port}`;

  let server: RunningServer | undefined;
  try {
    const config = defaultConfig();
    config.proxy = { ...config.proxy, ...anyPorts, clientToken: 'test-token' };
    config.warmup = { enabled: true, claude: true, codex: false };
    config.accounts = [
      { id: 'claude-1', provider: 'claude', label: 'claude-1', enabled: true, priority: null, credentialId: 'claude:claude-1', createdAt: '2026-01-01T00:00:00Z' },
    ];
    await saveConfig(config);
    await writeFile(
      join(root, 'credentials.json'),
      JSON.stringify({
        'claude:claude-1': { accessToken: 'tok-1', refreshToken: 'ref-1', expiresAt: Date.now() + 86_400_000, accountId: 'uuid-1' },
      }),
    );
    await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, accounts: {}, events: [] }));

    server = await startOnAnyPorts(config, { background: true });

    // Wait for the Claude warm message to arrive
    for (let i = 0; i < 50 && messagesReceived.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(messagesReceived.length, 1);
    assert.equal(messagesReceived[0]!.body.model, CLAUDE_WARM_MODEL);
    assert.equal(messagesReceived[0]!.body.max_tokens, 1);
    assert.deepEqual(messagesReceived[0]!.body.messages, [{ role: 'user', content: 'hi' }]);
  } finally {
    await server?.stop();
    claudeProvider.upstreamBase = origClaudeBase;
    process.env.TEAMAI_HOME = prevHome;
    up.close();
  }
});

test('startServer with warmup.claude=false does not attach Claude warmer', async () => {
  const messagesReceived: Array<{ url: string }> = [];
  const up = createServer((req, res) => {
    req.resume();
    if (req.url === '/api/oauth/usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        limits: [
          { kind: 'session', percent: 0, resets_at: new Date(Date.now() + 5 * 3_600_000).toISOString() },
        ],
      }));
      return;
    }
    if (req.url === '/api/oauth/profile') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ account: { has_claude_max: true }, organization: { subscription_status: 'active' } }));
      return;
    }
    if (req.url?.startsWith('/v1/messages')) {
      messagesReceived.push({ url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const upAddr = up.address();
  assert(upAddr && typeof upAddr !== 'string');

  const root = await mkdtemp(join(tmpdir(), 'teamai-claude-nowarm-'));
  const prevHome = process.env.TEAMAI_HOME;
  process.env.TEAMAI_HOME = root;
  const origClaudeBase = claudeProvider.upstreamBase;
  claudeProvider.upstreamBase = `http://127.0.0.1:${upAddr.port}`;

  let server: RunningServer | undefined;
  try {
    const config = defaultConfig();
    config.proxy = { ...config.proxy, ...anyPorts, clientToken: 'test-token' };
    config.warmup = { enabled: true, claude: false };
    config.accounts = [
      { id: 'claude-1', provider: 'claude', label: 'claude-1', enabled: true, priority: null, credentialId: 'claude:claude-1', createdAt: '2026-01-01T00:00:00Z' },
    ];
    await saveConfig(config);
    await writeFile(
      join(root, 'credentials.json'),
      JSON.stringify({
        'claude:claude-1': { accessToken: 'tok-1', refreshToken: 'ref-1', expiresAt: Date.now() + 86_400_000, accountId: 'uuid-1' },
      }),
    );
    await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, accounts: {}, events: [] }));

    server = await startOnAnyPorts(config, { background: true });

    // Wait a bit to ensure no message is sent
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(messagesReceived.length, 0, 'no Claude warm sent when warmup.claude=false');
  } finally {
    await server?.stop();
    claudeProvider.upstreamBase = origClaudeBase;
    process.env.TEAMAI_HOME = prevHome;
    up.close();
  }
});
