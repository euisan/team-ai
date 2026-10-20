// Applying a saved config.json: what the dashboard and the account commands
// call after every account write (switch, on/off, priority, login, delete).
// A running server re-reads it in place over the control port
// (config-reload.ts), so nothing in flight is cut; a stopped one is started,
// and reads the file as it starts.
import { CONFIG_RELOAD_PATH, type ReloadResult } from './config-reload.js';
import { ensureServer, runningPid } from './runtime.js';
import { loadConfig } from './storage.js';

export type ApplyOutcome = { status: 'applied'; result: ReloadResult } | { status: 'started' } | { status: 'not-running' } | { status: 'refused'; error: string } | { status: 'failed'; error: string };

// Ask the running server to re-read config.json. 'refused' is the server
// turning the file down (it keeps the settings it had); 'failed' is not
// reaching it.
export async function reloadServerConfig(): Promise<ApplyOutcome> {
  if (!(await runningPid())) return { status: 'not-running' };
  try {
    const config = await loadConfig(); const port = config.proxy.controlPort ?? config.proxy.claudePort + 100;
    const response = await fetch(`http://${config.proxy.host}:${port}${CONFIG_RELOAD_PATH}`, { method: 'POST', headers: { authorization: `Bearer ${config.proxy.clientToken}` }, signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({})) as ReloadResult & { error?: string };
    if (response.status === 400) return { status: 'refused', error: body.error || 'invalid config' };
    // A server from before this route existed: only a restart brings it in.
    if (response.status === 404) return { status: 'failed', error: 'the running server cannot reload — run teamai restart once' };
    if (!response.ok) return { status: 'failed', error: body.error || `control ${response.status}` };
    return { status: 'applied', result: body };
  } catch (error) { return { status: 'failed', error: (error as Error).message }; }
}

// Reload a running server, or start one when none is running. start is
// ensureServer outside tests.
export async function applyConfig(start: () => Promise<void> = ensureServer): Promise<ApplyOutcome> {
  const outcome = await reloadServerConfig();
  if (outcome.status !== 'not-running') return outcome;
  await start(); return { status: 'started' };
}

export function describeApply(outcome: ApplyOutcome): string {
  if (outcome.status === 'applied') return outcome.result.warnings.length ? `applied (${outcome.result.warnings.join('; ')})` : 'applied';
  if (outcome.status === 'started') return 'server started';
  if (outcome.status === 'not-running') return 'server not running — applies when it starts';
  if (outcome.status === 'refused') return `saved, but the server refused it and kept its settings: ${outcome.error}`;
  return `saved, but the running server could not be reached (${outcome.error})`;
}
