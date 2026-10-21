// Loaded before every test file (package.json `test`): a test cannot reach the
// real install, the real settings or the relay that is serving this machine.
//
// - TEAMAI_HOME is a fresh temporary directory for each test, and reading it
//   while it is unset, in the real home, or a link into it throws.
// - HOME and the client homes point at a temporary directory, so os.homedir()
//   and `~` lead nowhere real.
// - File calls into the real TeamAI, Codex or Claude directories throw before
//   any I/O, symlinks included.
// - Servers listen on port 0 only (or on a port this process already holds, to
//   provoke EADDRINUSE); the relay's ports cannot be bound or connected to, and
//   nothing connects off this machine.
//
// A blocked call throws where it is made and is also recorded: code that
// swallows the error still fails the test that made it, in afterEach.
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

// A second copy would wrap everything twice and keep its own records.
const LOADED = Symbol.for('teamai.test-isolation');
if ((globalThis as Record<symbol, unknown>)[LOADED]) throw new Error('test/isolation.ts was loaded twice');
(globalThis as Record<symbol, unknown>)[LOADED] = true;

// Kept unpatched for the guard's own use.
const realpath = fs.realpathSync.bind(fs);

const inside = (root: string, path: string): boolean => { const tail = relative(root, path); return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)); };

// A path with every existing part resolved through its symlinks.
function resolved(path: string): string {
  let head = resolve(path); const tail: string[] = [];
  for (;;) {
    try { return join(realpath(head), ...tail); } catch {
      const parent = dirname(head); if (parent === head) return resolve(path);
      tail.unshift(head.slice(parent.length).replace(/^[/\\]+/, '')); head = parent;
    }
  }
}

// The real home, plus a stand-in the guard's own test passes to a child.
const homes = [...new Set([homedir(), process.env.TEAMAI_TEST_REAL_HOME].filter((h): h is string => !!h).map(resolved))];
const forbiddenRoots = homes.flatMap((home) => ['.config/teamai', '.local/share/team-ai', '.codex', '.claude'].map((part) => resolved(join(home, part))));
if (process.env.XDG_CONFIG_HOME) forbiddenRoots.push(resolved(join(process.env.XDG_CONFIG_HOME, 'teamai')));
// The relay's ports: the built-in defaults and the ones this machine runs on.
const forbiddenPorts = new Set([3456, 3457, 3556, 3466, 3467, 3566, ...(process.env.TEAMAI_TEST_FORBIDDEN_PORTS ?? '').split(',').filter(Boolean).map(Number)]);
const temporary = resolved(tmpdir());

const violations: string[] = [];
function violate(what: string): never {
  violations.push(what);
  throw Object.assign(new Error(`Test isolation: ${what}`), { code: 'ETEAMAI_ISOLATION' });
}
// For the guard's own test: the violations so far, cleared.
export function takeViolations(): string[] { return violations.splice(0); }

export function assertTestHome(value: string | undefined): string {
  if (!value || !isAbsolute(value)) violate('TEAMAI_HOME must be an absolute temporary directory');
  const real = resolved(value);
  if (homes.some((home) => inside(home, real)) || !inside(temporary, real) || real === temporary) violate(`TEAMAI_HOME ${value} is not a temporary directory outside the real home`);
  return value;
}

function checkPath(value: unknown): void {
  if (typeof value !== 'string' && !(value instanceof URL) && !Buffer.isBuffer(value)) return;
  const path = value instanceof URL ? (value.protocol === 'file:' ? fileURLToPath(value) : '') : value.toString();
  if (!path) return;
  const real = resolved(path);
  if (forbiddenRoots.some((root) => inside(root, real) || inside(root, resolve(path)))) violate(`file access to ${path}`);
}

