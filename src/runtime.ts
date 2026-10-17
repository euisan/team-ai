import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Server } from 'node:http';
import { AccountPool } from './account-pool.js';
import { ActivityLog } from './activity.js';
import { createProxy, maxBodyBytes, secureEqual } from './proxy.js';
import { handleResetCreditControl } from './reset-credit-control.js';
import { resetCreditSettings } from './reset-credits.js';
import { handleRouteControl } from './route-control.js';
import { parseRoutes } from './routes.js';
import { ExternalUsageMonitor, externalUsageSettings } from './external-usage.js';
import { createServer } from 'node:http';
import { providers } from './providers.js';
import { defaultConfig, loadConfig, loadCredentials, loadState, paths, saveCredentials, saveState } from './storage.js';
import type { ActivityEvent, PersistedState, ProviderId, TeamAIConfig } from './types.js';

// How long a stopping server waits for in-flight responses before cutting them.
const DRAIN_MS = 5_000;

// Ports this provider should still answer on besides the configured one:
// whatever the user listed in proxy.legacyPorts, plus the built-in default,
// which is the port every session started before the config was edited was
// handed. Deduplicated, and never the live port itself.
export function legacyPorts(config: TeamAIConfig, id: ProviderId): number[] {
  const current = id === 'claude' ? config.proxy.claudePort : config.proxy.codexPort;
  const fallback = defaultConfig().proxy;
  const declared = config.proxy.legacyPorts?.[id] ?? [];
  const builtIn = id === 'claude' ? fallback.claudePort : fallback.codexPort;
  return [...new Set([...declared, builtIn])].filter((p) => Number.isInteger(p) && p > 0 && p !== current);
}

// What startServer hands back: stop() drains and closes every port, saves,
// and gives up server.json; the process itself keeps running.
export interface RunningServer { stop(): Promise<void> }
// background: false leaves out the timers that reach upstream (warm-up, usage,
// profile and token refreshes, other agents' usage) — for tests.
export interface StartOptions { background?: boolean }

