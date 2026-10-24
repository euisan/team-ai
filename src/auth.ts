import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { mkdtemp } from 'node:fs/promises';
import type { OAuthCredential, ProviderId } from './types.js';

function expand(path: string): string { return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path); }
function decodeJwt(token: string): Record<string, unknown> { try { const part = token.split('.')[1]; return part ? JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown> : {}; } catch { return {}; } }
function stringAt(value: unknown, key: string): string | null { return value && typeof value === 'object' && typeof (value as Record<string, unknown>)[key] === 'string' ? (value as Record<string, string>)[key]! : null; }

export async function importAuth(provider: ProviderId, from?: string): Promise<Array<{ label: string; credential: OAuthCredential }>> {
  const path = expand(from || (provider === 'claude' ? '~/.claude/.credentials.json' : join(process.env.CODEX_HOME || '~/.codex', 'auth.json')));
  let contents: string;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) {
    if (!from && (error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No reusable ${provider} credential file was found. Run "teamai login" instead.`);
    throw error;
  }
  const raw = JSON.parse(contents) as Record<string, unknown>;
  if (provider === 'claude') {
    if (Array.isArray(raw.accounts)) {
      const accounts = raw.accounts.flatMap((entry) => {
        const data = entry as Record<string, unknown>;
        if (typeof data.accessToken !== 'string' || typeof data.accountUuid !== 'string') return [];
        return [{ label: typeof data.name === 'string' ? data.name : data.accountUuid, credential: { accessToken: data.accessToken, refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : null, expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null, accountId: data.accountUuid } }];
      });
      if (!accounts.length) throw new Error('No OAuth accounts found in TeamClaude config');
      return accounts;
    }
    const data = (raw.claudeAiOauth || raw) as Record<string, unknown>;
    if (typeof data.accessToken !== 'string') throw new Error('Claude accessToken is missing');
    const profile = await claudeProfile(data.accessToken);
    return [{ label: profile.label, credential: { accessToken: data.accessToken, refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : null, expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null, accountId: profile.id } }];
  }
  const tokens = (raw.tokens || raw) as Record<string, unknown>;
  if (typeof tokens.access_token !== 'string') throw new Error('Codex access_token is missing');
  const idClaims = decodeJwt(typeof tokens.id_token === 'string' ? tokens.id_token : tokens.access_token);
  const auth = idClaims['https://api.openai.com/auth'];
  const accountId = typeof tokens.account_id === 'string' ? tokens.account_id : stringAt(auth, 'chatgpt_account_id') || stringAt(auth, 'account_id');
  if (!accountId) throw new Error('Codex account_id is missing');
  const exp = decodeJwt(tokens.access_token).exp;
  const userId = codexUserId(tokens.access_token, typeof tokens.id_token === 'string' ? tokens.id_token : undefined);
  return [{ label: stringAt(idClaims, 'email') || accountId, credential: { accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null, expiresAt: typeof exp === 'number' ? exp * 1000 : null, accountId, ...(userId ? { userId } : {}) } }];
}

// The ChatGPT user a Codex token belongs to. The access token is read first so
// a credential stored without its id_token resolves to the same value later.
export function codexUserId(accessToken: string, idToken?: string): string | null {
  for (const token of [accessToken, idToken]) {
    if (!token) continue;
    const claims = decodeJwt(token); const auth = claims['https://api.openai.com/auth'];
    const id = stringAt(auth, 'chatgpt_user_id') || stringAt(auth, 'user_id') || stringAt(claims, 'sub');
    if (id) return id;
  }
  return null;
}

async function claudeProfile(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; label: string }> {
  const response = await fetchImpl('https://api.anthropic.com/api/oauth/profile', { headers: { authorization: `Bearer ${accessToken}`, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Claude profile failed (${response.status})`);
  const value = await response.json() as { account?: { uuid?: string; email?: string } };
  if (!value.account?.uuid) throw new Error('Claude account UUID is missing');
  return { id: value.account.uuid, label: value.account.email || value.account.uuid };
}

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Where `--manual` sends the browser: Anthropic's page that shows the code to copy.
export const CLAUDE_MANUAL_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';

export interface ClaudeLoginOptions {
  // No callback server: the browser lands on the code page and the code is pasted.
  manual?: boolean;
  // Whether a pasted redirect URL or code is read alongside the callback. Off
  // for a caller that owns stdin (the dashboard); defaults to whether stdin is a TTY.
  interactive?: boolean;
  input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream;
  fetch?: typeof fetch; openBrowser?: (url: string) => void;
}

// The authorization code in what the user pasted: the whole redirect URL from
// the address bar, the code page's `code#state`, or the bare code. A state
// that is present must be ours; a bare code has none to check, and PKCE still
// ties it to this login's verifier. Blank input is null; anything unusable throws.
export function parseAuthCode(input: string, expectedState: string): string | null {
  const text = input.trim(); if (!text) return null;
  let code: string | null; let state: string | null;
  if (/^https?:\/\//i.test(text)) {
    let url: URL; try { url = new URL(text); } catch { throw new Error('That URL could not be read'); }
    code = url.searchParams.get('code'); state = url.searchParams.get('state');
    if (!code) throw new Error(url.searchParams.get('error') ? `Authorization failed: ${url.searchParams.get('error')}` : 'That URL has no authorization code');
  } else {
    const hash = text.indexOf('#');
    code = (hash >= 0 ? text.slice(0, hash) : text).trim(); state = hash >= 0 ? text.slice(hash + 1).trim() || null : null;
    if (!code) throw new Error('No authorization code before "#"');
  }
  if (state !== null && state !== expectedState) throw new Error('OAuth state mismatch — that code belongs to a different login');
  return code;
}

// The loopback listener the browser returns to. Only a request carrying our
// state settles the login: anything else on this briefly open port (a stale
// tab, a page probing localhost) gets a 400 and the login keeps waiting.
async function callbackServer(state: string): Promise<{ port: number; code: Promise<string>; close: () => void }> {
  let resolveCode!: (code: string) => void; let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/callback') { res.writeHead(404).end('Not found'); return; }
    if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid callback'); return; }
    const error = url.searchParams.get('error');
    if (error) { res.end('TeamAI login failed. You may close this tab.'); rejectCode(new Error(`Claude authorization failed: ${error}`)); return; }
    const value = url.searchParams.get('code');
    if (!value) { res.writeHead(400).end('Invalid callback'); return; }
    res.end('TeamAI login complete. You may close this tab.'); resolveCode(value);
  });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address(); if (!address || typeof address === 'string') { server.close(); throw new Error('Failed to bind OAuth callback'); }
  return { port: address.port, code, close: () => { server.close(); server.closeAllConnections(); } };
}

