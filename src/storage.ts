import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { codexUserId } from './auth.js';
import type { OAuthCredential, PersistedState, ProviderId, StoredAccount, StoredSessionBindings, TeamAIConfig } from './types.js';

export function dataDir(): string {
  return process.env.TEAMAI_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teamai');
}
export const paths = () => ({ config: join(dataDir(), 'config.json'), credentials: join(dataDir(), 'credentials.json'), state: join(dataDir(), 'state.json'), server: join(dataDir(), 'server.json'), sessions: join(dataDir(), 'sessions.json') });

export function defaultConfig(): TeamAIConfig {
  return { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, controlPort: 3556, clientToken: `tai-${randomBytes(24).toString('base64url')}` }, switchThreshold: 0.98, warmup: { enabled: true, claude: true, codex: true }, maxConcurrentPerAccount: 16, codexCapacityEnabled: true, codexCapacityRetryMs: 500, codexCapacityPreambleHoldMs: 500, codexCapacityRotation: false, accounts: [] };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}

// Each write gets a temporary file of its own: two saves of one file used to
// share `<file>.<pid>.tmp`, so the second overwrote the first's half-written
// copy and the first rename then failed or moved the wrong bytes into place.
async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

// A lock older than this is from a process that died holding it: every hold is
// one read, one change and one write.
const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 10;

async function staleLock(lock: string): Promise<boolean> {
  try {
    const [text, info] = await Promise.all([readFile(lock, 'utf8'), stat(lock)]);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
    const pid = Number(text);
    // Still being written by its owner: only its age can make it stale.
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch { return false; }
}

// `<file>.lock`, created exclusively, is held across processes (the server's
// saves, the dashboard, a CLI command) for the whole read/change/write.
async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try { const handle = await open(lock, 'wx', 0o600); try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); } break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await staleLock(lock)) await rm(lock, { force: true }); else await delay(LOCK_POLL_MS);
    }
  }
  try { return await run(); } finally { await rm(lock, { force: true }); }
}

// Changes to one file run one at a time: queued in this process, and behind the
// lock file between processes. Without it a server save that read the file
// before a login or a delete wrote it back as it was, losing the login or
// bringing the deleted account back.
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(path: string, run: () => Promise<T>): Promise<T> {
  const locked = (): Promise<T> => withFileLock(path, run);
  const next = (queues.get(path) ?? Promise.resolve()).then(locked, locked);
  const tail = next.then(() => {}, () => {}); queues.set(path, tail);
  return next.finally(() => { if (queues.get(path) === tail) queues.delete(path); });
}

export function updateCredentials(update: (credentials: Record<string, OAuthCredential>) => void | Promise<void>): Promise<void> {
  const path = paths().credentials;
  return serialized(path, async () => { const current = await readJson<Record<string, OAuthCredential>>(path, {}); await update(current); await atomicWrite(path, current); });
}

// config.json read, changed and written under the same lock. A change that
// returns false writes nothing; the result says whether it was written.
export function updateConfig(change: (config: TeamAIConfig) => void | false | Promise<void | false>): Promise<boolean> {
  const path = paths().config;
  return serialized(path, async () => { const config = await readJson(path, defaultConfig()); if (await change(config) === false) return false; await atomicWrite(path, config); return true; });
}

export async function loadConfig(): Promise<TeamAIConfig> { return readJson(paths().config, defaultConfig()); }
export async function saveConfig(config: TeamAIConfig): Promise<void> { const path = paths().config; await serialized(path, () => atomicWrite(path, config)); }
export async function loadCredentials(): Promise<Record<string, OAuthCredential>> { return readJson(paths().credentials, {}); }
export async function saveCredentials(value: Record<string, OAuthCredential>): Promise<void> { const path = paths().credentials; await serialized(path, () => atomicWrite(path, value)); }
export async function loadState(): Promise<PersistedState> { return readJson(paths().state, { version: 1, accounts: {}, events: [] }); }
export async function saveState(value: PersistedState): Promise<void> { await atomicWrite(paths().state, value); }

