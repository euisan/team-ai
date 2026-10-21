import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyConfig, describeApply } from '../src/config-apply.js';
import { anyPorts, startOnAnyPorts } from './server-ports.js';
import { defaultConfig, loadConfig, saveConfig } from '../src/storage.js';

// What the dashboard does after an account write: reload a running server in
// place, start one only when none is running. A throwaway TEAMAI_HOME; the
// server, when there is one, runs in this process with no background work.

const TOKEN = 'local-test-token';


async function home() {
  const root = await mkdtemp(join(tmpdir(), 'teamai-apply-'));
  const previous = process.env.TEAMAI_HOME; process.env.TEAMAI_HOME = root;
  const config = defaultConfig();
  config.proxy = { ...config.proxy, ...anyPorts, clientToken: TOKEN };
  config.warmup = { enabled: false }; config.externalUsage = { enabled: false };
  config.accounts = [{ id: 'x', provider: 'codex', label: 'x@example.com', enabled: true, priority: null, credentialId: 'codex:x', createdAt: '' }];
  await saveConfig(config);
  await writeFile(join(root, 'credentials.json'), JSON.stringify({ 'codex:x': { accessToken: 'synthetic', refreshToken: null, expiresAt: Date.now() + 86_400_000, accountId: 'x' } }));
  const restore = async () => { if (previous === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = previous; await rm(root, { recursive: true, force: true }); };
  return { root, config, restore };
}

const never = async (): Promise<void> => { throw new Error('started a server while one was running'); };

test('with no server running, applying starts one', async () => {
  const h = await home(); let started = 0;
  try {
    assert.deepEqual(await applyConfig(async () => { started++; }), { status: 'started' });
    assert.equal(started, 1);
  } finally { await h.restore(); }
});

test('with a server running, applying reloads it in place and never restarts it', async () => {
  const h = await home();
  const server = await startOnAnyPorts(h.config);
  try {
    const config = await loadConfig(); config.accounts[0]!.priority = 1; await saveConfig(config);
    const outcome = await applyConfig(never);
    assert.equal(outcome.status, 'applied');
    assert.equal(describeApply(outcome), 'applied');

    config.accounts[0]!.enabled = 'on' as never; await saveConfig(config);
    const refused = await applyConfig(never);
    assert.deepEqual(refused, { status: 'refused', error: 'accounts[0]: enabled must be true or false' });
    assert.match(describeApply(refused), /refused it and kept its settings: accounts\[0\]: enabled/);
  } finally { await server.stop(); await h.restore(); }
});

test('a running server too old to reload says to restart it once', async () => {
  const h = await home();
  const old = createServer((_req, res) => { res.writeHead(404).end('{}'); });
  await new Promise<void>((r) => old.listen(0, '127.0.0.1', r)); const address = old.address(); assert(address && typeof address !== 'string');
  h.config.proxy.controlPort = address.port; await saveConfig(h.config);
  await writeFile(join(h.root, 'server.json'), JSON.stringify({ pid: process.pid }));
  try {
    const outcome = await applyConfig(never);
    assert.equal(outcome.status, 'failed');
    assert.match(describeApply(outcome), /run teamai restart once/);
  } finally { old.close(); await h.restore(); }
});
