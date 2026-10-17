// Usage of other coding agents installed on this machine — Antigravity (agy),
// OpenCode Go and Grok — shown on the dashboard next to the relayed accounts.
// Display only: none of them is relayed, and nothing here touches the proxy.
//
// Their credentials belong to those apps. They are read, used in memory for
// one request, and never written anywhere: not to state.json, not to a log,
// not into an error message, not onto a child process's command line. Grok's
// sign-in is never refreshed. All three sources are undocumented, so an answer
// of an unexpected shape becomes an 'error' row rather than a guess.
import { execFile as execFileCallback } from 'node:child_process';
import { readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { maskLabel } from './redact.js';
import type { TeamAIConfig } from './types.js';

export type ExternalProvider = 'antigravity' | 'opencodeGo' | 'grok';
export const EXTERNAL_PROVIDERS: readonly ExternalProvider[] = ['antigravity', 'opencodeGo', 'grok'];

export interface ExternalWindow { label: string; minutes: number | null; usedPercent: number | null; resetsAt: number | null }
export interface ExternalUsage {
  provider: ExternalProvider;
  status: 'ok' | 'unavailable' | 'signed-out' | 'expired' | 'error';
  // Who it is, when the source says and only as much as is safe to show: a
  // credential's origin, or a plan and a masked address. Never a key.
  identity: string | null;
  groups: Array<{ name: string; windows: ExternalWindow[] }>;
  note: string | null;
  measuredAt: number | null;
  lastOkAt: number | null;
}

export interface ExternalUsageSettings { enabled: boolean; providers: Record<ExternalProvider, boolean>; refreshMs: number; source: 'direct' | 'orca' }

export function externalUsageSettings(config: Partial<TeamAIConfig>): ExternalUsageSettings {
  const raw = config.externalUsage ?? {};
  const refresh = raw.refreshMs;
  return {
    enabled: raw.enabled !== false,
    providers: { antigravity: raw.providers?.antigravity !== false, opencodeGo: raw.providers?.opencodeGo !== false, grok: raw.providers?.grok !== false },
    refreshMs: typeof refresh === 'number' && Number.isFinite(refresh) ? Math.max(30_000, refresh) : 15 * 60_000,
    source: raw.source === 'orca' ? 'orca' : 'direct',
  };
}

const MINUTES: Record<string, number> = { '5h': 300, wk: 10_080, '30d': 43_200, '1h': 60 };
const percent = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
function instant(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && value) { const at = Date.parse(value); return Number.isFinite(at) ? at : null; }
  return null;
}
const field = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), value);

// `agy -p "/usage"` prints tab-separated rows: group, label, remaining %,
// reset time. Rows are grouped by name (the order they first appear) and the
// remaining share is turned into used. Anything not shaped like that is
// skipped.
export function parseAgyUsage(output: string): ExternalUsage['groups'] {
  const groups = new Map<string, ExternalWindow[]>();
  for (const line of output.split(/\r?\n/)) {
    const cols = line.split('\t'); if (cols.length !== 4) continue;
    const [group, label, remaining, reset] = cols.map((c) => c.trim()) as [string, string, string, string];
    const match = /^(\d+(?:\.\d+)?)%$/.exec(remaining); if (!group || !match) continue;
    const short = /five hour/i.test(label) ? '5h' : /weekly/i.test(label) ? 'wk' : label;
    const used = 100 - Math.round(Math.min(100, Number(match[1])));
    const list = groups.get(group) ?? []; groups.set(group, list);
    list.push({ label: short, minutes: MINUTES[short] ?? null, usedPercent: used, resetsAt: instant(reset) });
  }
  const order = (w: ExternalWindow) => ['5h', 'wk'].indexOf(w.label) + 1 || 9;
  return [...groups].map(([name, windows]) => ({ name, windows: windows.sort((a, b) => order(a) - order(b)) }));
}

// OpenCode Go's usage: rolling (5h), weekly and monthly windows, each with a
// used percentage and a reset time.
export function parseOpencodeUsage(data: unknown): ExternalUsage['groups'] {
  const usage = field(data, 'usage');
  if (!usage || typeof usage !== 'object') throw new Error('unexpected response');
  const windows = ([['rolling', '5h'], ['weekly', 'wk'], ['monthly', '30d']] as const).flatMap(([key, label]) => {
    const window = field(usage, key); if (!window || typeof window !== 'object') return [];
    return [{ label, minutes: MINUTES[label]!, usedPercent: percent(field(window, 'percent')), resetsAt: instant(field(window, 'resetsAt')) }];
  });
  if (!windows.length) throw new Error('unexpected response');
  return [{ name: 'OpenCode Go', windows }];
}

