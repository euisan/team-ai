import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertTestHome, listeningPorts } from './isolation.js';
import { dataDir } from '../src/storage.js';

// The guard in test/isolation.ts, proved on stand-ins: a child process loads
// it with a fake "real home" and the ports of a listener this test owns, and
// tries every forbidden thing there. Nothing here touches the real home or the
// relay even when the guard is broken: the targets are all fakes.

const here = fileURLToPath(new URL('.', import.meta.url));
const probe = join(here, 'isolation-probe.ts');

async function fakes() {
  const realHome = await mkdtemp(join(tmpdir(), 'teamai-guard-real-'));
  const settings = join(realHome, '.config', 'teamai'); const install = join(realHome, '.local', 'share', 'team-ai');
  await mkdir(settings, { recursive: true }); await mkdir(install, { recursive: true });
  await writeFile(join(settings, 'config.json'), 'real settings'); await writeFile(join(install, 'cli.js'), 'real install');
  const link = join(tmpdir(), `teamai-guard-link-${process.pid}-${Date.now()}`); await symlink(settings, link);
  // Stands in for the relay: any connection that reaches it is a breach.
  const reached: string[] = [];
  const relay = createServer((req, res) => { reached.push(String(req.url)); res.end('relay'); });
  relay.on('connection', () => reached.push('connection'));
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r)); const address = relay.address(); assert(address && typeof address !== 'string');
  const cleanup = async () => { relay.close(); await rm(link, { force: true }); await rm(realHome, { recursive: true, force: true }); };
  return { realHome, settings, install, link, relayPort: address.port, reached, cleanup };
}

async function run(f: Awaited<ReturnType<typeof fakes>>, mode: 'probe' | 'swallow') {
  // Not a subtest of this runner: the child reports in plain text.
  const inherited = { ...process.env }; delete inherited.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', join(here, 'isolation.ts'), probe], {
    cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, TEAMAI_TEST_REAL_HOME: f.realHome, TEAMAI_TEST_FORBIDDEN_PORTS: String(f.relayPort), PROBE_MODE: mode, PROBE_SETTINGS: f.settings, PROBE_INSTALL: f.install, PROBE_LINK: f.link, PROBE_PORT: String(f.relayPort) },
  });
  let output = ''; child.stdout.on('data', (c: Buffer) => { output += c.toString(); }); child.stderr.on('data', (c: Buffer) => { output += c.toString(); });
  const [status] = await once(child, 'close') as [number | null];
  const line = output.split('\n').find((l) => l.startsWith('PROBE '));
  return { status, output, outcomes: line ? JSON.parse(line.slice(6)) as Record<string, string> : {} };
}

test('the isolation guard blocks the real home, the relay ports, fixed ports and the network before any I/O', { timeout: 60_000 }, async (t) => {
  const f = await fakes(); t.after(f.cleanup);
  const { status, output, outcomes } = await run(f, 'probe');
  assert.equal(status, 0, output);
  assert.deepEqual(outcomes, {
    unsetHome: 'blocked', homeInRealHome: 'blocked', homeLinkedIntoRealHome: 'blocked',
    readSettings: 'blocked', writeInstall: 'blocked', readThroughLink: 'blocked', syncRead: 'blocked',
    listenRelayPort: 'blocked', listenFixedPort: 'blocked', connectRelayPort: 'blocked', fetchRelayPort: 'blocked', connectOffMachine: 'blocked',
    tempHomeWorks: 'allowed', listenAnyPort: 'allowed',
  }, output);
  assert.deepEqual(f.reached, [], 'nothing reached the stand-in relay');
  assert.equal(await readFile(join(f.settings, 'config.json'), 'utf8'), 'real settings');
  assert.equal(await readFile(join(f.install, 'cli.js'), 'utf8'), 'real install');
});

test('a breach that the code under test swallows still fails the test that made it', { timeout: 60_000 }, async (t) => {
  const f = await fakes(); t.after(f.cleanup);
  const { status, output } = await run(f, 'swallow');
  assert.notEqual(status, 0, output);
  assert.match(output, /Test isolation was breached/);
  assert.equal(await readFile(join(f.settings, 'config.json'), 'utf8'), 'real settings');
});

test('every test gets its own temporary TEAMAI_HOME, and this process holds only port-0 listeners', () => {
  const home = dataDir();
  assert.equal(assertTestHome(home), home);
  assert.match(home, /teamai-test-case-/);
  assert.deepEqual(listeningPorts(), []);
});
