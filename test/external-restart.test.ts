import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ExternalUsageMonitor, externalUsageSettings, type ExternalUsage } from '../src/external-usage.js';
import { buildFrame } from '../src/frame.js';
import { startServer } from '../src/runtime.js';
import { defaultConfig, loadState } from '../src/storage.js';
import type { PersistedState, TeamAIConfig } from '../src/types.js';

// A server restart (`teamai restart`, or a start after a stop; account changes
// made in the dashboard no longer restart it). The new process used to start
// with no other-agent readings and save that, so the Antigravity, OpenCode Go
// and Grok boxes vanished until its first read came back seconds later. These
// run the real server in a throwaway TEAMAI_HOME with no background work:
// nothing here reads another app's sign-in or reaches the network.

const TOKEN = 'local-test-token';
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (line: string): string => line.replace(ANSI, '');

async function freePort(): Promise<number> {
  const probe = createServer(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const address = probe.address(); assert(address && typeof address !== 'string');
  await new Promise<void>((r) => probe.close(() => r())); return address.port;
}

const reading = (provider: ExternalUsage['provider'], name: string, used: number, at: number): ExternalUsage => ({ provider, status: 'ok', identity: null, groups: [{ name, windows: [{ label: 'wk', minutes: 10_080, usedPercent: used, resetsAt: null }] }], note: null, measuredAt: at, lastOkAt: at });
const saved = (at: number): NonNullable<PersistedState['external']> => ({ antigravity: reading('antigravity', 'Gemini Models', 38, at), opencodeGo: reading('opencodeGo', 'OpenCode Go', 29, at), grok: reading('grok', 'Grok', 12, at) });

const SEEDED = Date.now() - 60_000;

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'teamai-external-'));
  const previous = process.env.TEAMAI_HOME; process.env.TEAMAI_HOME = root;
  const config = defaultConfig();
  config.proxy = { ...config.proxy, claudePort: await freePort(), codexPort: await freePort(), controlPort: await freePort(), clientToken: TOKEN };
  config.warmup = { enabled: false };
  config.accounts = [
    { id: 'c', provider: 'claude', label: 'c@example.com', enabled: true, priority: null, credentialId: 'claude:c', createdAt: '' },
    { id: 'x', provider: 'codex', label: 'x@example.com', enabled: true, priority: null, credentialId: 'codex:x', createdAt: '' },
  ];
  const writeConfig = (next: TeamAIConfig) => writeFile(join(root, 'config.json'), JSON.stringify(next));
  await writeConfig(config);
  await writeFile(join(root, 'credentials.json'), JSON.stringify({ 'claude:c': { accessToken: 'synthetic', refreshToken: null, expiresAt: null }, 'codex:x': { accessToken: 'synthetic', refreshToken: null, expiresAt: null, accountId: 'x' } }));
  await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, accounts: {}, events: [], external: saved(SEEDED) }));
  const restore = async () => { if (previous === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = previous; await rm(root, { recursive: true, force: true }); };
  return { root, config, writeConfig, restore };
}

const otherAgents = (config: TeamAIConfig, state: PersistedState): string[] => buildFrame(config, state, { width: 110, height: 60, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true })
  .map(plain).filter((line) => /^┌─ (Antigravity|OpenCode Go|Grok)/.test(line) || /^ {2}(Gemini Models|OpenCode Go|Grok) /.test(line)).map((line) => line.trimEnd());

test('the other agents stay on every frame while Claude and Codex accounts change and the server restarts', async () => {
  const h = await home();
  try {
    const expected = otherAgents(h.config, { version: 1, accounts: {}, external: saved(SEEDED) });
    assert.equal(expected.length, 6, expected.join('\n'));
    // Switch, disable, re-enable, re-rank: each is a config write and a restart.
    const changes: Array<(c: TeamAIConfig) => void> = [(c) => { c.accounts[1]!.priority = 1; }, (c) => { c.accounts[0]!.enabled = false; }, (c) => { c.accounts[0]!.enabled = true; }, (c) => { c.accounts[1]!.priority = null; }];
    for (const change of changes) {
      change(h.config); await h.writeConfig(h.config);
      const server = await startServer({ background: false });
      await server.stop();
      const state = await loadState();
      assert.deepEqual(otherAgents(h.config, state), expected, 'a restart wiped the other agents');
      assert.equal(state.external?.grok?.groups[0]?.windows[0]?.usedPercent, 12);
    }
  } finally { await h.restore(); }
});

test('a provider switched off in config is the only box a restart removes', async () => {
  const h = await home();
  try {
    h.config.externalUsage = { providers: { opencodeGo: false } }; await h.writeConfig(h.config);
    const server = await startServer({ background: false }); await server.stop();
    const state = JSON.parse(await readFile(join(h.root, 'state.json'), 'utf8')) as PersistedState;
    assert.deepEqual(Object.keys(state.external ?? {}).sort(), ['antigravity', 'grok']);
    const lines = otherAgents(h.config, state);
    assert.ok(lines.some((l) => l.startsWith('┌─ Grok')) && lines.some((l) => l.startsWith('┌─ Antigravity')));
    assert.equal(lines.some((l) => l.includes('OpenCode Go')), false);
  } finally { await h.restore(); }
});

test('restored readings survive a failed refresh as cached figures and are replaced by the next good one', async () => {
  let now = 2_000_000; let next: ExternalUsage | null = null;
  const none = async () => null;
  const monitor = new ExternalUsageMonitor({ ...externalUsageSettings({}), providers: { antigravity: false, opencodeGo: false, grok: true } }, { now: () => now }, { antigravity: none, opencodeGo: none, grok: async () => next });
  monitor.restore(saved(now - 60_000));
  assert.deepEqual(Object.keys(monitor.usage), ['grok'], 'disabled providers are not restored');
  next = { provider: 'grok', status: 'error', identity: null, groups: [], note: 'HTTP 500', measuredAt: now, lastOkAt: null };
  await monitor.tick(true);
  assert.equal(monitor.usage.grok?.status, 'error'); assert.equal(monitor.usage.grok?.groups[0]?.windows[0]?.usedPercent, 12, 'last good figures kept');
  now += 60_000; next = reading('grok', 'Grok', 40, now); await monitor.tick(true);
  assert.equal(monitor.usage.grok?.status, 'ok'); assert.equal(monitor.usage.grok?.groups[0]?.windows[0]?.usedPercent, 40);
  // Junk in state.json is ignored rather than drawn.
  const fresh = new ExternalUsageMonitor(externalUsageSettings({}));
  fresh.restore({ grok: { provider: 'antigravity' } as unknown as ExternalUsage, antigravity: null as unknown as ExternalUsage });
  assert.deepEqual(fresh.usage, {});
});