// Grok's billing: the weekly credit share and the monthly spend against its
// limit. The credits format nests these under `config`; the older one does
// not, so both places are looked in.
export function parseGrokBilling(data: unknown): { groups: ExternalUsage['groups']; tier: string | null } {
  const pick = (...path: string[]): unknown => field(data, ...path) ?? field(data, 'config', ...path);
  const windows: ExternalWindow[] = [];
  const weekly = percent(pick('creditUsagePercent'));
  if (weekly !== null) windows.push({ label: 'wk', minutes: MINUTES.wk!, usedPercent: weekly, resetsAt: instant(pick('currentPeriod', 'end')) ?? instant(pick('billingPeriodEnd')) });
  const used = pick('used', 'val'); const limit = pick('monthlyLimit', 'val');
  if (typeof used === 'number' && typeof limit === 'number' && limit > 0) windows.push({ label: '30d', minutes: MINUTES['30d']!, usedPercent: percent((used / limit) * 100), resetsAt: instant(pick('billingPeriodEnd')) });
  if (!windows.length) throw new Error('unexpected response');
  const tier = pick('subscriptionTier');
  return { groups: [{ name: 'Grok', windows }], tier: typeof tier === 'string' && tier ? tier.slice(0, 24) : null };
}

// What Orca already gathered, for someone who runs it: one command fills all
// three instead of three separate reads.
export function parseOrcaRateLimits(data: unknown): Partial<Record<ExternalProvider, ExternalUsage['groups'] | null>> {
  const limits = field(data, 'result', 'rateLimits'); if (!limits || typeof limits !== 'object') throw new Error('unexpected response');
  const out: Partial<Record<ExternalProvider, ExternalUsage['groups'] | null>> = {};
  for (const provider of EXTERNAL_PROVIDERS) {
    const entry = field(limits, provider); if (!entry || typeof entry !== 'object') continue;
    const windows = (['session', 'weekly', 'monthly'] as const).flatMap((key) => {
      const window = field(entry, key); if (!window || typeof window !== 'object') return [];
      const minutes = field(window, 'windowMinutes');
      const label = typeof minutes === 'number' ? Object.entries(MINUTES).find(([, m]) => m === minutes)?.[0] ?? `${minutes}m` : key;
      return [{ label, minutes: typeof minutes === 'number' ? minutes : null, usedPercent: percent(field(window, 'usedPercent')), resetsAt: instant(field(window, 'resetsAt')) }];
    });
    out[provider] = windows.length && !field(entry, 'error') ? [{ name: NAMES[provider], windows }] : null;
  }
  return out;
}

export const NAMES: Record<ExternalProvider, string> = { antigravity: 'Antigravity', opencodeGo: 'OpenCode Go', grok: 'Grok' };

export interface CollectDeps {
  execFile?: (command: string, args: string[], options: { timeout: number }) => Promise<string>;
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  opencodeUrl?: string;
}

