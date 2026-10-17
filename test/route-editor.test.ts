import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildFrame } from '../src/frame.js';
import { openRouteEditor, routeEditorKey, routesOf, type RouteEditor } from '../src/route-editor.js';
import { pressRouteKey } from '../src/tui.js';
import type { StoredAccount, TeamAIConfig } from '../src/types.js';

const UP = '\x1b[A'; const DOWN = '\x1b[B'; const ENTER = '\r'; const ESC = '\x1b'; const BACKSPACE = '\x7f'; const TAB = '\t';
const account = (id: string, provider: 'claude' | 'codex'): StoredAccount => ({ id, provider, label: `${id}@example.com`, enabled: true, priority: null, credentialId: `cred-${id}`, createdAt: '' });

function baseConfig(routes: TeamAIConfig['routes'] = {}): TeamAIConfig & { custom: string } {
  return { version: 1, proxy: { host: '127.0.0.1', claudePort: 1, codexPort: 2, clientToken: 'tok' }, switchThreshold: 0.98, maxConcurrentPerAccount: 16, accounts: [account('c', 'claude'), account('a', 'codex'), account('b', 'codex')], routes, custom: 'kept' };
}

// A throwaway TEAMAI_HOME with no server.json: saves are written, the reload
// reports the server as not running.
async function home(routes: TeamAIConfig['routes'] = {}): Promise<{ read: () => Promise<TeamAIConfig & { custom?: string }>; raw: () => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), 'teamai-route-editor-')); process.env.TEAMAI_HOME = root;
  await writeFile(join(root, 'config.json'), JSON.stringify(baseConfig(routes), null, 2));
  return { read: async () => JSON.parse(await readFile(join(root, 'config.json'), 'utf8')), raw: () => readFile(join(root, 'config.json'), 'utf8') };
}

// Keys as the TUI delivers them: a typed word arrives as one chunk per key.
async function press(editor: RouteEditor | undefined, ...keys: string[]): Promise<RouteEditor | undefined> {
  for (const key of keys) { assert(editor, `editor closed before ${JSON.stringify(key)}`); editor = await pressRouteKey(editor, key); }
  return editor;
}
const type = (text: string): string[] => [...text];

test('adding a route by keys writes it to config.json and leaves every other key alone', async () => {
  const { read } = await home();
  try {
    let editor = openRouteEditor(await read(), 'codex');
    editor = (await press(editor, 'a', ...type('luna'), ENTER, ...type('gpt-6-luna*, gpt-6-sol'), ENTER, ' ', DOWN, ' ', UP, ' ', ENTER, ' ', ENTER, DOWN, DOWN, DOWN, DOWN))!;
    assert.equal(editor.phase, 'edit'); assert.equal(editor.edit?.draft.color, 'blue');
    assert.deepEqual((await read()).routes, {}, 'nothing is written before the last Enter');
    editor = (await press(editor, ENTER))!;
    const saved = await read();
    assert.deepEqual(saved.routes?.codex, [{ name: 'luna', match: ['gpt-6-luna*', 'gpt-6-sol'], accounts: ['b@example.com'], mode: 'exclusive', color: 'blue' }], 'a toggled on, b on, a off again');
    assert.equal(saved.custom, 'kept'); assert.deepEqual(saved.accounts, baseConfig().accounts);
    assert.equal(editor.phase, 'list'); assert.equal(routesOf(editor)[editor.index]?.name, 'luna');
    assert.equal(editor.notice, 'Added route luna — server not running — applies when it starts');
  } finally { delete process.env.TEAMAI_HOME; }
});

test('a save the startup validator refuses is not written and the reason stays on screen', async () => {
  const { read, raw } = await home({ codex: [{ name: 'taken', match: ['x'], accounts: ['a@example.com'] }] }); const before = await raw();
  try {
    // No match pattern.
    let editor = await press(openRouteEditor(await read(), 'codex'), 'a', ...type('luna'), ENTER, ENTER, ' ', ENTER, ENTER, ENTER);
    assert.equal(editor?.phase, 'edit'); assert.match(editor?.error ?? '', /route luna: match must be a non-empty list/);
    // A name that is already used.
    editor = await press(openRouteEditor(await read(), 'codex'), 'a', ...type('taken'), ENTER, '*', ENTER, ' ', ENTER, ENTER, ENTER);
    assert.match(editor?.error ?? '', /duplicate route name "taken"/);
    assert.equal(await raw(), before, 'both refused saves left the file byte-for-byte alone');
    // Fixing the name and saving again works from where the error left off.
    editor = await press(editor, '\x1b[Z', '\x1b[Z', '\x1b[Z', '\x1b[Z', BACKSPACE, ...type('2'), ENTER, ENTER, ENTER, ENTER, ENTER);
    assert.equal(editor?.error, undefined);
    assert.deepEqual((await read()).routes?.codex?.map((r) => r.name), ['taken', 'take2']);
  } finally { delete process.env.TEAMAI_HOME; }
});

