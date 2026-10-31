import assert from 'node:assert/strict';
import test from 'node:test';
import { stripAnsi } from '../src/columns.js';
import { buildFrame, displayOrder, frozenOrder, normalKeys, orderOptions, type FrameView } from '../src/frame.js';
import type { PersistedState, StoredAccount, TeamAIConfig } from '../src/types.js';

const account = (id: string, priority: number | null = null): StoredAccount => ({ id, provider: 'codex', label: `${id}@example.com`, enabled: true, priority, credentialId: `cred-${id}`, createdAt: '' });

const accounts = (ids: string[], priorities: Record<string, number> = {}): StoredAccount[] => ids.map((id) => account(id, priorities[id] ?? null));

const config = (list: StoredAccount[]): TeamAIConfig => ({ version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'synthetic' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: list });

// Weekly Codex windows, so displayOrder sorts on the pace each account has
// used: a is behind, b is ahead, and a priority pin puts b in front.
function stateFor(usage: Record<string, number>): PersistedState {
  const saved: PersistedState['accounts'] = {};
  for (const [id, used] of Object.entries(usage)) saved[`cred-${id}`] = { usage: used, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { secondary: { usage: used, resetsAt: null, minutes: 10_080 } } };
  return { version: 1, accounts: saved };
}

const view = (overrides: Partial<FrameView> = {}): FrameView => ({ width: 120, selectedId: 'cred-a', mode: 'order', message: '', sortByHeadroom: true, ...overrides });

// The account rows in the order the wide frame draws them.
function rowOrder(lines: string[]): string[] {
  return lines.map(stripAnsi).filter((line) => line.includes('@example.com')).map((line) => /(\w+)@example\.com/.exec(line)![1]!);
}

test('the normal dashboard no longer offers or handles session launch keys', () => {
  const keys = normalKeys(false, true);
  assert.ok(!keys.includes('1 Claude')); assert.ok(!keys.includes('2 Codex'));
  const normal = buildFrame(config(accounts(['a', 'b'])), stateFor({ a: 0.2, b: 0.8 }), view({ mode: 'normal' })).join('\n');
  assert.doesNotMatch(normal, /1 Claude|2 Codex/);
  const help = buildFrame(config(accounts(['a', 'b'])), stateFor({ a: 0.2, b: 0.8 }), view({ mode: 'help' })).join('\n');
  assert.doesNotMatch(help, /1 Claude|2 Codex/);
  // Logging in from add mode keeps its own 1/2 keys.
  const add = buildFrame(config(accounts(['a', 'b'])), stateFor({ a: 0.2, b: 0.8 }), view({ mode: 'add' })).join('\n');
  assert.match(add, /1 Claude login/); assert.match(add, /2 Codex login/);
});

test('a priority change does not reorder the rows while order mode holds them', () => {
  const state = stateFor({ a: 0.2, b: 0.8 });
  const before = config(accounts(['a', 'b']));
  assert.deepEqual(displayOrder(before.accounts, state, true, orderOptions(before)).map((a) => a.id), ['a', 'b']);
  const frozen = ['cred-a', 'cred-b'];
  assert.deepEqual(rowOrder(buildFrame(before, state, view({ frozen }))), ['a', 'b']);

  const changed = config(accounts(['a', 'b'], { b: 1 }));
  assert.deepEqual(displayOrder(changed.accounts, state, true, orderOptions(changed)).map((a) => a.id), ['b', 'a']);
  assert.deepEqual(rowOrder(buildFrame(changed, state, view({ frozen }))), ['a', 'b']);
});

test('leaving order mode drops the freeze and the frame sorts live again', () => {
  const state = stateFor({ a: 0.2, b: 0.8 });
  const changed = config(accounts(['a', 'b'], { b: 1 }));
  assert.deepEqual(rowOrder(buildFrame(changed, state, view({ mode: 'normal' }))), ['b', 'a']);
  // A leftover freeze list does nothing outside order mode.
  assert.deepEqual(rowOrder(buildFrame(changed, state, view({ mode: 'normal', frozen: ['cred-a', 'cred-b'] }))), ['b', 'a']);
});

test('an account added while frozen joins at the end and a removed one disappears', () => {
  const all = accounts(['a', 'b', 'c']);
  assert.deepEqual(frozenOrder(all, ['cred-b', 'cred-a']).map((a) => a.id), ['b', 'a', 'c']);
  assert.deepEqual(frozenOrder(all, ['cred-b', 'cred-gone', 'cred-a']).map((a) => a.id), ['b', 'a', 'c']);
  assert.deepEqual(frozenOrder(accounts(['a', 'c']), ['cred-b', 'cred-a']).map((a) => a.id), ['a', 'c']);

  const state = stateFor({ a: 0.2, b: 0.8, c: 0.5 });
  assert.deepEqual(rowOrder(buildFrame(config(all), state, view({ frozen: ['cred-a', 'cred-b'] }))), ['a', 'b', 'c']);
  assert.deepEqual(rowOrder(buildFrame(config(accounts(['a', 'c'])), state, view({ frozen: ['cred-a', 'cred-b'] }))), ['a', 'c']);
});
