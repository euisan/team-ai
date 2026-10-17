#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { importAuth, loginClaude, loginCodex } from './auth.js';
import { captureDashboard } from './capture.js';
import { stripAnsi } from './columns.js';
import { linkShadowEntries, relayedCodexConfig } from './codex-config.js';
import { hostText, measureHost } from './host-metrics.js';
import { isRedactLevel } from './redact.js';
import { resetCreditSettings } from './reset-credits.js';
import { addRoute, describeReload, removeRoute } from './route-config.js';
import { parseRoutes } from './routes.js';
import { runServer, runningPid } from './runtime.js';
import { dataDir, loadConfig, loadState, saveConfig, upsertAccount } from './storage.js';
import { runTui } from './tui.js';
import type { ProviderId } from './types.js';

const invokedAs = basename(process.argv[1] || 'teamai');
const inputArgs = process.argv.slice(2);
const invocation = invokedAs === 'tai' ? ['start', ...inputArgs] : invokedAs === 'tac' ? ['run', 'claude', ...inputArgs] : invokedAs === 'tax' ? ['run', 'codex', ...inputArgs] : inputArgs;
const [command = 'help', ...args] = invocation;

function provider(value?: string): ProviderId { if (value !== 'claude' && value !== 'codex') throw new Error('Provider must be claude or codex'); return value; }
function flag(name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }

