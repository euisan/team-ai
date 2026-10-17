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
export async function saveRoutes(provider: ProviderId, routes: RouteConfig[]): Promise<void> {
  parseRoutes(routes, provider);
  const config = await loadConfig();
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

export async function applyRoutes(provider: ProviderId, routes: RouteConfig[]): Promise<ReloadOutcome> {
  await saveRoutes(provider, routes);
  return reloadServerRoutes();
}

export function describeReload(outcome: ReloadOutcome): string {
  if (outcome.status === 'applied') return outcome.warnings.length ? `applied to the running server (${outcome.warnings.join('; ')})` : 'applied to the running server';
  if (outcome.status === 'not-running') return 'server not running — applies when it starts';
  return `saved, but the running server did not reload (${outcome.error}) — applies after restart`;
}

// An account reference as the editor and the CLI store it: the label when the
// reference names an account of this provider (label, id or credential id, as
// the pool matches them), otherwise unchanged.
export function accountLabel(accounts: StoredAccount[], provider: ProviderId, ref: string | number): string | number {
  const own = accounts.filter((account) => account.provider === provider);
  const found = typeof ref === 'number' ? own[ref] : own.find((account) => account.label === ref || account.id === ref || account.credentialId === ref);
  return found ? found.label : ref;
}
