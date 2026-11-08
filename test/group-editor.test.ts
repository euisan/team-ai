import assert from 'node:assert/strict';
import test from 'node:test';
import { groupEditorKey, openGroupEditor, type GroupEditor } from '../src/group-editor.js';
import { pressGroupKey } from '../src/tui.js';
import { defaultConfig, loadConfig, saveConfig } from '../src/storage.js';
import type { StoredAccount } from '../src/types.js';

const account = (id: string, provider: 'claude' | 'codex' = 'claude'): StoredAccount => ({ id, provider, label: `${id}@example.test`, enabled: true, priority: null, credentialId: id, createdAt: '' });
const config = () => ({ accounts: [account('lead'), account('backup'), account('codex', 'codex')], groups: { team: ['lead@example.test'] } });
const type = (text: string): string[] => [...text];
function press(editor: GroupEditor, ...keys: string[]): { editor: GroupEditor; save?: ReturnType<typeof groupEditorKey>['save'] } {
  let save: ReturnType<typeof groupEditorKey>['save'];
  for (const key of keys) { const result = groupEditorKey(editor, key); editor = result.editor; save = result.save; }
  return { editor, save };
}

test('group name keys create, rename and delete valid non-empty Claude groups', () => {
  let result = press(openGroupEditor({ accounts: config().accounts, groups: {} }), 'a', ...type('workers'), '\r');
  assert.deepEqual(Object.fromEntries(Object.entries(result.save?.groups ?? {})), { workers: ['lead@example.test'] }, 'creation seeds the selected Claude roster with one member');
  const editor = result.editor;
  result = press(editor, 'e', '\x7f', '\x7f', '\x7f', '\x7f', '\x7f', '\x7f', '\x7f', ...type('team2'), '\r');
  assert.deepEqual(Object.fromEntries(Object.entries(result.save?.groups ?? {})), { team2: ['lead@example.test'] });
  result = press(result.editor, 'd', 'y');
  assert.deepEqual(result.save?.groups, {});
});

test('membership keys add and remove Claude accounts and refuse the last member', () => {
  const editor = openGroupEditor(config());
  let result = press(editor, 'm', 'j', ' ', '\r');
  assert.deepEqual(result.save?.groups, { team: ['lead@example.test', 'backup@example.test'] });
  result = press(result.editor, 'm', 'j', ' ', '\r');
  assert.deepEqual(result.save?.groups, { team: ['lead@example.test'] });
  result = press(result.editor, 'm', ' ');
  assert.equal(result.save, undefined);
  assert.match(result.editor.error ?? '', /must keep at least one account/);
});

test('invalid names are rejected by parseGroups and Codex membership explains the refusal', () => {
  let result = press(openGroupEditor({ accounts: config().accounts, groups: {} }), 'a', ...type('bad!'), '\r');
  assert.equal(result.save, undefined);
  assert.match(result.editor.error ?? '', /Invalid group name/);
  result = press(openGroupEditor(config()), 'm', 'j', 'j', ' ');
  assert.equal(result.save, undefined);
  assert.match(result.editor.error ?? '', /Codex.*Claude group/);
});

test('the TUI key path writes the changed groups once and invokes live apply', async () => {
  const stored = defaultConfig(); Object.assign(stored, config()); await saveConfig(stored);
  let editor = openGroupEditor(stored); let applied = 0;
  editor = (await pressGroupKey(editor, 'm'))!;
  editor = (await pressGroupKey(editor, 'j'))!;
  editor = (await pressGroupKey(editor, ' '))!;
  assert.deepEqual((await loadConfig()).groups, { team: ['lead@example.test'] }, 'membership is staged until Enter');
  await pressGroupKey(editor, '\r', async () => {}, async () => { applied++; });
  assert.deepEqual((await loadConfig()).groups, { team: ['lead@example.test', 'backup@example.test'] });
  assert.equal(applied, 1);
});