async function main(): Promise<void> {
  switch (command) {
    case 'login': { const id = args[0] ? provider(args[0]) : await selectProvider('Login provider'); const result = id === 'claude' ? await loginClaude() : await loginCodex(); const account = await upsertAccount(id, result.label, result.credential); console.log(`Added ${id} account: ${account.label}`); break; }
    case 'import': { const id = provider(args[0]); const results = await importAuth(id, flag('--from')); for (const result of results) { const account = await upsertAccount(id, result.label, result.credential); console.log(`Imported ${id} account: ${account.label}`); } break; }
    case 'accounts': await accounts(args[0] ? provider(args[0]) : undefined); break;
    case 'enable': await toggle(true); break;
    case 'disable': await toggle(false); break;
    case 'priority': await priority(); break;
    case 'server': await runServer(); break;
    case 'start': await ensureServer(); await runTui(); break;
    case 'status': await status(); break;
    case 'stop': await stop(); break;
    case 'restart': await stop(true); await ensureServer(); await runTui(); break;
    case 'session': await runClient(await selectProvider('Select session'), args.filter((x) => x !== '--')); break;
    case 'claude': await runClient('claude', args.filter((x) => x !== '--')); break;
    case 'codex': await runClient('codex', args.filter((x) => x !== '--')); break;
    case 'run': await runClient(provider(args[0]), args.slice(args[0] ? 1 : 0).filter((x) => x !== '--')); break;
    case 'tui': await runTui(); break;
    case 'route': case 'routes': await route(); break;
    case 'capture': {
      const level = flag('--redact') ?? 'partial'; if (!isRedactLevel(level)) throw new Error('--redact must be partial, full or none');
      const result = await captureDashboard({ level, outDir: flag('--out'), width: process.stdout.columns });
      console.log(result.text); console.log(result.png); break;
    }
    case 'help': case '--help': case '-h': help(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

async function selectProvider(promptLabel: string): Promise<ProviderId> {
  if (!process.stdin.isTTY) throw new Error('Specify claude or codex explicitly in a non-interactive shell');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${promptLabel} — [1] Claude, [2] Codex: `)).trim().toLowerCase();
    if (answer === '1' || answer === 'c' || answer === 'claude') return 'claude';
    if (answer === '2' || answer === 'x' || answer === 'codex') return 'codex';
    throw new Error('Choose 1 for Claude or 2 for Codex');
  } finally { prompt.close(); }
}

async function accounts(filter?: ProviderId): Promise<void> {
  const config = await loadConfig(); const state = await loadState();
  for (const a of config.accounts.filter((x) => !filter || x.provider === filter)) { const s = state.accounts[a.credentialId]; const usage = s?.usage == null ? 'unknown' : `${Math.round(s.usage * 100)}%`; console.log(`${a.provider.padEnd(7)} ${a.enabled ? 'on ' : 'off'} ${usage.padStart(7)} ${a.priority === null ? 'auto' : `#${a.priority}`} ${a.label}`); }
}
async function toggle(enabled: boolean): Promise<void> { const id = provider(args[0]); const name = args.slice(1).join(' '); const config = await loadConfig(); const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); account.enabled = enabled; await saveConfig(config); console.log(`${enabled ? 'Enabled' : 'Disabled'} ${account.label}`); }
async function priority(): Promise<void> { const id = provider(args[0]); const rankRaw = args.at(-1); const name = args.slice(1, -1).join(' '); const config = await loadConfig(); const account = config.accounts.find((a) => a.provider === id && (a.id === name || a.label === name)); if (!account) throw new Error('Account not found'); if (!rankRaw || (rankRaw !== 'auto' && (!Number.isInteger(Number(rankRaw)) || Number(rankRaw) < 1))) throw new Error('Priority must be a positive integer or auto'); account.priority = rankRaw === 'auto' ? null : Number(rankRaw); await saveConfig(config); console.log(`Priority ${account.priority ?? 'auto'}: ${account.label}`); }

async function status(): Promise<void> { const pid = await runningPid(); console.log(pid ? `TeamAI server running (pid ${pid})` : 'TeamAI server is stopped'); const host = await measureHost(); console.log(`Host: ${stripAnsi(hostText(host, true))} (${host.cpu.cores} cores)`); await accounts(); await resetCreditStatus(); await routeStatus(); }

// Configured model routes, as the server will apply them.
async function routeStatus(): Promise<void> {
  const config = await loadConfig();
  for (const id of ['claude', 'codex'] as const) {
    const routes = parseRoutes(config.routes?.[id], id); if (!routes.length) continue;
    console.log(`Routes (${id}):`);
    for (const route of routes) console.log(`  ${route.name} [${route.mode}]: ${route.match.join(', ')} → ${route.accounts.join(', ')}`);
  }
}

// `teamai route list|add|rm`. Saved through the same validation and reload as
// the dashboard's route editor.
async function route(): Promise<void> {
  const [action = 'list', name] = args; const only = flag('--provider'); const id = only === undefined ? undefined : provider(only);
  const list = (value: string | undefined): string[] => (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (action === 'list' || action === 'ls') {
    const config = await loadConfig(); let any = false;
    for (const each of id ? [id] : (['claude', 'codex'] as const)) {
      const routes = parseRoutes(config.routes?.[each], each); if (!routes.length) continue; any = true;
      console.log(`Routes (${each}) — first match wins:`);
      routes.forEach((r, i) => console.log(`  ${i + 1}. ${r.name} [${r.mode}${r.color ? `, ${r.color}` : ''}]: ${r.match.join(', ')} → ${r.accounts.join(', ')}`));
    }
    if (!any) console.log('No routes configured');
    return;
  }
  if (!name || name.startsWith('--')) throw new Error(`Usage: teamai route ${action === 'rm' || action === 'remove' ? 'rm <name> [--provider claude|codex]' : 'add <name> [--provider claude|codex] --match a,b --accounts x,y [--mode prefer|exclusive] [--color c]'}`);
  if (action === 'add') {
    const target = id ?? 'claude';
    const result = await addRoute(target, { name, match: list(flag('--match')), accounts: list(flag('--accounts')), mode: flag('--mode'), color: flag('--color') });
    for (const ref of result.unknown) console.log(`warning: account ${ref} not found among ${target} accounts — the server will skip it`);
    console.log(`${result.replaced ? 'Updated' : 'Added'} ${target} route ${name}: ${describeReload(result.outcome)}`);
    if (result.outcome.status === 'failed') process.exitCode = 1;
    return;
  }
  if (action === 'rm' || action === 'remove') {
    const result = await removeRoute(name, id);
    console.log(`Removed ${result.provider} route ${name}: ${describeReload(result.outcome)}`);
    if (result.outcome.status === 'failed') process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown route action: ${action} (list, add or rm)`);
}

// Codex reset credits per account, from what the server last recorded.
async function resetCreditStatus(): Promise<void> {
  const config = await loadConfig(); const state = await loadState(); const settings = resetCreditSettings(config);
  const codex = config.accounts.filter((a) => a.provider === 'codex'); if (!codex.length) return;
  console.log(`Reset credits: auto-redeem ${settings.enabled ? `on (policy ${settings.policy}, cooldown ${Math.round(settings.cooldownMs / 60_000)}m, reserve ${settings.reserve}${settings.sessionWindow ? ', 5h window too' : ''})` : 'off'}`);
  for (const account of codex) {
    const saved = state.accounts[account.credentialId];
    const count = typeof saved?.resetCredits === 'number' ? saved.resetCredits : null;
    const used = saved?.resetCreditsConsumed ? `, ${saved.resetCreditsConsumed} redeemed` : '';
    const last = saved?.resetCreditLastOutcome ? ` (last: ${saved.resetCreditLastOutcome})` : '';
    console.log(`  ${account.label}: ${count === null ? (settings.enabled ? 'unknown (no usage read has reported a count yet)' : 'unknown') : `${count} available${used}${last}`}`);
  }
}
async function stop(quiet = false): Promise<void> { const pid = await runningPid(); if (!pid) { if (!quiet) console.log('TeamAI server is not running'); return; } process.kill(pid, 'SIGTERM'); for (let i = 0; i < 30 && await runningPid(); i++) await new Promise((r) => setTimeout(r, 100)); if (!quiet) console.log(`Stopped TeamAI server ${pid}`); }

// Start the relay on demand. This is what makes the launchers work whether or
// not a LaunchAgent (or any other supervisor) is managing the server: if
// nothing is listening, the client starts one itself.
async function ensureServer(): Promise<void> {
  if (await runningPid()) return;
  // Capture the child's output instead of discarding it: when startup fails,
  // its stderr is the only thing that says why (a port already taken, a bad
  // credential file), and "did not start" on its own sends the user hunting.
  const log = join(dataDir(), 'server-start.log');
  await mkdir(dirname(log), { recursive: true, mode: 0o700 });
  const handle = await open(log, 'w', 0o600);
  const cli = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [cli, 'server'], { detached: true, stdio: ['ignore', handle.fd, handle.fd], env: process.env });
  child.unref();
  await handle.close();
  for (let i = 0; i < 50; i++) { if (await runningPid()) return; await new Promise((r) => setTimeout(r, 100)); }
  let detail = '';
  try { detail = (await readFile(log, 'utf8')).trim(); } catch { /* nothing was written */ }
  throw new Error(detail ? `TeamAI server did not start: ${detail}` : `TeamAI server did not start (see ${log})`);
}

async function runClient(id: ProviderId, clientArgs: string[]): Promise<void> {
  const config = await loadConfig(); if (!config.accounts.some((a) => a.provider === id && a.enabled)) throw new Error(`No enabled ${id} accounts`); await ensureServer();
  if (id === 'claude') {
    const result = spawnSync('claude', clientArgs, { stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: `http://${config.proxy.host}:${config.proxy.claudePort}`, ANTHROPIC_AUTH_TOKEN: config.proxy.clientToken } });
    if (result.error) throw result.error; process.exitCode = result.status ?? 1; return;
  }
  const shadow = join(process.env.TEAMAI_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teamai'), 'codex-home'); await mkdir(shadow, { recursive: true, mode: 0o700 });
  const originalHome = process.env.CODEX_HOME || join(homedir(), '.codex'); let original = ''; try { original = await readFile(join(originalHome, 'config.toml'), 'utf8'); } catch { /* optional */ }
  // The relayed config is rewritten on every launch; the previous one is read
  // first so hook trust granted inside a relayed session is not lost.
  let previousShadow = ''; try { previousShadow = await readFile(join(shadow, 'config.toml'), 'utf8'); } catch { /* first launch */ }
  await writeFile(join(shadow, 'config.toml'), relayedCodexConfig(original, config.proxy.host, config.proxy.codexPort, { originalHome, shadowHome: shadow, previousShadow }), { mode: 0o600 }); await chmod(shadow, 0o700);
  await linkShadowEntries(originalHome, shadow);
  const overrides = [
    '-c', 'model_provider="teamai"',
    '-c', `model_providers.teamai.name="TeamAI Codex Relay"`,
    '-c', `model_providers.teamai.base_url="http://${config.proxy.host}:${config.proxy.codexPort}/v1"`,
    '-c', 'model_providers.teamai.env_key="TEAMAI_PROXY_TOKEN"',
    '-c', 'model_providers.teamai.wire_api="responses"',
    // Request-level failover (401/429/5xx) is the relay's job, so the client
    // must not retry the initial request and double up on account rotation.
    // Stream retries are different: a mid-body SSE cut from chatgpt.com is a
    // known transient that direct Codex hides with its default of 5 retries.
    // With 0 the first cut ended the turn as a hard "stream disconnected
    // before completion" error and the in-flight answer was lost (2026-09-19).
    '-c', 'model_providers.teamai.request_max_retries=0',
    '-c', 'model_providers.teamai.stream_max_retries=5',
    // Codex declares a stream dead after stream_idle_timeout_ms without an SSE
    // event (default 300s). A high-effort turn routinely thinks for longer than
    // that before its first token, so the default cut live turns mid-reasoning
    // and the client silently reconnected — which reads as a hung session, not
    // an error (2026-09-20, gpt-5.6-luna --effort max: a 15-minute turn cut and
    // retried, a second one lost after 10 minutes of silence). The relay
    // forwards upstream chunks unbuffered and injects no keepalives, so this
    // silence is upstream's and only the client's patience can cover it.
    '-c', 'model_providers.teamai.stream_idle_timeout_ms=1800000',
  ];
  const result = spawnSync('codex', [...overrides, ...clientArgs], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: shadow, TEAMAI_PROXY_TOKEN: config.proxy.clientToken } });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
}

