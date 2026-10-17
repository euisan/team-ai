import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { stripAnsi } from '../src/columns.js';
import { buildFrame, type CreditPicker, type FrameMode, type FrameView } from '../src/frame.js';
import { openRouteEditor, routeEditorKey, type RouteEditor } from '../src/route-editor.js';
import type { PersistedState, StoredAccount, TeamAIConfig } from '../src/types.js';

// Everything the dashboard draws writes a week as "7d" and nothing else: no
// "limit" after a window's length, no "1w", "wk", "week(ly)" or "overall".
// Synthetic data only: no real account, address or token.
const WEEK_WORDS = /\b(1w|wk|weeks?|weekly|overall)\b/i;
const LIMIT_TITLES = /\b7d limit\b|\b5h limit\b/i;
const WIDTHS = [40, 60, 80, 120, 200];

const now = Date.now(); const h = 3_600_000; const d = 24 * h;
const account = (provider: 'claude' | 'codex', label: string, enabled = true): StoredAccount => ({ id: label, provider, label, enabled, priority: null, credentialId: `cred-${label}`, createdAt: '2026-01-01T00:00:00Z' });
const routes = {
  claude: [{ name: 'fable', match: ['fable'], accounts: ['max@example.com'], mode: 'exclusive' as const, color: 'magenta' as const }],
  codex: [{ name: 'pro', match: 'gpt-5.5-pro', accounts: ['pro@example.com', 1], mode: 'prefer' as const }],
};
const config: TeamAIConfig = {
  version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'synthetic' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3,
  accounts: [account('claude', 'max@example.com'), account('claude', 'pro-claude@example.com'), account('claude', 'off@example.com', false), account('codex', 'plus@example.com'), account('codex', 'pro@example.com'), account('codex', 'lite@example.com')],
  routes,
};
const measured = { cooldownUntil: null, lastUsed: null, error: null, measuredAt: now - 4 * 60_000 };
const windows = (spec: Array<[string, number | null, number]>) => spec.map(([label, minutes, usedPercent]) => ({ label, minutes, usedPercent, resetsAt: now + 3 * d }));
const external = (provider: string, groups: Array<{ name: string; windows: ReturnType<typeof windows> }>) => ({ provider, status: 'ok', identity: null, measuredAt: now - 60_000, lastOkAt: now - 60_000, note: null, groups });
const request = (at: number, provider: 'claude' | 'codex', status: number, acct: string, route?: string) => ({ at, message: '', request: { provider, providerLabel: provider === 'claude' ? 'Claude' : 'Codex', method: 'POST', path: provider === 'claude' ? '/v1/messages?beta=true' : '/v1/responses', account: acct, status, durationMs: 4200, model: provider === 'claude' ? 'claude-fable-5-1' : 'gpt-5.5', effort: 'high', sessionId: 'ac88d9e1', ...(route ? { route } : {}) } });
// The activity log's own sentences, as the proxy, the pool and the runtime
// word them: the limits, the resets and a spent Fable budget among them.
const log = [
  'Codex POST /v1/responses → plus@example.com 429 quota; failover',
  'Claude POST /v1/messages?beta=true → max@example.com 429 model-quota body: {"type":"error","error":{"type":"rate_limit_error"}}',
  'Claude POST /v1/messages?beta=true → max@example.com 429 fable-quota; failover',
  `Claude POST /v1/messages?beta=true → 429 quota_exhausted (fable), next reset ${AccountPool.formatDuration(3 * d + 2 * h)}`,
  `Codex POST /v1/responses → 429 quota_exhausted, next reset ${AccountPool.formatDuration(5 * h)}`,
  'Claude POST /v1/messages?beta=true → 429 concurrency_saturated, next reset 1m',
  'Codex reset credit redeemed on "lite@example.com" (429-exhausted): windows_reset=1, credits left=1',
  'Codex reset credit: no eligible account at the quota dead end (plus@example.com:not-exhausted, pro@example.com:no-credits)',
  'Warm-up measured 4 account(s) after 2 window reset(s)',
  '3 quota window(s) reset',
  'Quota re-measure: 5/6 account(s)',
  'Claude route fable: no route account available → pro-claude@example.com',
];
const state = {
  version: 1,
  accounts: {
    // Claude Max with the Fable week, one with Fable spent and cooling down, one disabled.
    'cred-max@example.com': { ...measured, usage: 0.62, resetsAt: null, profile: { hasClaudeMax: true, rateLimitTier: 'default_claude_max_20x', status: 'active', createdAt: '2026-01-29T00:00:00Z' }, windows: { '5h': { usage: 0.62, resetsAt: now + 2 * h }, '7d': { usage: 0.84, resetsAt: now + 3 * d }, '7d_oi': { usage: 1, resetsAt: now + 3 * d } } },
    'cred-pro-claude@example.com': { ...measured, usage: 0.3, resetsAt: null, cooldownUntil: now + h, profile: { hasClaudePro: true, status: 'active', createdAt: '2026-02-10T00:00:00Z' }, windows: { '5h': { usage: 0.3, resetsAt: now + h }, '7d': { usage: 0.5, resetsAt: now + 5 * d } } },
    'cred-off@example.com': { ...measured, usage: null, resetsAt: null, windows: {} },
    // Codex Plus with 5h and 7d, Pro with 5h and 7d, Pro Lite with a single 7d.
    'cred-plus@example.com': { ...measured, usage: 1, resetsAt: null, resetCredits: 0, profile: { rateLimitTier: 'plus' }, windows: { primary: { usage: 1, resetsAt: now + 2 * h, minutes: 300 }, secondary: { usage: 0.75, resetsAt: now + 4 * d, minutes: 10080 } } },
    'cred-pro@example.com': { ...measured, usage: 0.2, resetsAt: null, resetCredits: 3, profile: { rateLimitTier: 'pro' }, windows: { primary: { usage: 0.2, resetsAt: now + 3 * h, minutes: 300 }, secondary: { usage: 0.4, resetsAt: now + 6 * d, minutes: 10080 } } },
    'cred-lite@example.com': { ...measured, usage: 0.1, resetsAt: null, resetCredits: 1, profile: { rateLimitTier: 'prolite' }, windows: { primary: { usage: 0.1, resetsAt: now + 6 * d, minutes: 10080 } } },
  },
  next: { claude: { general: 'cred-pro-claude@example.com', fable: 'cred-max@example.com', routes: { fable: 'cred-max@example.com' } }, codex: { general: 'cred-pro@example.com', routes: { pro: 'cred-pro@example.com' } } },
  routes: [
    { provider: 'claude', name: 'fable', color: 'magenta', mode: 'exclusive', members: [{ credentialId: 'cred-max@example.com', usable: true }] },
    { provider: 'codex', name: 'pro', color: null, mode: 'prefer', members: [{ credentialId: 'cred-pro@example.com', usable: true }, { credentialId: 'cred-lite@example.com', usable: false }] },
  ],
  external: {
    // Lengths reported, and the stored labels with none ('wk', Orca's 'weekly' and 'monthly').
    antigravity: external('antigravity', [{ name: 'Gemini 3 Pro', windows: windows([['5h', 300, 20], ['wk', 10080, 55]]) }]),
    opencodeGo: external('opencodeGo', [{ name: 'OpenCode Go', windows: windows([['5h', 300, 5], ['wk', null, 33], ['monthly', null, 71]]) }]),
    grok: external('grok', [{ name: 'Grok', windows: windows([['weekly', null, 25], ['30d', 43200, 10]]) }]),
  },
  active: [{ id: 'r1', provider: 'claude', providerLabel: 'Claude', method: 'POST', path: '/v1/messages?beta=true', account: 'max@example.com', startedAt: now - 3000, model: 'claude-fable-5-1', effort: 'high', sessionId: 'ac88d9e1', route: 'fable' }],
  events: [
    request(now - 300_000, 'codex', 429, 'plus@example.com'),
    request(now - 240_000, 'claude', 200, 'max@example.com', 'fable'),
    ...log.map((message, i) => ({ at: now - 200_000 + i * 1000, message })),
  ],
} as unknown as PersistedState;