// Every call that takes a path. The two-path calls (rename, copy, link) check both.
const pathCalls = ['access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchown', 'link', 'lstat', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'];
const twoPaths = new Set(['copyFile', 'cp', 'link', 'rename', 'symlink']);
function guard(target: Record<string, unknown>, name: string, two: boolean): void {
  const original = target[name];
  if (typeof original !== 'function') return;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown { checkPath(args[0]); if (two) checkPath(args[1]); return (original as (...a: unknown[]) => unknown).apply(this, args); };
  // Keep fs.realpath.native, fs.exists' promisify hook and the like.
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
  target[name] = wrapped;
}
const fsTable = fs as unknown as Record<string, unknown>;
for (const name of pathCalls) {
  guard(fsTable, name, twoPaths.has(name)); guard(fsTable, `${name}Sync`, twoPaths.has(name));
  guard(fs.promises as unknown as Record<string, unknown>, name, twoPaths.has(name));
}
for (const name of ['createReadStream', 'createWriteStream', 'exists', 'existsSync', 'watch', 'watchFile']) guard(fsTable, name, false);
syncBuiltinESMExports();

// Ports this process is listening on: binding one again only provokes
// EADDRINUSE, which is what a test of a port conflict wants.
const held = new Set<number>();
export function listeningPorts(): number[] { return [...held].sort((a, b) => a - b); }
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  const first = args[0];
  const options = first && typeof first === 'object' && !(first instanceof net.Server) ? first as net.ListenOptions : undefined;
  if (options?.path) checkPath(options.path);
  if (typeof first === 'string' && !/^\d+$/.test(first)) checkPath(first);
  const raw = options ? options.port : typeof first === 'number' || typeof first === 'string' ? first : undefined;
  const port = raw === undefined || raw === null ? 0 : Number(raw);
  if (forbiddenPorts.has(port)) violate(`listen on the relay's port ${port}`);
  if (port !== 0 && !held.has(port)) violate(`listen on fixed port ${port}; tests listen on port 0`);
  this.once('listening', () => {
    const address = this.address(); if (!address || typeof address === 'string') return;
    held.add(address.port); this.once('close', () => held.delete(address.port));
  });
  return (listen as (...a: unknown[]) => net.Server).apply(this, args);
} as typeof listen;

const loopback = (host: string): boolean => host === 'localhost' || host === '::1' || /^(?:::ffff:)?127\./.test(host);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  // net.connect hands over its already-normalized [options, callback].
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  const options = (first && typeof first === 'object' ? first : typeof first === 'number' || /^\d+$/.test(String(first)) ? { port: first, host: args[1] } : { path: first }) as { port?: unknown; host?: unknown; path?: unknown };
  if (options.path !== undefined && options.port === undefined) checkPath(options.path);
  else {
    const port = Number(options.port); const host = typeof options.host === 'string' && options.host ? options.host.replace(/^\[(.*)\]$/, '$1') : 'localhost';
    if (forbiddenPorts.has(port)) violate(`connection to the relay's port ${port}`);
    if (!loopback(host)) violate(`connection to ${host}:${port}; tests use local fakes`);
  }
  return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof connect;

// Homes for the file, before any application module reads them.
const fakeHome = mkdtempSync(join(tmpdir(), 'teamai-test-home-'));
const fileHome = mkdtempSync(join(tmpdir(), 'teamai-test-file-'));
Object.assign(process.env, { HOME: fakeHome, XDG_CONFIG_HOME: join(fakeHome, '.config'), XDG_DATA_HOME: join(fakeHome, '.local', 'share'), CODEX_HOME: join(fakeHome, '.codex'), CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'), TEAMAI_HOME: fileHome });
const environment = process.env;
// Writes go straight to the real environment, which children inherit.
process.env = new Proxy(environment, {
  get(target, key) { const value = Reflect.get(target, key) as string | undefined; return key === 'TEAMAI_HOME' ? assertTestHome(value) : value; },
  set(target, key, value) { if (typeof key === 'symbol') return false; target[key] = value as string; return true; },
  deleteProperty(target, key) { if (typeof key === 'symbol') return false; delete target[key]; return true; },
});

let testHome = '';
beforeEach(() => { testHome = mkdtempSync(join(tmpdir(), 'teamai-test-case-')); process.env.TEAMAI_HOME = testHome; });
afterEach(() => {
  process.env.TEAMAI_HOME = fileHome; rmSync(testHome, { recursive: true, force: true });
  const found = takeViolations(); if (found.length) throw new Error(`Test isolation was breached:\n  ${found.join('\n  ')}`);
});
process.once('exit', () => {
  rmSync(fileHome, { recursive: true, force: true }); rmSync(fakeHome, { recursive: true, force: true });
  const found = takeViolations(); if (found.length) { console.error(`Test isolation was breached outside a test:\n  ${found.join('\n  ')}`); process.exitCode = 1; }
});
