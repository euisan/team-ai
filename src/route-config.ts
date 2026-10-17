// Writing model routes, for the dashboard's route editor and `teamai route`.
// Both go through here: validate with parseRoutes (what the server runs at
// startup, so nothing saved here can stop it from starting), replace only
// routes.<provider> in config.json, then ask a running server to re-read them.
import { ROUTE_RELOAD_PATH } from './route-control.js';
import { parseRoutes, type RouteConfig } from './routes.js';
import { runningPid } from './runtime.js';
import { loadConfig, saveConfig } from './storage.js';
import type { ProviderId, StoredAccount } from './types.js';

// Throws parseRoutes' own message and writes nothing when the list is invalid.
// Everything else in config.json is written back as it was read; saveConfig
// writes a 0600 temp file and renames it over the old one.
function accountConfigured(accounts: StoredAccount[], provider: ProviderId, ref: string | number): boolean {
  const own = accounts.filter((account) => account.provider === provider);
  if (typeof ref === 'number') return Number.isInteger(ref) && ref >= 0 && ref < own.length;
  return own.some((account) => account.label === ref || account.id === ref || account.credentialId === ref);
}

function assertExclusiveAccounts(provider: ProviderId, routes: RouteConfig[], accounts: StoredAccount[]): void {
  for (const route of routes) {
    if ((route.mode ?? 'prefer') !== 'exclusive') continue;
    if (!route.accounts.some((ref) => accountConfigured(accounts, provider, ref))) {
      throw new Error(`route ${route.name}: exclusive route must include a configured ${provider} account`);
    }
  }
}

const sameRoutes = (a: RouteConfig[] | undefined, b: RouteConfig[]): boolean => JSON.stringify(a ?? []) === JSON.stringify(b);

export async function saveRoutes(provider: ProviderId, routes: RouteConfig[], expected?: RouteConfig[]): Promise<void> {
  parseRoutes(routes, provider);
  const config = await loadConfig();
  assertExclusiveAccounts(provider, routes, config.accounts);
  if (expected && !sameRoutes(config.routes?.[provider], expected)) {
    throw new Error(`routes.${provider} changed while you were editing; reload and try again`);
  }
  config.routes = { ...config.routes, [provider]: routes };
  await saveConfig(config);
}

export type ReloadOutcome = { status: 'applied'; warnings: string[] } | { status: 'not-running' } | { status: 'failed'; error: string };

// Ask the running server to re-read its routes. A failure leaves the saved file
// as it is: it is valid, and the server picks it up on its next start.
export async function reloadServerRoutes(): Promise<ReloadOutcome> {
  if (!(await runningPid())) return { status: 'not-running' };
  try {
    const config = await loadConfig(); const port = config.proxy.controlPort ?? config.proxy.claudePort + 100;
    const response = await fetch(`http://${config.proxy.host}:${port}${ROUTE_RELOAD_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${config.proxy.clientToken}` }, signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({})) as { warnings?: string[]; error?: string };
    if (!response.ok) return { status: 'failed', error: body.error || `control ${response.status}` };
    return { status: 'applied', warnings: body.warnings ?? [] };
  } catch (error) { return { status: 'failed', error: (error as Error).message }; }
}

export async function applyRoutes(provider: ProviderId, routes: RouteConfig[], expected?: RouteConfig[]): Promise<ReloadOutcome> {
  await saveRoutes(provider, routes, expected);
  return reloadServerRoutes();
}

export function describeReload(outcome: ReloadOutcome): string {
  if (outcome.status === 'applied') return outcome.warnings.length ? `applied to the running server (${outcome.warnings.join('; ')})` : 'applied to the running server';
  if (outcome.status === 'not-running') return 'server not running — applies when it starts';
  return `saved, but the running server did not reload (${outcome.error}) — applies after restart`;
}

export interface RouteInput { name: string; match: string[]; accounts: string[]; mode?: string; color?: string }

// `teamai route add`: a new route goes last; one with the same name is
// replaced where it stands, so the CLI can also edit. Values are passed through
// as given — parseRoutes in saveRoutes is what judges them.
export async function addRoute(provider: ProviderId, input: RouteInput): Promise<{ replaced: boolean; unknown: string[]; outcome: ReloadOutcome }> {
  const config = await loadConfig(); const list = [...(config.routes?.[provider] ?? [])];
  const accounts = input.accounts.map((ref) => accountLabel(config.accounts, provider, ref));
  const unknown = accounts.filter((ref) => !config.accounts.some((account) => account.provider === provider && account.label === ref)).map(String);
  const entry = { name: input.name, match: input.match, accounts, mode: input.mode ?? 'prefer', ...(input.color ? { color: input.color } : {}) } as RouteConfig;
  const at = list.findIndex((route) => route.name === input.name);
  if (at >= 0) list[at] = entry; else list.push(entry);
  return { replaced: at >= 0, unknown, outcome: await applyRoutes(provider, list) };
}

// `teamai route rm`: by name, in the given provider or whichever one has it.
export async function removeRoute(name: string, provider?: ProviderId): Promise<{ provider: ProviderId; outcome: ReloadOutcome }> {
  const config = await loadConfig();
  const owners = (provider ? [provider] : (['claude', 'codex'] as const)).filter((id) => (config.routes?.[id] ?? []).some((route) => route.name === name));
  if (!owners.length) throw new Error(`Route not found: ${name}`);
  if (owners.length > 1) throw new Error(`Route ${name} exists for both claude and codex; pass --provider`);
  const owner = owners[0]!;
  return { provider: owner, outcome: await applyRoutes(owner, (config.routes?.[owner] ?? []).filter((route) => route.name !== name)) };
}

// An account reference as the editor and the CLI store it: the label when the
// reference names an account of this provider (label, id or credential id, as
// the pool matches them), otherwise unchanged.
export function accountLabel(accounts: StoredAccount[], provider: ProviderId, ref: string | number): string | number {
  const own = accounts.filter((account) => account.provider === provider);
  const found = typeof ref === 'number' ? own[ref] : own.find((account) => account.label === ref || account.id === ref || account.credentialId === ref);
  return found ? found.label : ref;
}