const picker = (phase: CreditPicker['phase'], result?: string): CreditPicker => ({ account: 'pro@example.com', phase, index: 0, ...(result ? { result } : {}), items: [{ title: 'Codex usage reset', grantedAt: now - 2 * d, expiresAt: now + 20 * d }, { title: null, grantedAt: null, expiresAt: null }] });
const press = (editor: RouteEditor, ...keys: string[]): RouteEditor => keys.reduce((e, key) => routeEditorKey(e, key).editor, editor);
const claudeRoutes = openRouteEditor(config, 'claude', 'fable', 'Saved route fable');
const codexRoutes = openRouteEditor(config, 'codex');
// Every screen the dashboard can be on, with whatever it overlays.
const screens: Array<[string, FrameMode, Partial<FrameView>]> = [
  ['normal', 'normal', {}],
  ['normal (Codex row)', 'normal', { selectedId: 'cred-pro@example.com' }],
  ['normal (headroom sort)', 'normal', { sortByHeadroom: true, message: 'Sorted by remaining quota' }],
  ['help', 'help', {}],
  ['help (Codex row)', 'help', { selectedId: 'cred-lite@example.com' }],
  ['order', 'order', {}],
  ['delete', 'delete', {}],
  ['add', 'add', {}],
  ...(['loading', 'pick', 'confirm', 'applying'] as const).map((phase): [string, FrameMode, Partial<FrameView>] => [`credits ${phase}`, 'credits', { selectedId: 'cred-pro@example.com', credits: picker(phase) }]),
  ['credits done', 'credits', { selectedId: 'cred-pro@example.com', credits: picker('done', 'reset (credits left 2)') }],
  ['credits empty', 'credits', { selectedId: 'cred-plus@example.com', credits: { ...picker('pick'), items: [] } }],
  ['routes list', 'routes', { routes: claudeRoutes }],
  ['routes Codex', 'routes', { routes: codexRoutes }],
  ['routes edit', 'routes', { routes: press(claudeRoutes, 'e') }],
  ['routes edit accounts', 'routes', { routes: press(codexRoutes, 'e', '\r', '\r') }],
  ['routes add', 'routes', { routes: press(codexRoutes, 'a', 'x') }],
  ['routes delete', 'routes', { routes: press(codexRoutes, 'd') }],
];

