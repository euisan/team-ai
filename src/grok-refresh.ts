// Refreshing Grok's sign-in with its refresh token, so the usage box does not
// go 'expired' just because the grok CLI has not been opened for six hours.
//
// The file belongs to the grok CLI, which refreshes it itself under a blocking
// flock(2) on `auth.json.lock` and re-reads tokens another process saved. A
// refresh token spent or overwritten wrongly sends its owner back to a browser
// login, so this takes the same lock, re-reads the file under it (and does
// nothing if someone else already refreshed), and replaces the file
// atomically. Everything that can fail locally (the lock, reading, the
// temporary file) is done before the token request; after it, only writing
// remains. Any failure leaves auth.json as it was.
//
// Node has no flock, so the lock is held by a child process: util-linux
// `flock(1)` running `cat`, or where that is missing (macOS) perl's flock,
// which is flock(2) too. The child answers on stdout once it holds the lock
// and keeps it until its stdin closes — so the lock also goes when this
// process dies. Tokens, the refresh token and response bodies are never put
// in a reason, a log, or a child's command line or environment.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const GROK_EARLY_MS = 5 * 60_000;
export const GROK_RETRY_MS = 10 * 60_000;
const DEFAULT_ISSUER = 'https://auth.x.ai';

export interface GrokRefreshDeps {
  fetch?: typeof fetch;
  now?: () => number;
  // How long to wait for the CLI to let go of the lock.
  lockWaitMs?: number;
  // Which helper holds the lock; by default flock(1), then perl.
  lockCommand?: 'flock' | 'perl';
  // Failure back-off per auth file; shared by default.
  refreshState?: Map<string, { retryAt: number; reason: string }>;
  rename?: (from: string, to: string) => Promise<void>;
}

export type GrokRefreshOutcome = { ok: true; auth: Record<string, unknown>; refreshed: boolean } | { ok: false; reason: string };

class Failure extends Error { constructor(readonly reason: string) { super(reason); } }

const sharedState = new Map<string, { retryAt: number; reason: string }>();
const inFlight = new Map<string, Promise<GrokRefreshOutcome>>();

const text = (entry: unknown, key: string): string | null => {
  const value = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' && value ? value : null;
};
const expiresAt = (entry: unknown): number | null => { const at = Date.parse(text(entry, 'expires_at') ?? ''); return Number.isFinite(at) ? at : null; };
export const grokExpiring = (entry: unknown, now: number): boolean => { const at = expiresAt(entry); return at !== null && at - GROK_EARLY_MS <= now; };
// Whether a refresh can be tried at all: without these the CLI has to.
export const grokRefreshable = (entry: unknown): boolean => text(entry, 'refresh_token') !== null && text(entry, 'oidc_client_id') !== null;

// Refresh the sign-in `entryName` in `authPath` if it is (still) expiring.
// At most one attempt runs per file; after a failure the next waits ten minutes.
export function refreshGrokSignIn(authPath: string, entryName: string, deps: GrokRefreshDeps = {}): Promise<GrokRefreshOutcome> {
  const state = deps.refreshState ?? sharedState; const now = deps.now?.() ?? Date.now();
  const last = state.get(authPath);
  if (last && last.retryAt > now) return Promise.resolve({ ok: false, reason: last.reason });
  const running = inFlight.get(authPath); if (running) return running;
  const attempt = (async (): Promise<GrokRefreshOutcome> => {
    try { const outcome = await refreshUnderLock(authPath, entryName, deps); state.delete(authPath); return outcome; } catch (error) {
      const reason = error instanceof Failure ? error.reason : 'refresh failed';
      state.set(authPath, { retryAt: (deps.now?.() ?? Date.now()) + GROK_RETRY_MS, reason }); return { ok: false, reason };
    } finally { inFlight.delete(authPath); }
  })();
  inFlight.set(authPath, attempt); return attempt;
}

