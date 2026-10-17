import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TeamAIConfig } from '../src/types.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const account = (id: string, provider: string) => ({ id, provider, label: `${id}@example.com`, enabled: true, priority: null, credentialId: `cred-${id}`, createdAt: '' });

async function home(): Promise<{ root: string; run: (...args: string[]) => { status: number | null; out: string; err: string }; config: () => Promise<TeamAIConfig & { other?: string }> }> {
  const root = await mkdtemp(join(tmpdir(), 'teamai-route-cli-'));
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, proxy: { host: '127.0.0.1', claudePort: 1, codexPort: 2, clientToken: 'tok' }, other: 'kept', accounts: [account('a', 'codex'), account('b', 'codex'), account('c', 'claude')] }));
  return {
    root,
    run: (...args) => { const r = spawnSync(process.execPath, ['--import', 'tsx', cli, 'route', ...args], { env: { ...process.env, TEAMAI_HOME: root }, encoding: 'utf8' }); return { status: r.status, out: r.stdout, err: r.stderr }; },
    config: async () => JSON.parse(await readFile(join(root, 'config.json'), 'utf8')),
  };
}

test('route add / list / rm through the CLI', async () => {
  const { run, config } = await home();
  let r = run('add', 'luna', '--provider', 'codex', '--match', 'gpt-6-luna*, gpt-6-sol', '--accounts', 'a@example.com,b', '--mode', 'exclusive', '--color', 'blue');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /Added codex route luna: server not running — applies when it starts/);
  assert.deepEqual((await config()).routes?.codex, [{ name: 'luna', match: ['gpt-6-luna*', 'gpt-6-sol'], accounts: ['a@example.com', 'b@example.com'], mode: 'exclusive', color: 'blue' }], 'an id is stored as its label');
  assert.equal((await config()).other, 'kept');

  r = run('add', 'opus', '--match', 'claude-opus-*', '--accounts', 'c'); assert.equal(r.status, 0, r.err);
  assert.deepEqual((await config()).routes?.claude, [{ name: 'opus', match: ['claude-opus-*'], accounts: ['c@example.com'], mode: 'prefer' }], '--provider defaults to claude');

  r = run('add', 'luna', '--provider', 'codex', '--match', 'gpt-6-luna*', '--accounts', 'ghost'); assert.equal(r.status, 0, r.err);
  assert.match(r.out, /warning: account ghost not found among codex accounts/); assert.match(r.out, /Updated codex route luna/);
  assert.equal((await config()).routes?.codex?.length, 1, 'same name: replaced in place');

  r = run('list');
  assert.match(r.out, /Routes \(claude\) — first match wins:\n {2}1\. opus \[prefer\]: claude-opus-\* → c@example\.com/);
  assert.match(r.out, /Routes \(codex\) — first match wins:\n {2}1\. luna \[prefer\]: gpt-6-luna\* → ghost/);

  r = run('rm', 'luna'); assert.equal(r.status, 0, r.err); assert.match(r.out, /Removed codex route luna/);
  assert.deepEqual((await config()).routes?.codex, []);
  r = run('rm', 'luna'); assert.equal(r.status, 1); assert.match(r.err, /Route not found: luna/);
});

test('route add refuses what the server would refuse, and writes nothing', async () => {
  const { run, config } = await home(); const before = JSON.stringify(await config());
  for (const args of [['add', 'x', '--match', '', '--accounts', 'a'], ['add', 'x', '--match', '*', '--accounts', 'a', '--mode', 'strict'], ['add', 'x', '--match', '*', '--accounts', 'a', '--color', 'pink'], ['add', 'x', '--provider', 'gemini', '--match', '*', '--accounts', 'a']]) {
    const r = run(...args); assert.equal(r.status, 1, args.join(' ')); assert.match(r.err, /teamai: (route x: |Provider must)/);
  }
  assert.equal(JSON.stringify(await config()), before);
});