function help(): void { console.log(`TeamAI — multi-account relay for Claude Code and Codex CLI

Usage:
  tai                                  Open the TeamAI dashboard
  tac [CLAUDE_ARGS...]                 Start a relayed Claude Code session
  tax [CODEX_ARGS...]                  Start a relayed Codex session
  teamai claude [CLAUDE_ARGS...]       Start a relayed Claude Code session
  teamai codex [CODEX_ARGS...]         Start a relayed Codex session
  teamai session [CLIENT_ARGS...]      Choose Claude or Codex interactively
  teamai login [claude|codex]
  teamai import <claude|codex> [--from PATH]
  teamai accounts [claude|codex]
  teamai start|restart|status|stop
  teamai enable|disable <provider> <account>
  teamai priority <provider> <account> <rank|auto>
  teamai route list [--provider claude|codex]
  teamai route add <name> [--provider claude|codex] --match a,b --accounts x,y
                   [--mode prefer|exclusive] [--color red|green|yellow|blue|magenta|cyan]
  teamai route rm <name> [--provider claude|codex]
                                       Model routes; saved and applied to a
                                       running server without a restart
  teamai capture [--redact partial|full|none] [--out DIR]
                                       Save the dashboard as .txt and .png,
                                       account addresses masked (no TTY needed)

Run "teamai start", then press 1 for Claude Code or 2 for Codex.`); }

main().catch((error) => { console.error(`teamai: ${(error as Error).message}`); process.exitCode = 1; });