const render = (width: number, height: number | undefined, mode: FrameMode, extra: Partial<FrameView>): string[] =>
  buildFrame(config, state, { width, height, selectedId: 'cred-max@example.com', mode, message: '', sortByHeadroom: false, host: null, ...extra }).map(stripAnsi);

test('every dashboard screen writes a week as 7d at 40, 60, 80, 120 and 200 columns', () => {
  let checked = 0;
  for (const width of WIDTHS) {
    // A live screen (height 200 shows the whole activity log) and a capture (no height).
    for (const height of [200, 40, undefined]) {
      for (const [name, mode, extra] of screens) {
        const lines = render(width, height, mode, extra);
        assert.ok(lines.length > 0, `${name} @${width}: drew something`);
        for (const line of lines) {
          assert.doesNotMatch(line, WEEK_WORDS, `${name} @${width}x${height}: ${JSON.stringify(line)}`);
          assert.doesNotMatch(line, LIMIT_TITLES, `${name} @${width}x${height}: ${JSON.stringify(line)}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 10_000, `${checked} lines checked`);
});

test('the fixture reaches the parts the patterns are about', () => {
  for (const width of WIDTHS) {
    const text = render(width, 200, 'normal', {}).join('\n');
    // A week is still on screen, only as 7d; every log sentence is drawn
    // (cut at the right edge, so the whole of it from 120 columns on).
    assert.match(text, /\b7d\b/, `@${width}`);
    for (const message of log) assert.ok(text.includes(message.slice(0, Math.max(8, width - 14))), `@${width}: ${message}`);
  }
  const wide = render(200, 200, 'normal', {});
  const titles = (box: string): string => wide[wide.findIndex((line) => line.includes(`─ ${box}`)) + 1]!;
  assert.match(titles('Codex accounts'), /\b5h\b.*\b7d\b/);
  assert.match(titles('Claude accounts'), /5h session.*\b7d\b.*7d Fable/);
  for (const box of ['Antigravity (agy)', 'OpenCode Go', 'Grok']) assert.match(titles(box), /\b7d\b/, box);
  assert.match(titles('Grok'), /\b30d\b/);
});

test('a Codex box whose accounts have only a 7d window titles that gauge 7d', () => {
  const only = { ...config, accounts: config.accounts.filter((a) => a.provider === 'claude' || a.label === 'lite@example.com') };
  for (const width of [80, 120, 200]) {
    const lines = buildFrame(only, state, { width, selectedId: null, mode: 'normal', message: '', sortByHeadroom: false }).map(stripAnsi);
    const header = lines[lines.findIndex((line) => line.includes('Codex accounts')) + 1]!;
    assert.match(header, /\b7d\b/, `@${width}`); assert.doesNotMatch(header, /\b5h\b|limit/, `@${width}`);
  }
});
