import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stripAnsi } from '../src/columns.js';
import { buildFrame, type FrameView } from '../src/frame.js';
import { orderKey, pressOrderKey } from '../src/tui.js';
import type { StoredAccount, TeamAIConfig } from '../src/types.js';
import { config as fixture, state } from './narrow-fixture.js';

const UP = '\x1b[A'; const DOWN = '\x1b[B'; const RIGHT = '\x1b[C'; const LEFT = '\x1b[D'; const ENTER = '\r'; const ESC = '\x1b';
const account = (id: string, priority: number | null): StoredAccount => ({ id, provider: 'claude', label: `${id}@example.com`, enabled: true, priority, credentialId: `cred-${id}`, createdAt: '' });

// A throwaway TEAMAI_HOME holding only a config.json with synthetic accounts.
async function home(accounts: StoredAccount[]): Promise<{ priorities: () => Promise<Record<string, number | null>>; mtime: () => Promise<number> }> {
  const root = await mkdtemp(join(tmpdir(), 'teamai-priority-keys-')); process.env.TEAMAI_HOME = root;
  const config: TeamAIConfig = { version: 1, proxy: { host: '127.0.0.1', claudePort: 1, codexPort: 2, clientToken: 'tok' }, switchThreshold: 0.98, maxConcurrentPerAccount: 16, accounts };
  const file = join(root, 'config.json'); await writeFile(file, JSON.stringify(config, null, 2));
  return {
    priorities: async () => Object.fromEntries((JSON.parse(await readFile(file, 'utf8')) as TeamAIConfig).accounts.map((a) => [a.id, a.priority])),
    mtime: async () => (await stat(file)).mtimeMs,
  };
}

test('in priority mode ←/→ (h/l) step the priority down/up, ↑/↓ (k/j) move, Enter leaves', () => {
  assert.deepEqual(orderKey(3, LEFT), { priority: 2 }); assert.deepEqual(orderKey(3, 'h'), { priority: 2 });
  assert.deepEqual(orderKey(3, RIGHT), { priority: 4 }); assert.deepEqual(orderKey(3, 'l'), { priority: 4 });
  // From auto either way lands on #1, as ↑/↓ did before.
  assert.deepEqual(orderKey(null, LEFT), { priority: 1 }); assert.deepEqual(orderKey(null, RIGHT), { priority: 1 });
  assert.deepEqual(orderKey(4, 'a'), { priority: null }); assert.deepEqual(orderKey(4, 'c'), { priority: null });
  // ↑/↓ no longer change the priority: they pick another account.
  assert.deepEqual(orderKey(3, UP), { move: -1 }); assert.deepEqual(orderKey(3, 'k'), { move: -1 });
  assert.deepEqual(orderKey(3, DOWN), { move: 1 }); assert.deepEqual(orderKey(3, 'j'), { move: 1 });
  assert.deepEqual(orderKey(3, ENTER), { done: true });
  assert.deepEqual(orderKey(3, 'x'), {});
});

test('← stops at #1 and a/c on auto change nothing', () => {
  assert.deepEqual(orderKey(1, LEFT), {}); assert.deepEqual(orderKey(1, 'h'), {});
  assert.deepEqual(orderKey(null, 'a'), {});
  // The switch pin (#0, set by 's') is left by ← onto #1, as before.
  assert.deepEqual(orderKey(0, LEFT), { priority: 1 });
});

test('each ←/→ is saved to config.json for the selected account at once', async () => {
  const { priorities } = await home([account('one', null), account('two', 2)]);
  assert.deepEqual(await pressOrderKey('cred-two', RIGHT), { saved: true });
  assert.deepEqual(await priorities(), { one: null, two: 3 });
  assert.deepEqual(await pressOrderKey('cred-two', LEFT), { saved: true });
  assert.deepEqual(await pressOrderKey('cred-two', 'h'), { saved: true });
  assert.deepEqual(await priorities(), { one: null, two: 1 });
  // ↓ then → adjusts the next account without leaving the mode.
  assert.deepEqual(await pressOrderKey('cred-two', DOWN), { saved: false, move: 1, done: undefined });
  assert.deepEqual(await pressOrderKey('cred-one', 'l'), { saved: true });
  assert.deepEqual(await priorities(), { one: 1, two: 1 });
  // No selection yet: the first account, as every other key does.
  assert.deepEqual(await pressOrderKey(null, RIGHT), { saved: true });
  assert.deepEqual(await priorities(), { one: 2, two: 1 });
});

test('at the end of the range, and on Enter or Esc, nothing is written', async () => {
  const { priorities, mtime } = await home([account('one', 1)]);
  const before = await mtime();
  assert.deepEqual(await pressOrderKey('cred-one', LEFT), { saved: false, move: undefined, done: undefined });
  assert.deepEqual(await pressOrderKey('cred-one', ENTER), { saved: false, move: undefined, done: true });
  // Esc leaves every mode before the mode sees it; here too it writes nothing.
  assert.deepEqual(await pressOrderKey('cred-one', ESC), { saved: false, move: undefined, done: undefined });
  assert.deepEqual(await pressOrderKey('cred-one', UP), { saved: false, move: -1, done: undefined });
  assert.equal(await mtime(), before); assert.deepEqual(await priorities(), { one: 1 });
});

test('the priority-mode footer names ←→ for the rank and ↑↓ for the account, in both layouts', () => {
  const view = (width: number): FrameView => ({ width, height: 30, selectedId: 'cred-alice.long.address@example.com', mode: 'order', message: '', sortByHeadroom: true });
  for (const width of [46, 120]) {
    const text = buildFrame(fixture, state, view(width)).map(stripAnsi).join('\n');
    for (const hint of ['←→ rank -/+', '↑↓ select', 'a/c auto', 'Enter/Esc done']) assert.ok(text.includes(hint), `width ${width}: ${hint}\n${text}`);
    assert.ok(!text.includes('↑↓ rank'), `width ${width}: the old hint is gone`);
  }
});