export async function runServer(): Promise<void> {
  const server = await startServer();
  const shutdown = async (): Promise<void> => { await server.stop(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}

// Every port is bound before any timer starts, and a port that cannot be bound
// (EADDRINUSE is the usual case) closes the ones already open before the error
// goes up: a half-started relay used to keep answering on the ports it got,
// while the launcher read the failure as "not running" and started another.
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const background = options.background ?? true;
  const config = await loadConfig(); const credentials = await loadCredentials(); const state = await loadState();
  // Checked before anything else: a bad limit is a startup error, not a relay
  // that turns away every request or none.
  const bodyLimit = maxBodyBytes(config.proxy.maxBodyMb);
  const pools = (['claude', 'codex'] as const).map((id) => new AccountPool(providers[id], config.accounts, credentials, state, config.switchThreshold, config.maxConcurrentPerAccount, config.fableReserveThreshold ?? 0.8));
  if (pools.every((p) => p.accounts.length === 0)) throw new Error('No accounts configured');
  const balance = config.routing?.balance ?? 'pacing';
  if (balance !== 'pacing' && balance !== 'level') throw new Error(`routing.balance must be "pacing" or "level", not ${JSON.stringify(balance)}`);
  for (const pool of pools) pool.balance = balance;
  // Model routes are checked before anything listens: a malformed route is a
  // startup error rather than a route that silently never applies.
  const routeWarnings = pools.flatMap((pool) => pool.setRoutes(parseRoutes(config.routes?.[pool.provider.id], pool.provider.id)).map((warning) => `${pool.provider.label} ${warning}`));
  for (const warning of routeWarnings) console.log(`[TeamAI] ${warning}`);
  let saveTimer: NodeJS.Timeout | null = null; let saving = Promise.resolve(); const events: ActivityEvent[] = [...(state.events || [])].slice(-200);
  // Requests in flight. Not restored from state.json: whatever a previous
  // process had open died with it.
  let closing = false;
  // Other agents' usage, read on its own timer and isolated from the relay:
  // a failure there is a row on the dashboard, never an error here.
  const external = new ExternalUsageMonitor(externalUsageSettings(config));
  const activity = new ActivityLog((event) => persist(event), () => persistActivity());
  const snapshot = (): PersistedState => { const next: PersistedState = { version: 1, accounts: {}, events, active: closing ? [] : activity.snapshot(), serverPid: process.pid, external: external.snapshot() }; pools.forEach((p) => p.exportState(next)); return next; };
  // Every save first adopts any credential the TUI wrote since (a re-login),
  // then writes memory back — so a fresh token is picked up within a save
  // interval instead of being overwritten by the stale one it replaced.
  const persistNow = async (): Promise<void> => { const updated = await loadCredentials(); const adopted = pools.reduce((n, p) => n + p.adoptCredentials(updated), 0); if (adopted) events.push({ at: Date.now(), message: `Adopted ${adopted} re-logged credential(s)` }); const next = snapshot(); for (const p of pools) for (const a of p.accounts) updated[a.credentialId] = a.credential; await Promise.all([saveState(next), saveCredentials(updated)]); };
  // A request starting or picking an account changes only what the dashboard
  // shows, so it rewrites state.json alone; credentials wait for a real save.
  const persistStateOnly = async (): Promise<void> => { await saveState(snapshot()); };
  let fullSave = false;
  const schedule = (): void => { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; const run = fullSave ? persistNow : persistStateOnly; fullSave = false; saving = saving.then(run, run); }, 25); };
  const persist = (event?: string | ActivityEvent): void => { if (event) { events.push(typeof event === 'string' ? { at: Date.now(), message: event } : event); if (events.length > 200) events.splice(0, events.length - 200); } fullSave = true; schedule(); };
  const persistActivity = (): void => schedule();
  // Reset credits: the ledger goes to disk before and after each consume call,
  // through the same save chain so it never races a scheduled save.
  const saveImmediately = (): Promise<void> => { saving = saving.then(persistNow, persistNow); return saving; };
  for (const warning of routeWarnings) persist(warning);
  for (const pool of pools) {
    pool.log = (message) => persist(message); pool.saveNow = saveImmediately;
    if (pool.provider.id === 'codex') pool.resetCredits = resetCreditSettings(config);
  }
  const servers: Server[] = [];
  const readExternal = async (force = false): Promise<void> => { try { if (await external.tick(force)) persistActivity(); } catch { /* display only */ } };
  const listen = (server: Server, port: number): Promise<void> => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, config.proxy.host, () => { server.removeListener('error', reject); resolve(); }); });
  try {
    for (const pool of pools) {
      if (!pool.accounts.length) continue;
      const port = pool.provider.id === 'claude' ? config.proxy.claudePort : config.proxy.codexPort;
      const server = createProxy(pool, config.proxy.clientToken, persist, () => pool.totalCapacity(), activity, bodyLimit); servers.push(server);
      await listen(server, port);
      // Past startup, a socket-level error must never end the process: the relay
      // is the only route its clients have, and killing it over one bad socket
      // strands every open session with connection refused.
      server.on('error', (error) => console.log(`[TeamAI] ${pool.provider.label} proxy error: ${error.message}`));
      console.log(`[TeamAI] ${pool.provider.label} proxy: http://${config.proxy.host}:${port}`);

      // Also answer on ports this provider used before. A client is handed its
      // base URL through the environment when it starts (cli.ts), and a running
      // process cannot be told about a new one — so changing a port in config
      // strands every session already open, permanently, with connection refused.
      // Keeping the old port alive is what makes a port change survivable.
      // Failures here are not fatal: a port taken by something else just means
      // that one legacy address is unavailable, not that the proxy cannot serve.
      for (const legacy of legacyPorts(config, pool.provider.id)) {
        const alias = createProxy(pool, config.proxy.clientToken, persist, () => pool.totalCapacity(), activity, bodyLimit);
        try {
          await listen(alias, legacy);
          servers.push(alias);
          console.log(`[TeamAI] ${pool.provider.label} proxy (legacy): http://${config.proxy.host}:${legacy}`);
        } catch (error) {
          // The port is taken (often by an older instance of this very proxy).
          // Close the half-built server rather than leaving it attached: an
          // abandoned one keeps an 'error' listener on a live handle, and the
          // next error it emits is unhandled — which takes down the process that
          // is still serving the main port, and looks to clients exactly like the
          // connection refused this feature exists to prevent.
          alias.close();
          alias.removeAllListeners();
          console.log(`[TeamAI] ${pool.provider.label} legacy port ${legacy} unavailable: ${(error as Error).message}`);
        }
      }
    }
    // Local control channel: the TUI runs in a separate process, so a fleet-wide
    // quota re-measure (R) has to reach the pools living here. Bound to the proxy
    // host and gated by the same client token as the proxies.
    const control = createServer(async (req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
      if (await handleResetCreditControl(req, res, pools.find((p) => p.provider.id === 'codex'), config.proxy.clientToken)) return;
      // Routes edited in the dashboard or with `teamai route`, applied in place.
      if (await handleRouteControl(req, res, pools, config.proxy.clientToken, (warnings, counts) => { persist(`Routes reloaded: claude ${counts.claude ?? 0}, codex ${counts.codex ?? 0}`); for (const warning of warnings) persist(warning); })) return;
      if (!secureEqual(token, config.proxy.clientToken)) { res.writeHead(401).end('{}'); return; }
      if (!req.url?.startsWith('/probe')) { res.writeHead(404).end('{}'); return; }
      // Pick up accounts added or removed by the TUI (a separate process) before
      // measuring, so `R` reflects the current fleet without a server restart.
      const [latestConfig, latestCredentials] = await Promise.all([loadConfig(), loadCredentials()]);
      const changes = pools.map((p) => p.sync(latestConfig.accounts, latestCredentials)).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }), { added: 0, removed: 0 });
      if (changes.added || changes.removed) {
        persist(`Fleet updated: ${changes.added} added, ${changes.removed} removed`);
        // A new account has no profile yet; fill it so its plan renders with its
        // first measurement rather than one refresh cycle later.
        await Promise.all(pools.map((p) => p.refreshProfiles().catch(() => 0)));
      }
      // R also re-reads the other agents, in the background: agy alone takes
      // seconds and must not hold up the account re-measure.
      void readExternal(true);
      const results = await Promise.all(pools.filter((p) => p.accounts.length).map((p) => p.probeAll()));
      const total = results.reduce((acc, r) => ({ targets: acc.targets + r.targets, measured: acc.measured + r.measured }), { targets: 0, measured: 0 });
      const ready = total.measured > 0 || pools.some((p) => p.hasProbe());
      if (total.targets) persist(`Quota re-measure: ${total.measured}/${total.targets} account(s)`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...total, ready, ...changes }));
    });
    await listen(control, config.proxy.controlPort ?? config.proxy.claudePort + 100); servers.push(control);
  } catch (error) {
    // Close what did bind, drop the save a route warning may have scheduled,
    // and let the reason go up (to server-start.log, via cli.ts).
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } await saving;
    throw error;
  }

  const timers: NodeJS.Timeout[] = [];
  // Periodic warm-up. First every account whose figures are older than half a
  // tick is re-read from the usage endpoint, which spends no quota — so usage
  // run up outside this proxy shows without pressing R, and no reading is ever
  // much older than one tick. Accounts live traffic keeps fresh are skipped.
  // Then anything still unmeasured (the endpoint failed, or the provider has
  // none) is probed, which does spend quota and so is kept to that remainder.
  const warmupIntervalMs = config.warmupIntervalMs ?? 5 * 60_000;
  if (background && warmupIntervalMs > 0) {
    const runWarmup = async (): Promise<void> => {
      const swept = pools.reduce((total, pool) => total + pool.sweepExpired(), 0);
      const refreshed = (await Promise.all(pools.map((pool) => pool.refreshUsage(warmupIntervalMs / 2)))).reduce((a, b) => a + b.size, 0);
      const measured = (await Promise.all(pools.map((pool) => pool.warmup().catch(() => 0)))).reduce((a, b) => a + b, 0);
      if (measured) persist(`Warm-up measured ${measured} account(s)${swept ? ` after ${swept} window reset(s)` : ''}`);
      else if (swept) persist(`${swept} quota window(s) reset`);
      else if (refreshed) persist();
    };
    timers.push(setInterval(() => void runWarmup(), warmupIntervalMs), setTimeout(() => void runWarmup(), 5_000));
  }

  // The next-account arrows change quietly — a cooldown runs out, a window
  // rolls over — with no event to trigger a save. Re-derive them every 15s
  // and write state.json only when they actually moved.
  let lastMarkers = '';
  const markers = (): string => { const probe: PersistedState = { version: 1, accounts: {} }; pools.forEach((p) => p.exportState(probe)); return JSON.stringify([probe.next, probe.routes]); };
  timers.push(setInterval(() => { const now = markers(); if (now !== lastMarkers) { lastMarkers = now; persistActivity(); } }, 15_000));

  // Other agents' usage, every 30s; R (the control port) also reads it now.
  if (background) {
    timers.push(setInterval(() => void readExternal(), 30_000), setTimeout(() => void readExternal(), 5_000));
  }
  const refreshProfiles = async (): Promise<void> => { const count = (await Promise.all(pools.map((pool) => pool.refreshProfiles()))).reduce((a, b) => a + b, 0); if (count) persist(`Refreshed subscription status for ${count} account(s)`); };
  // Token keep-alive: refresh idle accounts' lapsing tokens so a chain that
  // never rotates does not get invalidated upstream. Runs once now and every
  // five minutes; the sweep itself is sequential to avoid a token-endpoint burst.
  // The sweep always schedules a save, even with nothing to report, so an idle
  // fleet still adopts a re-login (see persistNow) within five minutes.
  const refreshLapsed = async (): Promise<void> => { const results = await Promise.all(pools.map((pool) => pool.refreshLapsed())); const healed = results.reduce((a, r) => a + r.healed, 0); const failed = results.reduce((a, r) => a + r.failed, 0); if (healed) persist(`Refreshed ${healed} lapsed token(s)`); if (failed) persist(`${failed} token refresh(es) failed — re-login needed`); if (!healed && !failed) persist(); };
  if (background) {
    void refreshProfiles(); timers.push(setInterval(() => void refreshProfiles(), 6 * 60 * 60_000));
    setImmediate(() => void refreshLapsed()); timers.push(setInterval(() => void refreshLapsed(), 5 * 60_000));
  }
  for (const timer of timers) timer.unref();

  const serverPath = paths().server; await mkdir(dirname(serverPath), { recursive: true }); await writeFile(serverPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  // close() stops listening at once but resolves only when every in-flight
  // response has ended. One long streaming turn held that open for minutes
  // while every other session got connection refused, because the supervisor
  // will not start a replacement until this process exits. Give drains a
  // moment, then cut what is left: the cut client retries, the rest reconnect
  // to the new process seconds later.
  const stop = async (): Promise<void> => {
    for (const timer of timers) clearTimeout(timer); if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const drained = Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.race([drained, new Promise<void>((resolve) => setTimeout(resolve, DRAIN_MS).unref())]);
    servers.forEach((server) => server.closeAllConnections());
    closing = true; await drained; await saving; await persistNow(); await releaseServerFile(serverPath);
  };
  return { stop };
}

// Remove server.json only while it still names this process. A restart lets the
// replacement bind and write its own server.json while this one is still
// draining; deleting unconditionally erased the live server's record, so every
// launcher took the relay for stopped and died on EADDRINUSE (2026-10-15).
async function releaseServerFile(serverPath: string): Promise<void> {
  try { const value = JSON.parse(await readFile(serverPath, 'utf8')) as { pid?: number }; if (value.pid !== process.pid) return; } catch { return; }
  await rm(serverPath, { force: true });
}
// The state as the dashboard should draw it: in-flight requests only while the
// server that recorded them is still the one running.
export async function liveState(state: PersistedState): Promise<PersistedState> {
  const pid = await runningPid();
  return pid !== null && pid === state.serverPid ? state : { ...state, active: [], next: undefined };
}
export async function runningPid(): Promise<number | null> { try { const value = JSON.parse(await readFile(paths().server, 'utf8')) as { pid?: number }; if (!value.pid) return null; process.kill(value.pid, 0); return value.pid; } catch { return null; } }