export function validateSessionBindings(raw: unknown): StoredSessionBindings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Corrupt session bindings: root must be an object');
  }
  const result: StoredSessionBindings = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Corrupt session binding for "${key}": entry must be an object`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.sessionId !== 'string' || !entry.sessionId) {
      throw new Error(`Corrupt session binding for "${key}": missing or invalid sessionId`);
    }
    if (entry.provider !== 'claude' && entry.provider !== 'codex') {
      throw new Error(`Corrupt session binding for "${key}": invalid provider "${String(entry.provider)}"`);
    }
    if (typeof entry.accountId !== 'string' || !entry.accountId) {
      throw new Error(`Corrupt session binding for "${key}": missing or invalid accountId`);
    }
    if (typeof entry.boundAt !== 'number' || !Number.isFinite(entry.boundAt)) {
      throw new Error(`Corrupt session binding for "${key}": invalid boundAt timestamp`);
    }
    result[key] = {
      sessionId: entry.sessionId,
      provider: entry.provider,
      accountId: entry.accountId,
      credentialId: typeof entry.credentialId === 'string' ? entry.credentialId : undefined,
      boundAt: entry.boundAt,
    };
  }
  return result;
}

export async function loadSessions(): Promise<StoredSessionBindings> {
  const path = paths().sessions;
  try {
    const text = await readFile(path, 'utf8');
    return validateSessionBindings(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Strict load failed on ${path}: ${(error as Error).message}`);
  }
}

export function updateSessions(change: (bindings: StoredSessionBindings) => void | false | Promise<void | false>): Promise<boolean> {
  const path = paths().sessions;
  return serialized(path, async () => {
    let bindings: StoredSessionBindings = {};
    try {
      const text = await readFile(path, 'utf8');
      bindings = validateSessionBindings(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Strict load failed on ${path}: ${(error as Error).message}`);
      }
    }
    if (await change(bindings) === false) return false;
    await atomicWrite(path, validateSessionBindings(bindings));
    return true;
  });
}


// The key a stored account is known by: the account id, plus the user for a
// Codex workspace that several members share.
export function accountKey(credential: OAuthCredential): string {
  return credential.userId ? `${credential.accountId}:${credential.userId}` : credential.accountId;
}

// Codex accounts stored before the user joined the key are keyed by the
// workspace alone. Such a record is adopted only when it holds the same user;
// another member of that workspace gets a row of their own instead of
// overwriting it.
function legacyAccount(config: TeamAIConfig, credentials: Record<string, OAuthCredential>, provider: ProviderId, label: string, credential: OAuthCredential): StoredAccount | undefined {
  if (!credential.userId) return undefined;
  return config.accounts.find((a) => {
    if (a.provider !== provider || a.id !== credential.accountId) return false;
    // The held token's user decides when it has one; the label (an email) is
    // only a fallback, since two members without an email claim share a label.
    const held = credentials[a.credentialId]; const heldUser = held ? codexUserId(held.accessToken) : null;
    return heldUser ? heldUser === credential.userId : a.label === label;
  });
}

export async function upsertAccount(provider: ProviderId, label: string, credential: OAuthCredential): Promise<StoredAccount> {
  let saved!: StoredAccount;
  await updateConfig(async (config) => {
    const credentials = await loadCredentials();
    const key = accountKey(credential);
    const existing = config.accounts.find((a) => a.provider === provider && a.id === key) || legacyAccount(config, credentials, provider, label, credential);
    const credentialId = existing?.credentialId || `${provider}:${key}`;
    const account: StoredAccount = existing || { id: key, provider, label, enabled: true, priority: null, credentialId, createdAt: new Date().toISOString() };
    // A migrated record keeps its credentialId, so its saved usage history stays attached.
    account.id = key;
    account.label = label || account.label;
    if (!existing) config.accounts.push(account);
    await updateCredentials((current) => { current[credentialId] = credential; });
    saved = account;
  });
  return saved;
}

export async function removeAccount(credentialId: string): Promise<boolean> {
  const removed = await updateConfig((config) => {
    const before = config.accounts.length;
    config.accounts = config.accounts.filter((account) => account.credentialId !== credentialId);
    if (config.accounts.length === before) return false;
  });
  if (removed) await updateCredentials((current) => { delete current[credentialId]; });
  return removed;
}
