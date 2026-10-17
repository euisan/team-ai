// Synthetic dashboard data for the narrow-screen tests and for the before /
// after renders in the pull request: no real account, address or token.
import type { PersistedState, StoredAccount, TeamAIConfig } from '../src/types.js';

export const now = Date.now(); const h = 3_600_000; const d = 24 * h;
const account = (provider: 'claude' | 'codex', label: string, enabled = true): StoredAccount => ({ id: label, provider, label, enabled, priority: null, credentialId: `cred-${label}`, createdAt: '2026-01-01T00:00:00Z' });
export const config: TeamAIConfig = {
  version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'synthetic' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3,
  accounts: [account('claude', 'alice.long.address@example.com'), account('claude', '김철수.아주긴주소@example.com'), account('claude', 'off@example.com', false), account('codex', 'carol@example.com'), account('codex', 'd1fp9a@example.com')],
};
const measured = { cooldownUntil: null, lastUsed: null, error: null, measuredAt: now - 4 * 60_000 };
const group = (name: string, windows: Array<[string, number | null, number]>) => ({ name, windows: windows.map(([label, minutes, usedPercent]) => ({ label, minutes, usedPercent, resetsAt: now + 3 * d + 8 * h })) });
const external = (provider: string, identity: string | null, groups: unknown[]) => ({ provider, status: 'ok', identity, measuredAt: now - 60_000, lastOkAt: now - 60_000, note: null, groups });
const request = (at: number, provider: 'claude' | 'codex', status: number | string, sessionId: string, acct: string) => ({ at, message: '', request: { provider, providerLabel: provider === 'claude' ? 'Claude' : 'Codex', method: 'POST', path: provider === 'claude' ? '/v1/messages?beta=true' : '/v1/responses', account: acct, status, durationMs: 4200, model: provider === 'claude' ? 'claude-opus-5-5' : 'gpt-5.5', effort: 'medium', sessionId } });
export const state = {
  version: 1,
  accounts: {
    'cred-alice.long.address@example.com': { ...measured, usage: 0.62, resetsAt: null, profile: { hasClaudeMax: true, status: 'active', createdAt: '2026-01-29T00:00:00Z' }, windows: { '5h': { usage: 0.62, resetsAt: now + 2 * h + 10 * 60_000 }, '7d': { usage: 0.84, resetsAt: now + 3 * d }, '7d_oi': { usage: 0.35, resetsAt: now + 3 * d } } },
    'cred-김철수.아주긴주소@example.com': { ...measured, usage: 0.93, resetsAt: null, windows: { '5h': { usage: 0.93, resetsAt: now + h }, '7d': { usage: 0.2, resetsAt: now + 5 * d }, '7d_oi': { usage: 0.1, resetsAt: now + 5 * d } } },
    'cred-carol@example.com': { ...measured, usage: 0.3, resetsAt: null, resetCredits: 2, windows: { primary: { usage: 0.3, resetsAt: now + 2 * h, minutes: 300 }, secondary: { usage: 0.75, resetsAt: now + 4 * d, minutes: 10080 } } },
    'cred-d1fp9a@example.com': { ...measured, usage: 0.1, resetsAt: null, windows: { primary: { usage: 0.1, resetsAt: now + 6 * d, minutes: 10080 } } },
  },
  next: { claude: { general: 'cred-alice.long.address@example.com', fable: 'cred-김철수.아주긴주소@example.com' }, codex: { general: 'cred-d1fp9a@example.com' } },
  external: {
    antigravity: external('antigravity', null, [group('Gemini 3 Pro', [['5h', 300, 20], ['wk', 10080, 55]]), group('제미니 한글 모델 그룹', [['5h', 300, 80], ['wk', 10080, 40]])]),
    opencodeGo: external('opencodeGo', 'env', [group('OpenCode Go', [['5h', 300, 5], ['wk', 10080, 33], ['30d', 43200, 71]])]),
    grok: external('grok', 'SuperGrok ev•••@ex•••.com', [group('Grok', [['wk', 10080, 25]])]),
  },
  active: [{ id: 'r1', provider: 'claude', providerLabel: 'Claude', method: 'POST', path: '/v1/messages?beta=true', account: 'alice.long.address@example.com', startedAt: now - 3000, model: 'claude-opus-5-5', effort: 'medium', sessionId: 'ac88d9e1' }],
  events: [
    request(now - 120_000, 'codex', 429, 'b71c02aa', 'carol@example.com'),
    { at: now - 90_000, message: 'Codex carol@example.com 429 quota; failover to d1fp9a@example.com' },
    request(now - 60_000, 'codex', 200, 'b71c02aa', 'd1fp9a@example.com'),
    request(now - 1000, 'claude', 200, 'ac88d9e1', 'alice.long.address@example.com'),
  ],
} as unknown as PersistedState;