const defaultExec = (command: string, args: string[], options: { timeout: number }): Promise<string> => new Promise((resolve, reject) => {
  // No shell, and nothing of ours on the command line or in the environment.
  execFileCallback(command, args, { timeout: options.timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => { if (error) reject(error); else resolve(String(stdout)); });
});

function result(provider: ExternalProvider, status: ExternalUsage['status'], note: string | null, extra: Partial<ExternalUsage> = {}, now = Date.now()): ExternalUsage {
  return { provider, status, identity: null, groups: [], note, measuredAt: now, lastOkAt: status === 'ok' ? now : null, ...extra };
}

// null: the tool is not installed here, so its box is not drawn at all.
export async function collectAntigravity(deps: CollectDeps = {}): Promise<ExternalUsage | null> {
  const exec = deps.execFile ?? defaultExec; const now = deps.now?.() ?? Date.now();
  let output: string;
  try { output = await exec('agy', ['-p', '/usage'], { timeout: 20_000 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return result('antigravity', 'error', (error as { killed?: boolean }).killed ? 'agy /usage timed out' : 'agy /usage failed', { identity: 'agy' }, now);
  }
  const groups = parseAgyUsage(output);
  return groups.length ? result('antigravity', 'ok', null, { identity: 'agy', groups }, now) : result('antigravity', 'error', 'unexpected response', { identity: 'agy' }, now);
}

async function readJson(deps: CollectDeps, path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await (deps.readFile ?? ((p: string) => readFileAsync(p, 'utf8')))(path)) as unknown; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null; }
}

export async function collectOpencodeGo(deps: CollectDeps = {}): Promise<ExternalUsage | null> {
  const env = deps.env ?? process.env; const home = deps.home ?? homedir(); const now = deps.now?.() ?? Date.now();
  const auth = await readJson(deps, join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'auth.json'));
  const stored = field(auth, 'opencode-go', 'key');
  const key = typeof stored === 'string' && stored ? stored : env.OPENCODE_API_KEY || null;
  if (!key) return null;
  const identity = typeof stored === 'string' && stored ? 'auth.json' : 'env';
  let response: Response;
  try {
    // Node's own user agent is what the endpoint accepts; it is left alone.
    response = await (deps.fetch ?? fetch)(deps.opencodeUrl ?? 'https://opencode.ai/zen/go/v1/usage', { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch { return result('opencodeGo', 'error', 'usage request failed', { identity }, now); }
  if (response.status === 401) return result('opencodeGo', 'signed-out', 'API key rejected', { identity }, now);
  if (response.status === 403) return result('opencodeGo', 'unavailable', 'no OpenCode Go subscription', { identity }, now);
  if (!response.ok) return result('opencodeGo', 'error', `HTTP ${response.status}`, { identity }, now);
  try { return result('opencodeGo', 'ok', null, { identity, groups: parseOpencodeUsage(await response.json()) }, now); } catch { return result('opencodeGo', 'error', 'unexpected response', { identity }, now); }
}

// The sign-in Grok's CLI keeps: the first auth.x.ai entry.
function grokSignIn(auth: unknown): { key: string; userId: string | null; email: string | null; expiresAt: number | null } | null {
  if (!auth || typeof auth !== 'object') return null;
  const entry = Object.entries(auth as Record<string, unknown>).find(([name, value]) => name.startsWith('https://auth.x.ai::') && typeof field(value, 'key') === 'string')?.[1];
  if (!entry) return null;
  const text = (key: string) => { const value = field(entry, key); return typeof value === 'string' && value ? value : null; };
  return { key: text('key')!, userId: text('user_id'), email: text('email'), expiresAt: instant(field(entry, 'expires_at')) };
}

export async function collectGrok(deps: CollectDeps = {}): Promise<ExternalUsage | null> {
  const env = deps.env ?? process.env; const home = deps.home ?? homedir(); const now = deps.now?.() ?? Date.now();
  const auth = await readJson(deps, join(env.GROK_HOME || join(home, '.grok'), 'auth.json'));
  if (auth === undefined) return null;
  const signIn = grokSignIn(auth);
  if (!signIn) return result('grok', 'signed-out', 'not signed in — run grok login', {}, now);
  const who = signIn.email ? maskLabel(signIn.email, 'partial', 0) : null;
  // Treated as expired five minutes early; never refreshed from here.
  if (signIn.expiresAt !== null && signIn.expiresAt - 5 * 60_000 <= now) return result('grok', 'expired', 'sign-in expired — run grok to refresh', { identity: who }, now);
  const base = (env.GROK_CLI_CHAT_PROXY_BASE_URL || 'https://cli-chat-proxy.grok.com').replace(/\/+$/, '');
  const headers: Record<string, string> = { authorization: `Bearer ${signIn.key}`, 'x-xai-token-auth': 'xai-grok-cli', accept: 'application/json' };
  if (signIn.userId) headers['x-userid'] = signIn.userId;
  const get = (path: string) => (deps.fetch ?? fetch)(`${base}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  let response: Response;
  try { response = await get('/v1/billing?format=credits'); if (!response.ok && response.status !== 401 && response.status !== 403) response = await get('/v1/billing'); }
  catch { return result('grok', 'error', 'billing request failed', { identity: who }, now); }
  if (response.status === 401 || response.status === 403) return result('grok', 'signed-out', `unauthorized (HTTP ${response.status})`, { identity: who }, now);
  if (!response.ok) return result('grok', 'error', `HTTP ${response.status}`, { identity: who }, now);
  try {
    const billing = parseGrokBilling(await response.json());
    return result('grok', 'ok', null, { identity: [billing.tier, who].filter(Boolean).join(' ') || null, groups: billing.groups }, now);
  } catch { return result('grok', 'error', 'unexpected response', { identity: who }, now); }
}

export async function collectFromOrca(deps: CollectDeps = {}): Promise<Partial<Record<ExternalProvider, ExternalUsage>>> {
  const now = deps.now?.() ?? Date.now(); const exec = deps.execFile ?? defaultExec;
  let parsed: ReturnType<typeof parseOrcaRateLimits>;
  try { parsed = parseOrcaRateLimits(JSON.parse(await exec('orca', ['account', 'list', '--json'], { timeout: 20_000 }))); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return Object.fromEntries(EXTERNAL_PROVIDERS.map((p) => [p, result(p, 'error', 'orca account list failed', {}, now)]));
  }
  return Object.fromEntries(Object.entries(parsed).map(([p, groups]) => [p, groups ? result(p as ExternalProvider, 'ok', null, { identity: 'orca', groups }, now) : result(p as ExternalProvider, 'unavailable', 'usage unavailable', { identity: 'orca' }, now)]));
}

// Keeps the latest reading per provider and decides when to read again: on
// the refresh interval after a success, and after a failure on a back-off of
// 30 s doubling up to 15 minutes. A failure keeps the last good figures on
// screen for up to 30 minutes, marked as cached; after that they are dropped.
// Antigravity's read starts a process, so only one runs at a time.
export const CACHE_MS = 30 * 60_000;
export class ExternalUsageMonitor {
  readonly usage: Partial<Record<ExternalProvider, ExternalUsage>> = {};
  private failures: Partial<Record<ExternalProvider, number>> = {};
  private dueAt: Partial<Record<ExternalProvider, number>> = {};
  private running = new Set<string>();
  private orcaDueAt = 0;

  constructor(readonly settings: ExternalUsageSettings, private readonly deps: CollectDeps = {}, private readonly collectors: Record<ExternalProvider, (deps: CollectDeps) => Promise<ExternalUsage | null>> = { antigravity: collectAntigravity, opencodeGo: collectOpencodeGo, grok: collectGrok }) {}

  // Read whatever is due (or everything, when forced). Resolves to whether
  // anything shown changed. Never throws.
  async tick(force = false): Promise<boolean> {
    if (!this.settings.enabled) return false;
    const now = this.deps.now?.() ?? Date.now();
    if (this.settings.source === 'orca') {
      if (this.running.has('orca') || (!force && this.orcaDueAt > now)) return false;
      this.running.add('orca');
      try {
        const read = await collectFromOrca(this.deps);
        for (const provider of EXTERNAL_PROVIDERS) if (this.settings.providers[provider]) this.store(provider, read[provider] ?? null, now);
        this.orcaDueAt = now + this.settings.refreshMs; return true;
      } finally { this.running.delete('orca'); }
    }
    const due = EXTERNAL_PROVIDERS.filter((p) => this.settings.providers[p] && !this.running.has(p) && (force || (this.dueAt[p] ?? 0) <= now));
    const changed = await Promise.all(due.map(async (provider) => {
      this.running.add(provider);
      try {
        let reading: ExternalUsage | null;
        try { reading = await this.collectors[provider](this.deps); } catch { reading = result(provider, 'error', 'read failed', {}, now); }
        this.store(provider, reading, now); return true;
      } finally { this.running.delete(provider); }
    }));
    return changed.some(Boolean);
  }

  private store(provider: ExternalProvider, reading: ExternalUsage | null, now: number): void {
    if (!reading) { delete this.usage[provider]; this.failures[provider] = 0; this.dueAt[provider] = now + this.settings.refreshMs; return; }
    if (reading.status === 'ok') { this.usage[provider] = reading; this.failures[provider] = 0; this.dueAt[provider] = now + this.settings.refreshMs; return; }
    const failures = (this.failures[provider] ?? 0) + 1; this.failures[provider] = failures;
    this.dueAt[provider] = now + Math.min(15 * 60_000, 30_000 * 2 ** (failures - 1));
    const previous = this.usage[provider]; const lastOkAt = previous?.lastOkAt ?? null;
    const cached = lastOkAt !== null && now - lastOkAt < CACHE_MS;
    this.usage[provider] = { ...reading, identity: reading.identity ?? previous?.identity ?? null, groups: cached ? previous!.groups : [], lastOkAt };
  }

  snapshot(): Partial<Record<ExternalProvider, ExternalUsage>> { return JSON.parse(JSON.stringify(this.usage)) as Partial<Record<ExternalProvider, ExternalUsage>>; }
}
