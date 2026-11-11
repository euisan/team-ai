import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cellWidth, stripAnsi } from '../src/columns.js';
import { buildFrame, type CreditPicker } from '../src/frame.js';
import type { PersistedState, TeamAIConfig } from '../src/types.js';

// The reset-credit picker draws its tickets under the selected account row.
// These snapshots pin the shape of that block and the geometry: the ticket
// text starts at least four columns inside the account name, the cursor sits
// in the column just before it, and no line leaves the terminal.
const WIDTHS = [40, 60, 80, 120];

const config: TeamAIConfig = {
  version: 1,
  proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'tok' },
  switchThreshold: 0.98,
  maxConcurrentPerAccount: 3,
  accounts: [
    { id: 'c1', provider: 'claude', label: 'c1@example.com', enabled: true, priority: null, credentialId: 'c1', createdAt: '' },
    { id: 'c2', provider: 'claude', label: 'c2@example.com', enabled: true, priority: null, credentialId: 'c2', createdAt: '' },
  ],
};

const state: PersistedState = {
  version: 1,
  accounts: {
    c1: { usage: 0.2, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { '5h': { usage: 0.2, resetsAt: null }, '7d': { usage: 0.1, resetsAt: null } } },
    c2: { usage: 0.5, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { '5h': { usage: 0.5, resetsAt: null }, '7d': { usage: 0.3, resetsAt: null } } },
  },
};

// Null timestamps keep the snapshot free of the machine's timezone.
const picker = (phase: CreditPicker['phase'], items: CreditPicker['items'] = [], error?: string): CreditPicker => ({ account: 'c1@example.com', phase, items, index: 0, error });

const CASES: Array<[string, CreditPicker, string[]]> = [
  ['two', picker('pick', [
    { id: 't1', title: 'Ticket Alpha', grantedAt: null, expiresAt: null, resetsLeft: 2, usableNow: true },
    { id: 't2', title: 'Ticket Beta', grantedAt: null, expiresAt: null, usableNow: false, unavailableReason: 'cooldown' },
  ]), ['Ticket Alpha', 'Ticket Beta']],
  ['zero', picker('pick', []), ['No reset credits available']],
  ['failed', picker('failed', [], 'connection refused'), ['Failed to load credits']],
  ['loading', picker('loading'), ['Loading…']],
];

function columnOf(line: string, needle: string): number {
  const at = line.indexOf(needle);
  assert.ok(at >= 0, `no ${JSON.stringify(needle)} in ${JSON.stringify(line)}`);
  return cellWidth(line.slice(0, at));
}

// The selected account row and the block the picker draws under it, stopping
// before the next account row: exactly the part these snapshots describe.
function sublistBlock(lines: string[]): { row: string; block: string[] } {
  const row = lines.findIndex((line) => line.includes('c1@'));
  assert.ok(row >= 0, 'selected account row is drawn');
  const next = lines.findIndex((line, index) => index > row && line.includes('c2@'));
  assert.ok(next > row, 'the other account follows the sublist');
  return { row: lines[row]!, block: lines.slice(row + 1, next) };
}

for (const width of WIDTHS) {
  for (const [name, credits, needles] of CASES) {
    test(`reset-credit sublist ${name} at ${width} columns`, () => {
      const lines = buildFrame(config, state, { width, selectedId: 'c1', mode: 'credits', message: '', sortByHeadroom: false, credits }).map(stripAnsi);
      for (const line of lines) assert.ok(cellWidth(line) <= width, `width ${width}: ${cellWidth(line)} columns in ${JSON.stringify(line)}`);

      const { row, block } = sublistBlock(lines);
      const nameColumn = columnOf(row, 'c1@');
      assert.equal(nameColumn, width < 80 ? 2 : 3, `width ${width}: the account row's name column`);
      assert.equal(block.length, needles.length, `sublist has one line per state at width ${width}`);

      let cursorLine = -1;
      block.forEach((line, index) => {
        const column = columnOf(line, needles[index]!);
        assert.ok(column >= nameColumn + 4, `width ${width}: ${JSON.stringify(needles[index])} starts at ${column}, account name at ${nameColumn}`);
        const cursor = line.indexOf('>');
        if (cursor >= 0) {
          cursorLine = index;
          assert.equal(cellWidth(line.slice(0, cursor)), column - 1, `width ${width}: cursor sits immediately before the ticket text`);
        }
      });
      if (name === 'two') assert.equal(cursorLine, 0, `width ${width}: the chosen ticket is the first line`);

      const expected = readFileSync(new URL(`./snapshots/credit-sublist-${name}-${width}.txt`, import.meta.url), 'utf8');
      assert.equal(`${[row, ...block].map((line) => line.trimEnd()).join('\n')}\n`, expected);
    });
  }
}

test('the sublist follows the account name past route markers', () => {
  // A route marker adds a column to the lead, so the name — and the sublist —
  // move right with it instead of the indent being a fixed number of spaces.
  const routed: PersistedState = {
    ...state,
    routes: [
      { provider: 'claude', name: 'first', color: null, mode: 'prefer', members: [{ credentialId: 'c1', usable: true }, { credentialId: 'c2', usable: true }] },
      { provider: 'claude', name: 'second', color: null, mode: 'prefer', members: [] },
    ],
  };
  const credits = CASES[0]![1];
  const width = 120;
  const lines = buildFrame(config, routed, { width, selectedId: 'c1', mode: 'credits', message: '', sortByHeadroom: false, credits }).map(stripAnsi);
  const { row, block } = sublistBlock(lines);
  const nameColumn = columnOf(row, 'c1@');
  assert.equal(nameColumn, 5, 'two route markers plus the lead put the name in column 5 (zero-based)');
  assert.equal(columnOf(block[0]!, 'Ticket Alpha'), nameColumn + 4);
});