test('Esc leaves the editor without saving; delete asks first; reorder saves the new order', async () => {
  const routes = { codex: [{ name: 'one', match: ['a*'], accounts: [1], color: 'red' as const }, { name: 'two', match: ['b*'], accounts: ['a'], mode: 'exclusive' as const }] };
  const { read, raw } = await home(routes); const before = await raw();
  try {
    let editor = await press(openRouteEditor(await read(), 'codex'), 'e', BACKSPACE, BACKSPACE, BACKSPACE, ...type('changed'), ESC);
    assert.equal(editor?.phase, 'list'); assert.equal(editor?.notice, 'Edit cancelled — nothing saved'); assert.equal(await raw(), before);
    editor = await press(editor, 'd', 'n'); assert.equal(editor?.phase, 'list'); assert.equal(await raw(), before);
    editor = await press(editor, ']');
    assert.deepEqual((await read()).routes?.codex?.map((r) => r.name), ['two', 'one'], 'first match wins, so order is saved');
    assert.equal(routesOf(editor!)[editor!.index]?.name, 'one', 'the cursor follows the moved route');
    editor = await press(editor, 'e', ENTER, ENTER, ENTER, ENTER, ENTER);
    assert.deepEqual((await read()).routes?.codex?.[1], { name: 'one', match: ['a*'], accounts: ['b@example.com'], mode: 'prefer', color: 'red' }, 'editing stores a 0-based position as the label it named');
    editor = await press(editor, 'd', 'y');
    assert.deepEqual((await read()).routes?.codex?.map((r) => r.name), ['two']);
    assert.equal(await press(editor, ESC), undefined, 'Esc on the list closes the editor');
    assert.equal((await read()).custom, 'kept');
  } finally { delete process.env.TEAMAI_HOME; }
});

test('the editor shows one provider at a time; Tab switches, accounts are that provider\'s', () => {
  const config = baseConfig({ claude: [{ name: 'opus', match: ['claude-opus-*'], accounts: ['c'] }], codex: [{ name: 'luna', match: 'gpt-6-luna*', accounts: ['ghost', 'a'] }] });
  let editor = openRouteEditor(config, 'claude');
  assert.deepEqual(routesOf(editor).map((r) => r.name), ['opus']);
  editor = routeEditorKey(editor, TAB).editor; assert.equal(editor.provider, 'codex');
  editor = routeEditorKey(editor, 'e').editor;
  assert.deepEqual(editor.edit?.choices, ['a@example.com', 'b@example.com', 'ghost'], 'codex accounts, then the unknown reference kept so editing does not drop it');
  assert.deepEqual(editor.edit?.draft.accounts, ['ghost', 'a@example.com']);
  assert.equal(editor.edit?.draft.match, 'gpt-6-luna*');
});

test('the dashboard draws the editor with the mode meanings and its own key hints', () => {
  const config = baseConfig({ codex: [{ name: 'luna', match: ['gpt-6-luna*'], accounts: ['a@example.com'], color: 'blue' }] });
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'); const plain = (l: string) => l.replace(ANSI, '');
  const view = { width: 100, selectedId: null, mode: 'routes' as const, message: '', sortByHeadroom: false };
  let editor = openRouteEditor(config, 'codex');
  let lines = buildFrame(config, { version: 1, accounts: {} }, { ...view, routes: editor }).map(plain);
  assert.ok(lines.some((l) => l.includes('Codex routes (1) — first match wins')));
  assert.ok(lines.some((l) => l.includes('1. luna [prefer] gpt-6-luna* → a@example.com')));
  assert.match(lines.at(-1)!, /^ ROUTES: .*a add .*d delete/);
  editor = routeEditorKey(routeEditorKey(routeEditorKey(routeEditorKey(editor, 'e').editor, ENTER).editor, ENTER).editor, ENTER).editor;
  lines = buildFrame(config, { version: 1, accounts: {} }, { ...view, routes: editor }).map(plain);
  assert.ok(lines.some((l) => l.includes('mode     prefer  — route accounts first; when none can serve, any other account takes it')));
  assert.ok(lines.some((l) => l.includes('exclusive: only route accounts serve, failover included; 429 once they are all spent')));
  assert.match(lines.at(-1)!, /^ ROUTE MODE: /);
  assert.ok(lines.every((l) => [...l].length <= 100));
});
