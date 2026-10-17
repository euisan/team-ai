import { lstat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse, stringify, type TomlTable } from 'smol-toml';

// What the relayed Codex home borrows from the user's own by symlink. Codex
// reads these from CODEX_HOME, so without the link a relayed session would
// not see them. hooks.json is the global hook list.
export const SHADOW_LINKS = ['skills', 'plugins', 'rules', 'hooks.json'] as const;

// The homes involved in hook trust: Codex records trust per hook under
// [hooks.state."<path to hooks.json>:<event>:<group>:<hook>"], keyed by the
// path it read the file from. The relayed home reads the same file through
// its own path, so trust given in the user's home has to be repeated under
// the relayed path. previousShadow is the relayed config.toml being replaced.
export interface ShadowHomes { originalHome: string; shadowHome: string; previousShadow?: string }

/** Persist routing in the isolated home so nested `codex exec` inherits it.
 * CLI -c flags alone apply only to the outer process. Never serialize tokens.
 */
export function relayedCodexConfig(original: string, host: string, port: number, homes?: ShadowHomes): string {
  const config = parse(original);
  if (homes) carryHookTrust(config, homes);
  config.model_provider = 'teamai';
  const providers = (config.model_providers ?? {}) as TomlTable;
  providers.teamai = {
    name: 'TeamAI Codex Relay', base_url: `http://${host}:${port}/v1`,
    env_key: 'TEAMAI_PROXY_TOKEN', wire_api: 'responses',
    request_max_retries: 0, stream_max_retries: 5,
    // Mirrors the -c override in cli.ts: a high-effort turn can think for far
    // longer than Codex's 300s default before emitting its first SSE event, and
    // a nested `codex exec` reads this file rather than those flags.
    stream_idle_timeout_ms: 1_800_000,
  };
  config.model_providers = providers;
  return stringify(config);
}

// Copy the trust the user already gave to their global hooks onto the keys the
// relayed home will look up. The record is copied as it is — never computed,
// so nothing the user did not trust becomes trusted. Trust given inside a
// relayed session lands only in the relayed config.toml, which is rewritten on
// every launch, so it is carried over from the previous one; where both have
// the same key, the user's own home wins (it holds the one real hooks.json).
// Paths are compared resolved but not through symlinks: Codex keys on the
// path as given.
function carryHookTrust(config: TomlTable, homes: ShadowHomes): void {
  const from = `${join(resolve(homes.originalHome), 'hooks.json')}:`; const to = `${join(resolve(homes.shadowHome), 'hooks.json')}:`;
  const hooks = (config.hooks ?? {}) as TomlTable; const state = (hooks.state ?? {}) as TomlTable;
  const carried: TomlTable = {};
  let previous: TomlTable = {};
  try { previous = (((parse(homes.previousShadow ?? '').hooks ?? {}) as TomlTable).state ?? {}) as TomlTable; } catch { /* an unreadable old file just has nothing to carry */ }
  for (const [key, value] of Object.entries(previous)) if (key.startsWith(to)) carried[key] = value;
  for (const [key, value] of Object.entries(state)) if (key.startsWith(from)) carried[`${to}${key.slice(from.length)}`] = value;
  if (!Object.keys(carried).length) return;
  config.hooks = { ...hooks, state: { ...state, ...carried } };
}

// Link each SHADOW_LINKS entry into the relayed home, unless something is
// already there or the user's home has no such entry.
export async function linkShadowEntries(originalHome: string, shadowHome: string): Promise<string[]> {
  const linked: string[] = [];
  for (const name of SHADOW_LINKS) {
    const source = join(originalHome, name); const target = join(shadowHome, name);
    try { await lstat(target); continue; } catch { /* free to link */ }
    try { const stat = await lstat(source); await symlink(source, target, stat.isDirectory() ? 'dir' : 'file'); linked.push(name); } catch { /* optional */ }
  }
  return linked;
}
