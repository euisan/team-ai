// The control-port route for model routes: re-read routes.claude / routes.codex
// from config.json and swap them into the running pools, so a route edited in
// the dashboard or with `teamai route` applies without a restart. Same gate as
// the rest of the control port: loopback only, and the client token.
//
// The lists go through parseRoutes, the function startup uses, and both are
// parsed before either is swapped in, so a malformed file changes nothing. A
// request already in flight holds the Route object it matched and keeps it;
// only requests that start after the swap see the new lists.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountPool } from './account-pool.js';
import { secureEqual } from './proxy.js';
import { isLoopback } from './reset-credit-control.js';
import { parseRoutes } from './routes.js';
import { loadConfig } from './storage.js';

export const ROUTE_RELOAD_PATH = '/routes/reload';

function send(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

// Returns false when the URL is not this route. onReload gets the account
// warnings (as startup prints them) so the caller can log them.
export async function handleRouteControl(req: IncomingMessage, res: ServerResponse, pools: AccountPool[], token: string, onReload: (warnings: string[], counts: Record<string, number>) => void = () => {}): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== ROUTE_RELOAD_PATH) return false;
  if (!isLoopback(req.socket.remoteAddress)) { send(res, 403, { error: 'local only' }); return true; }
  const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  if (!secureEqual(given, token)) { send(res, 401, { error: 'unauthorized' }); return true; }
  if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
  let parsed: ReturnType<typeof parseRoutes>[];
  try {
    const config = await loadConfig();
    parsed = pools.map((pool) => parseRoutes(config.routes?.[pool.provider.id], pool.provider.id));
  } catch (error) { send(res, 400, { error: (error as Error).message }); return true; }
  const warnings = pools.flatMap((pool, index) => pool.setRoutes(parsed[index]!).map((warning) => `${pool.provider.label} ${warning}`));
  const counts = Object.fromEntries(pools.map((pool, index) => [pool.provider.id, parsed[index]!.length]));
  onReload(warnings, counts);
  send(res, 200, { routes: counts, warnings });
  return true;
}
