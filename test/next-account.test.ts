import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { buildFrame } from '../src/frame.js';
import { parseRoutes, type Route } from '../src/routes.js';
import type { OAuthCredential, PersistedState, Provider, StoredAccount, TeamAIConfig } from '../src/types.js';

function pool(n: number, provider: 'claude' | 'codex' = 'claude', maxConcurrent = 2) {
  const p: Provider = { id: provider, label: provider === 'claude' ? 'Claude' : 'Codex', upstreamBase: 'http://127.0.0.1:1', normalizePath: () => '/x', rewriteBody: (b) => b, readQuota: () => null, refresh: async (c) => c, buildHeaders: (h) => h, classifyFailure: () => ({ kind: 'fatal', retryAfterMs: 0 }), ...(provider === 'claude' ? { fableModel: 'claude-fable-5-1' } : {}) };
  const ids = Array.from({ length: n }, (_, i) => `a${i}`);
  const stored = ids.map((id): StoredAccount => ({ id, provider, label: `${id}@example.com`, enabled: true, priority: null, credentialId: `cred-${id}`, createdAt: '' }));
  const credentials: Record<string, OAuthCredential> = Object.fromEntries(ids.map((id) => [`cred-${id}`, { accessToken: 's', refreshToken: null, expiresAt: null, accountId: id }]));
  return new AccountPool(p, stored, credentials, { version: 1, accounts: {} }, 0.98, maxConcurrent, 0.8);
}

// A small deterministic generator, so a failure names a reproducible seed.
function rng(seed: number): () => number { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x1_0000_0000; }; }

function scramble(p: AccountPool, random: () => number): void {
  const now = Date.now(); const pickUsage = () => { const r = random(); return r < 0.15 ? null : r < 0.25 ? 1 : r < 0.35 ? 0.99 : Math.round(random() * 100) / 100; };
  for (const a of p.accounts) {
    a.usage = pickUsage(); a.resetsAt = random() < 0.1 ? now - 1_000 : now + 3_600_000;
    a.windows = {};
    if (random() < 0.8) a.windows['7d_oi'] = { usage: pickUsage(), resetsAt: now + 86_400_000 };
    if (random() < 0.8) a.windows['7d'] = { usage: pickUsage(), resetsAt: now + 86_400_000 };
    if (random() < 0.6) a.windows['5h'] = { usage: pickUsage(), resetsAt: now + 3_600_000 };
    a.priority = random() < 0.2 ? Math.floor(random() * 3) + 1 : null;
    a.enabled = random() > 0.1; a.error = random() < 0.05 ? 'x' : null;
    a.cooldownUntil = random() < 0.15 ? now + 60_000 : null; a.cooldownReason = a.cooldownUntil ? 'quota' : null;
    a.inflight = Math.floor(random() * 3);
  }
}

test('the preview picks exactly what acquire picks for a new request, across many states', () => {
  let compared = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const random = rng(seed); const p = pool(2 + Math.floor(random() * 5));
    const routes = parseRoutes([{ name: 'r', match: ['*'], accounts: [0, 2], mode: random() < 0.5 ? 'prefer' : 'exclusive' }], 'claude');
    for (const route of [null, routes[0]!] as Array<Route | null>) {
      for (const wantsFable of [false, true]) {
        scramble(p, rng(seed * 7 + (wantsFable ? 1 : 0) + (route ? 2 : 0)));
        const previewed = p.preview(wantsFable, route)?.id ?? null;
        const acquired = p.acquire(`fresh-${seed}-${wantsFable}-${route?.name}`, new Set(), wantsFable, route);
        assert.equal(previewed, acquired?.id ?? null, `seed ${seed}, fable ${wantsFable}, route ${route?.mode ?? 'none'}`);
        if (acquired) p.release(acquired);
        compared++;
      }
    }
  }
  assert.equal(compared, 1600);
});

test('previewing changes nothing: no slot, no pin, no cleared window', () => {
  const p = pool(3); const a = p.accounts[0]!;
  a.usage = 1; a.resetsAt = Date.now() - 1_000; a.cooldownUntil = Date.now() + 60_000; a.cooldownReason = 'quota';
  const before = JSON.stringify(p.accounts);
  for (let i = 0; i < 100; i++) { p.preview(false); p.preview(true); p.nextTargets(); }
  assert.equal(JSON.stringify(p.accounts), before);
  assert.equal(p.pinnedSessions, 0);
  assert.equal(p.preview(false)?.id, 'a0', 'the rolled-over account reads as fresh, without being cleared');
});

test('Fable and general targets can differ; nothing to point at gives null', () => {
  const p = pool(2); const [x, y] = p.accounts as [ReturnType<typeof pool>['accounts'][number], ReturnType<typeof pool>['accounts'][number]];
  x.windows = { '7d_oi': { usage: 0.2, resetsAt: null }, '7d': { usage: 0.4, resetsAt: null } };
  y.windows = { '7d_oi': { usage: 0.9, resetsAt: null }, '7d': { usage: 0.3, resetsAt: null } };
  assert.deepEqual(p.nextTargets(), { general: 'cred-a1', fable: 'cred-a0' });
  for (const a of p.accounts) p.cooldown(a, 60_000);
  assert.deepEqual(p.nextTargets(), { general: null, fable: null });
  const full = pool(1, 'codex', 1); full.accounts[0]!.inflight = 1;
  assert.equal(full.preview(false), null, 'at its concurrency cap: the next request would get a 429');
  const routed = pool(2, 'codex'); routed.setRoutes(parseRoutes([{ name: 'r', match: ['*'], accounts: [1] }], 'codex'));
  assert.deepEqual(routed.nextTargets(), { general: 'cred-a0', routes: { r: 'cred-a1' } });
});

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (line: string): string => line.replace(ANSI, '');

test('the dashboard puts the arrows where state.next says, and nowhere without it', () => {
  const accounts = ['x', 'y'].map((id): StoredAccount => ({ id, provider: 'claude', label: `${id}@example.com`, enabled: true, priority: null, credentialId: `cred-${id}`, createdAt: '' }));
  const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 't' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts };
  const view = { width: 120, selectedId: null, mode: 'normal' as const, message: '', sortByHeadroom: false };
  const state: PersistedState = { version: 1, accounts: {}, next: { claude: { general: 'cred-y', fable: 'cred-x' } } };
  const lines = buildFrame(config, state, view).map(plain);
  const row = (label: string) => lines.find((l) => l.includes(label))!;
  assert.match(row('y@example.com'), /^ ► y@example\.com/);
  assert.match(row('x@example.com'), /^ {3}x@example\.com/);
  assert.equal((row('x@example.com').match(/►/g) ?? []).length, 1, 'x carries only the Fable arrow');
  assert.ok(/[^ ]►[^ ]|►/.test(row('x@example.com')));
  assert.ok(lines.every((l) => [...l].length <= 120));
  const bare = buildFrame(config, { version: 1, accounts: {} }, view).map(plain);
  assert.equal(bare.some((l) => l.includes('►')), false);
});

test('a stopped server shows no arrows', async () => {
  const { liveState } = await import('../src/runtime.js');
  const { mkdtemp } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  process.env.TEAMAI_HOME = await mkdtemp(join(tmpdir(), 'teamai-next-'));
  try { assert.equal((await liveState({ version: 1, accounts: {}, next: { codex: { general: 'a' } }, serverPid: process.pid })).next, undefined); } finally { delete process.env.TEAMAI_HOME; }
});