// The first of the browser callback and a pasted redirect URL or code. A paste
// that fails to parse is reported and asked for again; whichever way wins, the
// prompt is released. Without a callback (`--manual`) the end of input fails the login.
function pastedOrCallback(callback: Promise<string> | null, state: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream, prompt: string): Promise<string> {
  return new Promise<string>((resolveCode, rejectCode) => {
    const lines = createInterface({ input, output, terminal: (input as { isTTY?: boolean }).isTTY === true && (output as { isTTY?: boolean }).isTTY === true });
    let settled = false;
    const settle = (finish: () => void): void => { if (settled) return; settled = true; lines.close(); finish(); };
    lines.on('line', (line) => {
      if (settled) return;
      let code: string | null; try { code = parseAuthCode(line, state); } catch (error) { output.write(`${(error as Error).message}. Paste it again.\n`); lines.prompt(); return; }
      if (code) settle(() => resolveCode(code)); else lines.prompt();
    });
    lines.on('SIGINT', () => settle(() => rejectCode(new Error('Login cancelled'))));
    lines.on('close', () => { if (!settled && !callback) settle(() => rejectCode(new Error('No authorization code provided'))); });
    callback?.then((code) => settle(() => resolveCode(code)), (error: Error) => settle(() => rejectCode(error)));
    lines.setPrompt(prompt); lines.prompt();
  });
}

export async function loginClaude(options: ClaudeLoginOptions = {}): Promise<{ label: string; credential: OAuthCredential }> {
  const input = options.input ?? process.stdin; const output = options.output ?? process.stderr; const fetchImpl = options.fetch ?? fetch;
  const verifier = randomBytes(32).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url'); const state = randomBytes(32).toString('base64url');
  const callback = options.manual ? null : await callbackServer(state);
  // The token exchange must name the same redirect_uri the code was issued for.
  const redirect = callback ? `http://localhost:${callback.port}/callback` : CLAUDE_MANUAL_REDIRECT_URI;
  const url = new URL('https://claude.ai/oauth/authorize');
  for (const [k, v] of Object.entries({ code: 'true', client_id: CLAUDE_CLIENT_ID, response_type: 'code', redirect_uri: redirect, scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload', code_challenge: challenge, code_challenge_method: 'S256', state })) url.searchParams.set(k, v);
  let authorizationCode: string;
  try {
    if (!callback) {
      output.write(`Open this URL in a browser on any device:\n${url}\n\nAfter you approve, copy the code the page shows.\n`);
      authorizationCode = await pastedOrCallback(null, state, input, output, 'Paste the code (or the full redirect URL): ');
    } else {
      (options.openBrowser ?? openBrowser)(url.toString()); output.write(`Open this URL if the browser did not open:\n${url}\n`);
      if (options.interactive ?? (input as { isTTY?: boolean }).isTTY === true) {
        output.write('If the browser is on another machine, it ends on a page that cannot load: copy that address bar URL and paste it here.\n');
        authorizationCode = await pastedOrCallback(callback.code, state, input, output, 'Paste the redirect URL or code (or wait for the browser): ');
      } else authorizationCode = await callback.code;
    }
  } finally { callback?.close(); }
  const response = await fetchImpl('https://platform.claude.com/v1/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: authorizationCode, state, grant_type: 'authorization_code', client_id: CLAUDE_CLIENT_ID, redirect_uri: redirect, code_verifier: verifier }) });
  if (!response.ok) throw new Error(`Claude token exchange failed (${response.status})`);
  const tokens = await response.json() as Record<string, unknown>; const accessToken = String(tokens.access_token); const profile = await claudeProfile(accessToken, fetchImpl);
  return { label: profile.label, credential: { accessToken, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000, accountId: profile.id } };
}

// `deviceAuth` passes `--device-auth` to `codex login`, which prints a code to
// enter on any device instead of waiting for a browser on this machine.
export async function loginCodex(options: { deviceAuth?: boolean } = {}): Promise<{ label: string; credential: OAuthCredential }> {
  const home = await mkdtemp(join(tmpdir(), 'teamai-codex-login-'));
  try {
    const exit = await new Promise<number>((resolveExit, reject) => { const child = spawn('codex', options.deviceAuth ? ['login', '--device-auth'] : ['login'], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: home } }); child.once('error', reject); child.once('exit', (code) => resolveExit(code ?? 1)); });
    if (exit !== 0) throw new Error(`codex login exited with ${exit}`);
    return (await importAuth('codex', join(home, 'auth.json')))[0]!;
  } finally { await rm(home, { recursive: true, force: true }); }
}

// A machine without a browser opener (a headless remote host) is fine: the URL is printed too.
function openBrowser(url: string): void { const command = platform() === 'darwin' ? 'open' : 'xdg-open'; const child = spawn(command, [url], { detached: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref(); }