async function refreshUnderLock(authPath: string, entryName: string, deps: GrokRefreshDeps): Promise<GrokRefreshOutcome> {
  const lockPath = `${authPath}.lock`;
  try { await (await open(lockPath, 'a', 0o600)).close(); } catch { throw new Failure('refresh failed: no auth lock'); }
  const release = await holdLock(lockPath, deps.lockWaitMs ?? 15_000, deps.lockCommand);
  try {
    // The CLI writes `pid:epoch` into the lock file; so do we. In place: the
    // lock is on this inode.
    try { const lock = await open(lockPath, 'r+'); try { await lock.truncate(0); await lock.write(`${process.pid}:${Math.floor(Date.now() / 1000)}`, 0); } finally { await lock.close(); } } catch { /* the content is informational */ }
    let raw: string; let auth: Record<string, unknown>;
    try { raw = await readFile(authPath, 'utf8'); auth = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Failure('refresh failed: auth.json unreadable'); }
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Failure('refresh failed: auth.json unreadable');
    const entry = auth[entryName];
    const now = deps.now?.() ?? Date.now();
    if (!entry || typeof entry !== 'object' || !text(entry, 'key')) throw new Failure('signed out — run grok login');
    // Someone else (the CLI) refreshed while we waited: use theirs.
    if (!grokExpiring(entry, now)) return { ok: true, auth, refreshed: false };
    const refreshToken = text(entry, 'refresh_token'); const clientId = text(entry, 'oidc_client_id');
    if (!refreshToken || !clientId) throw new Failure('no refresh token — run grok to refresh');
    if (!losslessNumbers(raw)) throw new Failure('refresh failed: auth.json cannot be rewritten safely');
    const tokenUrl = await tokenEndpoint(text(entry, 'oidc_issuer') ?? DEFAULT_ISSUER, deps);
    // Opened before the request, so a full disk or a read-only directory
    // stops us before the refresh token is spent.
    const tmpPath = join(dirname(authPath), `.auth.json.teamai-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
    let tmp; try { tmp = await open(tmpPath, 'wx', 0o600); } catch { throw new Failure('refresh failed: cannot write next to auth.json'); }
    let saved = false;
    try {
      await tmp.chmod(0o600);
      const tokens = await requestTokens(tokenUrl, refreshToken, clientId, deps);
      const next = { ...(entry as Record<string, unknown>), key: tokens.accessToken, ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}), ...(tokens.expiresAt !== null ? { expires_at: rfc3339Like(tokens.expiresAt, (entry as Record<string, unknown>).expires_at) } : {}) };
      const updated = { ...auth, [entryName]: next };
      const indent = /^\{[ \t]*\r?\n([ \t]+)"/.exec(raw)?.[1] ?? '';
      try {
        await tmp.writeFile(JSON.stringify(updated, null, indent || undefined) + (raw.endsWith('\n') ? '\n' : ''), 'utf8');
        await tmp.sync(); await tmp.close(); tmp = null;
        await (deps.rename ?? rename)(tmpPath, authPath); saved = true;
      } catch { throw new Failure('refresh failed: could not save auth.json'); }
      try { const dir = await open(dirname(authPath), 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch { /* not every platform syncs a directory */ }
      if (tokens.expiresAt === null) throw new Failure('refreshed, but no expiry was given');
      return { ok: true, auth: updated, refreshed: true };
    } finally {
      if (tmp) await tmp.close().catch(() => {});
      if (!saved) await unlink(tmpPath).catch(() => {});
    }
  } finally { await release(); }
}

async function tokenEndpoint(issuer: string, deps: GrokRefreshDeps): Promise<string> {
  const base = trustedUrl(issuer); if (!base) throw new Failure('refresh failed: unexpected issuer');
  let response: Response;
  try { response = await (deps.fetch ?? fetch)(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }); } catch { throw new Failure('refresh failed: discovery request failed'); }
  if (!response.ok) throw new Failure(`refresh failed: discovery HTTP ${response.status}`);
  let endpoint: unknown; try { endpoint = ((await response.json()) as Record<string, unknown>)?.token_endpoint; } catch { throw new Failure('refresh failed: unexpected discovery response'); }
  // The refresh token goes nowhere but the issuer's own origin.
  const url = typeof endpoint === 'string' ? trustedUrl(endpoint) : null;
  if (!url || url.origin !== base.origin) throw new Failure('refresh failed: unexpected token endpoint');
  return url.href;
}

// https, or plain http to this machine (a test server).
function trustedUrl(value: string): URL | null {
  try { const url = new URL(value); return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ? url : null; } catch { return null; }
}

async function requestTokens(url: string, refreshToken: string, clientId: string, deps: GrokRefreshDeps): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number | null }> {
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(), signal: AbortSignal.timeout(15_000) });
  } catch { throw new Failure('refresh failed: token request failed'); }
  let body: unknown = null; try { body = await response.json(); } catch { /* not JSON */ }
  if (!response.ok) {
    if ((response.status === 400 || response.status === 401) && text(body, 'error') === 'invalid_grant') throw new Failure('refresh token rejected — run grok login');
    throw new Failure(`refresh failed: token HTTP ${response.status}`);
  }
  const accessToken = text(body, 'access_token'); if (!accessToken) throw new Failure('refresh failed: unexpected token response');
  const now = deps.now?.() ?? Date.now();
  const expiresIn = body && typeof body === 'object' ? (body as Record<string, unknown>).expires_in : undefined;
  const seconds = typeof expiresIn === 'number' ? expiresIn : typeof expiresIn === 'string' ? Number(expiresIn) : NaN;
  return { accessToken, refreshToken: text(body, 'refresh_token'), expiresAt: Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : jwtExpiry(accessToken) };
}

function jwtExpiry(token: string): number | null {
  try { const exp = (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown }).exp; return typeof exp === 'number' && exp > 0 ? exp * 1000 : null; } catch { return null; }
}

// Written the way the CLI writes it: the same number of fractional digits
// (nanoseconds by default), in UTC.
export function rfc3339Like(at: number, previous: unknown): string {
  const iso = new Date(at).toISOString();
  const shape = typeof previous === 'string' ? /(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(previous) : null;
  const digits = shape ? Math.min(9, shape[1]?.length ?? 0) : 9;
  return iso.slice(0, 19) + (digits ? `.${(iso.slice(20, 23) + '000000').slice(0, digits)}` : '') + (shape?.[2] === '+00:00' ? '+00:00' : 'Z');
}

// Whether parsing and writing the file back keeps every number: an integer
// beyond 2^53 would come back changed, so such a file is left to the CLI.
export function losslessNumbers(raw: string): boolean {
  const number = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '"') { for (i++; i < raw.length && raw[i] !== '"'; i++) if (raw[i] === '\\') i++; continue; }
    if (c !== '-' && (c < '0' || c > '9')) continue;
    number.lastIndex = i; const match = number.exec(raw); if (!match) return false;
    if (!match[1] && !match[2] && !Number.isSafeInteger(Number(match[0]))) return false;
    i += match[0].length - 1;
  }
  return true;
}

const PERL_LOCK = 'use Fcntl qw(:flock); use Time::HiRes qw(sleep time); open(my $f, "<", $ARGV[0]) or exit 2; my $end = time + $ARGV[1]; until (flock($f, LOCK_EX | LOCK_NB)) { exit 1 if time >= $end; sleep 0.05 } $| = 1; print "x\\n"; 1 while <STDIN>;';

// Resolves, holding an exclusive flock on `lockPath`, to a function that lets
// it go; fails after `waitMs`.
export async function holdLock(lockPath: string, waitMs: number, command?: 'flock' | 'perl'): Promise<() => Promise<void>> {
  if (command) return spawnLock(command, lockPath, waitMs);
  try { return await spawnLock('flock', lockPath, waitMs); } catch (error) {
    if (!(error instanceof Failure) || error.reason !== 'missing') throw error;
    try { return await spawnLock('perl', lockPath, waitMs); } catch (again) { throw again instanceof Failure && again.reason === 'missing' ? new Failure('refresh failed: no flock or perl to lock with') : again; }
  }
}

function spawnLock(command: 'flock' | 'perl', lockPath: string, waitMs: number): Promise<() => Promise<void>> {
  const seconds = String(Math.max(0.05, waitMs / 1000));
  const args = command === 'flock' ? ['-x', '-w', seconds, lockPath, 'cat'] : ['-e', PERL_LOCK, lockPath, seconds];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false; let exited = false;
    const exit = new Promise<void>((done) => child.once('close', () => { exited = true; done(); }));
    const fail = (reason: string) => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(new Failure(reason)); };
    const timer = setTimeout(() => fail('refresh failed: auth lock busy'), waitMs + 5_000);
    child.once('error', (error) => fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'refresh failed: could not lock'));
    child.once('exit', (code) => fail(code === 1 ? 'refresh failed: auth lock busy' : 'refresh failed: could not lock'));
    child.stdin.on('error', () => {});
    child.stdout.once('data', () => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve(async () => {
        child.stdin.end();
        const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
        if (!exited) await exit; clearTimeout(force);
      });
    });
    // `cat` answers by echoing this, once flock(1) has the lock; perl answers on its own.
    child.stdin.write('x\n');
  });
}
