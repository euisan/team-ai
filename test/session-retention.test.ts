import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AccountPool } from '../src/account-pool.js';
import { openGroupEditor } from '../src/group-editor.js';
import { parseGroups } from '../src/groups.js';
import { claudeProvider } from '../src/providers.js';
import { pruneInactiveClaudeSessions } from '../src/session-retention.js';
import {
  defaultConfig,
  issueClaudeSession,
  loadConfig,
  loadSessions,
  saveConfig,
  SESSION_TOUCH_INTERVAL_MS,
  touchSessionBinding,
  updateSessions,
} from '../src/storage.js';
import { pressGroupKey } from '../src/tui.js';
import type { OAuthCredential, Provider, StoredAccount } from '../src/types.js';

const DAY = 86_400_000;
const accounts: StoredAccount[] = [
  { id: 'lead', provider: 'claude', label: 'lead@example.test', enabled: true, priority: null, credentialId: 'claude:lead', createdAt: '' },
  { id: 'backup', provider: 'claude', label: 'backup@example.test', enabled: true, priority: null, credentialId: 'claude:backup', createdAt: '' },
];

async function seedConfig(): Promise<void> {
  const stored = defaultConfig();
  Object.assign(stored, { accounts, groups: { team: ['lead@example.test', 'backup@example.test'] } });
  await saveConfig(stored);
}

async function bind(group: string, accountId: string, options: { boundAt?: number; lastSeenAt?: number } = {}): Promise<string> {
  const id = await issueClaudeSession(group);
  await updateSessions((bindings) => {
    bindings[id] = {
      sessionId: id,
      provider: 'claude',
      group,
      accountId,
      credentialId: `claude:${accountId}`,
      actualAccountId: `uuid-${accountId}`,
      boundAt: options.boundAt ?? Date.now(),
      ...(options.lastSeenAt === undefined ? {} : { lastSeenAt: options.lastSeenAt }),
    };
  });
  return id;
}

// Keys through the real dashboard path: open the group, select the first
// account and remove it, then commit.
async function removeFirstMember(): Promise<{ error?: string } | undefined> {
  let editor = openGroupEditor(await loadConfig());
  editor = (await pressGroupKey(editor, 'm'))!;
  editor = (await pressGroupKey(editor, ' '))!;
  return pressGroupKey(editor, '\r');
}

test('bindings from finished conversations are pruned so a group member can be removed again', async () => {
  await seedConfig();
  const old = Date.now() - 45 * DAY;
  for (let i = 0; i < 3; i++) await bind('team', 'lead', { boundAt: old });
  assert.equal(Object.keys(await loadSessions()).length, 3, 'the stale bindings exist before the edit');

  const after = await removeFirstMember();
  assert.equal(after?.error, undefined, 'stale bindings must not veto the edit');
  assert.deepEqual((await loadConfig()).groups, { team: ['backup@example.test'] });
  assert.deepEqual(Object.keys(await loadSessions()), [], 'the pruned bindings and their ledger records are gone');
});

test('a binding from a session still in use is never pruned or bypassed', async () => {
  await seedConfig();
  const id = await bind('team', 'lead', { boundAt: Date.now() - 45 * DAY, lastSeenAt: Date.now() - 60_000 });

  assert.equal(await pruneInactiveClaudeSessions(), 0, 'recent use protects the binding');
  assert.ok((await loadSessions())[id], 'the live binding survives the sweep');
  const after = await removeFirstMember();
  assert.match(after?.error ?? '', /bound Claude session/);
  assert.deepEqual((await loadConfig()).groups, { team: ['lead@example.test', 'backup@example.test'] });
  assert.ok((await loadSessions())[id], 'a refused edit leaves the binding unchanged');
});

test('a transcript modified recently protects an old binding written before use tracking existed', async () => {
  await seedConfig();
  const old = Date.now() - 45 * DAY;
  const id = await bind('team', 'lead', { boundAt: old });
  const project = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-home-test-project');
  await mkdir(project, { recursive: true });
  const transcript = join(project, `${id}.jsonl`);
  await writeFile(transcript, '{}\n');

  assert.equal(await pruneInactiveClaudeSessions(), 0, 'transcript activity is evidence the conversation is alive');
  assert.ok((await loadSessions())[id]);

  const stale = new Date(old);
  await utimes(transcript, stale, stale);
  assert.equal(await pruneInactiveClaudeSessions(), 1, 'with no activity anywhere the binding is dropped');
  assert.equal((await loadSessions())[id], undefined);
});

test('recording a use is throttled and leaves the ledger consistent', async () => {
  await seedConfig();
  const start = Date.now();
  const id = await bind('team', 'lead', { boundAt: start - DAY });

  assert.equal(await touchSessionBinding(id, start), true);
  assert.equal((await loadSessions())[id]!.lastSeenAt, start);
  assert.equal(await touchSessionBinding(id, start + SESSION_TOUCH_INTERVAL_MS - 1), false, 'inside the interval nothing is written');
  assert.equal(await touchSessionBinding(id, start + SESSION_TOUCH_INTERVAL_MS), true, 'the next interval records again');
  assert.equal((await loadSessions())[id]!.group, 'team', 'the group scope is untouched');
  assert.equal(await touchSessionBinding('unknown-session', start), false);
});

test('a request on an existing binding refreshes its recorded use', async () => {
  await seedConfig();
  const id = await issueClaudeSession('team');
  const provider: Provider = { ...claudeProvider, readQuota: () => null, refresh: async (credential) => credential };
  const credential: OAuthCredential = { accessToken: 'synthetic', refreshToken: null, expiresAt: null, accountId: 'uuid-lead' };
  const pool = new AccountPool(provider, [accounts[0]!], { 'claude:lead': credential }, { version: 1, accounts: {} });
  pool.setGroups(parseGroups((await loadConfig()).groups, accounts));

  const first = await pool.resolveOrBindClaudeSession(id, false);
  assert.equal(first.status, 'ok');
  if (first.account) pool.release(first.account);

  const old = Date.now() - 45 * DAY;
  await updateSessions((bindings) => { bindings[id]!.boundAt = old; delete bindings[id]!.lastSeenAt; });
  const second = await pool.resolveOrBindClaudeSession(id, false);
  assert.equal(second.status, 'ok');
  if (second.account) pool.release(second.account);

  let seen: number | undefined;
  for (let i = 0; i < 50 && seen === undefined; i++) {
    seen = (await loadSessions())[id]?.lastSeenAt;
    if (seen === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(typeof seen === 'number' && seen > old, 'traffic proves the session is alive');
});
