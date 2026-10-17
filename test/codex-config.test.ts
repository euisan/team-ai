import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'smol-toml';
import { relayedCodexConfig } from '../src/codex-config.js';

test('nested clients inherit relay while preserving model, MCP and project settings', () => {
  const original = `model = "gpt-5.6-luna"
model_provider = "openai"
model_reasoning_effort = "max"
[mcp_servers.example]
command = "node"
args = ["server.js"]
[projects."/tmp/game"]
trust_level = "trusted"
[model_providers.teamai]
base_url = "http://127.0.0.1:1/v1"
requires_openai_auth = true
`;
  const result = relayedCodexConfig(original, '127.0.0.1', 3467);
  const parsed = parse(result);
  assert.equal(parsed.model_provider, 'teamai');
  assert.equal(parsed.model, 'gpt-5.6-luna');
  assert.equal(parsed.model_reasoning_effort, 'max');
  assert.deepEqual(parsed.mcp_servers, parse(original).mcp_servers);
  assert.deepEqual(parsed.projects, parse(original).projects);
  assert.deepEqual(parsed.model_providers, { teamai: {
    name: 'TeamAI Codex Relay', base_url: 'http://127.0.0.1:3467/v1',
    env_key: 'TEAMAI_PROXY_TOKEN', wire_api: 'responses',
    request_max_retries: 0, stream_max_retries: 5, stream_idle_timeout_ms: 1_800_000,
  } });
  assert.equal(relayedCodexConfig(result, '127.0.0.1', 3467), result);
});

test('empty config is supported; invalid config fails instead of falling back to direct auth', () => {
  assert.equal(parse(relayedCodexConfig('', 'localhost', 3457)).model_provider, 'teamai');
  assert.throws(() => relayedCodexConfig('invalid = [', 'localhost', 3457));
});

test('a high-effort turn is not cut mid-reasoning by the default SSE idle timeout', () => {
  // Codex declares a stream dead after stream_idle_timeout_ms with no SSE event
  // (default 300s). gpt-5.6-luna at --effort max routinely thinks for longer
  // than that before its first token, so the default cut live turns and the
  // client reconnected silently — indistinguishable from a hung session
  // (2026-09-20). A nested `codex exec` reads this file, not the -c flags, so
  // the window has to survive here.
  const provider = (parse(relayedCodexConfig('', '127.0.0.1', 3467)).model_providers as Record<string, Record<string, unknown>>).teamai!;
  assert.equal(provider.stream_idle_timeout_ms, 1_800_000);
  // Failover is the relay's job, but a mid-body SSE cut is still the client's
  // to retry: neither may be dropped while widening the idle window.
  assert.equal(provider.request_max_retries, 0);
  assert.equal(provider.stream_max_retries, 5);
});

const hookState = (toml: string): Record<string, { trusted_hash?: string }> => (((parse(toml).hooks ?? {}) as Record<string, unknown>).state ?? {}) as Record<string, { trusted_hash?: string }>;

test('hook trust given in the user\'s home is repeated under the relayed home\'s path', () => {
  const original = `[hooks.state."/o/hooks.json:pre_tool_use:1:0"]
trusted_hash = "h1"
[hooks.state."/o/hooks.json:session_start:0:0"]
trusted_hash = "h2"
[hooks.state."/repo/.codex/hooks.json:stop:0:0"]
trusted_hash = "p1"
`;
  const result = relayedCodexConfig(original, '127.0.0.1', 3457, { originalHome: '/o/', shadowHome: '/s' });
  const state = hookState(result);
  assert.equal(state['/s/hooks.json:pre_tool_use:1:0']?.trusted_hash, 'h1');
  assert.equal(state['/s/hooks.json:session_start:0:0']?.trusted_hash, 'h2');
  assert.equal(state['/o/hooks.json:pre_tool_use:1:0']?.trusted_hash, 'h1', 'the original keys stay');
  assert.equal(state['/repo/.codex/hooks.json:stop:0:0']?.trusted_hash, 'p1', 'project hooks are left alone');
  assert.equal(Object.keys(state).some((key) => key.startsWith('/repo/') && key !== '/repo/.codex/hooks.json:stop:0:0'), false, 'project keys are not copied');
  assert.equal(relayedCodexConfig(result, '127.0.0.1', 3457, { originalHome: '/o', shadowHome: '/s/' }), result, 'idempotent, trailing slashes included');
});

test('trust granted inside a relayed session survives the next launch; the user\'s home wins a conflict', () => {
  const previous = `[hooks.state."/s/hooks.json:stop:0:0"]
trusted_hash = "new"
[hooks.state."/s/hooks.json:pre_tool_use:1:0"]
trusted_hash = "stale"
[hooks.state."/elsewhere/hooks.json:stop:0:0"]
trusted_hash = "x"
`;
  const original = `[hooks.state."/o/hooks.json:pre_tool_use:1:0"]
trusted_hash = "h1"
`;
  const state = hookState(relayedCodexConfig(original, '127.0.0.1', 3457, { originalHome: '/o', shadowHome: '/s', previousShadow: previous }));
  assert.equal(state['/s/hooks.json:stop:0:0']?.trusted_hash, 'new');
  assert.equal(state['/s/hooks.json:pre_tool_use:1:0']?.trusted_hash, 'h1');
  assert.equal(state['/elsewhere/hooks.json:stop:0:0'], undefined, 'only the relayed home\'s own keys are carried');
});

test('no hooks anywhere: nothing added; an unreadable previous file is ignored', () => {
  const plain = relayedCodexConfig('model = "m"\n', '127.0.0.1', 3457, { originalHome: '/o', shadowHome: '/s', previousShadow: 'not = [toml' });
  assert.equal(parse(plain).hooks, undefined);
  assert.equal(plain, relayedCodexConfig('model = "m"\n', '127.0.0.1', 3457));
});

test('hooks.json is linked into the relayed home with the other shared entries, and nothing present is replaced', async () => {
  const { mkdtemp, mkdir, writeFile, readlink, lstat, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { linkShadowEntries, SHADOW_LINKS } = await import('../src/codex-config.js');
  assert.ok(SHADOW_LINKS.includes('hooks.json'));
  const root = await mkdtemp(join(tmpdir(), 'teamai-codex-home-')); const original = join(root, 'o'); const shadow = join(root, 's');
  await mkdir(join(original, 'skills'), { recursive: true }); await mkdir(shadow, { recursive: true });
  await writeFile(join(original, 'hooks.json'), '{"hooks":{}}'); await writeFile(join(original, 'rules'), 'r');
  await writeFile(join(shadow, 'rules'), 'mine');
  const linked = await linkShadowEntries(original, shadow);
  assert.deepEqual(linked, ['skills', 'hooks.json']);
  assert.equal(await readlink(join(shadow, 'hooks.json')), join(original, 'hooks.json'));
  assert.equal((await lstat(join(shadow, 'skills'))).isSymbolicLink(), true);
  assert.equal(await readFile(join(shadow, 'rules'), 'utf8'), 'mine', 'an existing entry is not touched');
  assert.deepEqual(await linkShadowEntries(original, shadow), [], 'second run: nothing to do');
});
