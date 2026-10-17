import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { accountLabel, applyRoutes, saveRoutes } from '../src/route-config.js';
import type { StoredAccount } from '../src/types.js';

const base = { version: 1, proxy: { host: '127.0.0.1', claudePort: 1, codexPort: 2, controlPort: 3, clientToken: 'tok' }, switchThreshold: 0.98, custom: { keep: [1, 2] }, accounts: [{ id: 'a', provider: 'codex', label: 'a@example.com', enabled: true, priority: null, credentialId: 'cred-a', createdAt: '' }], routes: { claude: [{ name: 'opus', match: ['claude-opus-*'], accounts: [0] }] } };

async function home(config: unknown = base): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teamai-route-config-')); process.env.TEAMAI_HOME = root;
  await writeFile(join(root, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o644 });
  return root;
}

test('saving replaces only routes.<provider>, through a 0600 temp file renamed into place', async () => {
  const root = await home(); const path = join(root, 'config.json');
  const before = await stat(path);
  try {
    await saveRoutes('codex', [{ name: 'luna', match: ['gpt-6-luna*'], accounts: ['a@example.com'], mode: 'prefer', color: 'blue' }]);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    const { routes, ...rest } = saved; const { routes: baseRoutes, ...baseRest } = base;
    assert.deepEqual(rest, baseRest, 'every other key exactly as it was');
    assert.deepEqual(routes.claude, baseRoutes.claude, 'the other provider\'s routes untouched');
    assert.deepEqual(routes.codex, [{ name: 'luna', match: ['gpt-6-luna*'], accounts: ['a@example.com'], mode: 'prefer', color: 'blue' }]);
    const after = await stat(path);
    assert.notEqual(after.ino, before.ino, 'a new file renamed over the old one, not rewritten in place');
    assert.equal(after.mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), ['config.json'], 'no temp file left behind');
  } finally { delete process.env.TEAMAI_HOME; }
});

test('an invalid list is refused with the startup validator\'s message and nothing is written', async () => {
  const root = await home(); const path = join(root, 'config.json'); const original = await readFile(path, 'utf8');
  try {
    await assert.rejects(saveRoutes('codex', [{ name: 'x', match: [], accounts: ['a'] }]), /route x: match must be a non-empty list/);
    await assert.rejects(saveRoutes('codex', [{ name: 'x', match: ['*'], accounts: ['a'] }, { name: 'x', match: ['y'], accounts: ['a'] }]), /duplicate route name "x"/);
    await assert.rejects(applyRoutes('codex', [{ name: 'x', match: ['*'], accounts: ['a'], color: 'pink' as never }]), /route x: color/);
    assert.equal(await readFile(path, 'utf8'), original);
  } finally { delete process.env.TEAMAI_HOME; }
});

test('applying asks a running server to reload, and keeps the saved file when it cannot', async () => {
  const root = await home(); let status = 200; const calls: string[] = [];
  const server = createServer((req, res) => { calls.push(`${req.method} ${req.url} ${req.headers.authorization}`); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? { routes: { codex: 1 }, warnings: [] } : { error: 'boom' })); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert(address && typeof address !== 'string');
  const route = { name: 'luna', match: ['gpt-6-luna*'], accounts: ['a@example.com'] };
  try {
    assert.deepEqual(await applyRoutes('codex', [route]), { status: 'not-running' }, 'no server.json: saved for the next start');
    await writeFile(join(root, 'config.json'), JSON.stringify({ ...base, proxy: { ...base.proxy, controlPort: address.port } }));
    await writeFile(join(root, 'server.json'), JSON.stringify({ pid: process.pid }));
    assert.deepEqual(await applyRoutes('codex', [route]), { status: 'applied', warnings: [] });
    assert.deepEqual(calls, ['POST /routes/reload Bearer tok']);
    status = 400;
    assert.deepEqual(await applyRoutes('codex', [{ ...route, name: 'luna2' }]), { status: 'failed', error: 'boom' });
    assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).routes.codex[0].name, 'luna2', 'the valid file stays saved');
  } finally { server.close(); delete process.env.TEAMAI_HOME; }
});

test('account references are stored by label when they name an account', () => {
  const accounts = ['a', 'b'].map((id): StoredAccount => ({ id, provider: 'codex', label: `${id}@example.com`, enabled: true, priority: null, credentialId: `cred-${id}`, createdAt: '' }));
  assert.equal(accountLabel(accounts, 'codex', 'b'), 'b@example.com');
  assert.equal(accountLabel(accounts, 'codex', 'cred-a'), 'a@example.com');
  assert.equal(accountLabel(accounts, 'codex', 1), 'b@example.com');
  assert.equal(accountLabel(accounts, 'codex', 'ghost'), 'ghost');
  assert.equal(accountLabel(accounts, 'claude', 'a'), 'a', 'another provider\'s account is not this one');
});

test('a TUI snapshot refuses to overwrite a route changed by the CLI', async () => {
  const root = await home();
  try {
    const original = [{ name: 'cli', match: ['gpt-*'], accounts: ['a@example.com'] }];
    await saveRoutes('codex', original);
    await assert.rejects(
      saveRoutes('codex', [{ name: 'tui', match: ['gpt-*'], accounts: ['a@example.com'] }], []),
      /routes\.codex changed while you were editing/,
    );
    assert.deepEqual(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).routes.codex, original);
  } finally { delete process.env.TEAMAI_HOME; }
});

test('an exclusive route with no configured account is refused before writing', async () => {
  const root = await home(); const before = await readFile(join(root, 'config.json'), 'utf8');
  try {
    await assert.rejects(saveRoutes('codex', [{ name: 'locked', match: ['gpt-*'], accounts: ['missing@example.com'], mode: 'exclusive' }]), /exclusive route must include a configured codex account/);
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), before);
  } finally { delete process.env.TEAMAI_HOME; }
});
