import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { cellWidth } from '../src/columns.js';
import { buildFrame } from '../src/frame.js';
import { startScreen, terminalSize } from '../src/tui.js';
import { config, state } from './narrow-fixture.js';

// A terminal whose size can change under the dashboard, the way one PTY
// does when a desktop and a phone take turns looking at it.
class FakeTerminal extends EventEmitter {
  writes: string[] = [];
  constructor(public columns: number, public rows: number) { super(); }
  write(text: string): boolean { this.writes.push(text); return true; }
  resize(columns: number, rows: number): void { this.columns = columns; this.rows = rows; this.emit('resize'); }
}

const CLEAR = '\x1b[2J'; const HOME = '\x1b[H';
const draw = async ({ width, height }: { width: number; height: number }): Promise<string[]> => buildFrame(config, state, { width, height, selectedId: null, mode: 'normal', message: '', sortByHeadroom: true });
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const frameLines = (write: string): string[] => write.replace(CLEAR, '').replace(HOME, '').split('\n');

test('the frame is drawn at the terminal\'s real width, not widened to 80', async () => {
  assert.deepEqual(terminalSize({ columns: 46, rows: 20 }), { width: 46, height: 20 });
  const terminal = new FakeTerminal(46, 20); const screen = startScreen(terminal, draw);
  await screen.render();
  const lines = frameLines(terminal.writes[0]!);
  assert.equal(lines.length, 20);
  for (const line of lines) assert.ok(cellWidth(line) <= 46, `${cellWidth(line)} columns on a 46-column terminal`);
  screen.stop();
});

test('a resize redraws at once at the new size and clears what was there', async () => {
  const terminal = new FakeTerminal(120, 40); const screen = startScreen(terminal, draw);
  await screen.render();
  assert.equal(terminal.writes.length, 1); assert.ok(!terminal.writes[0]!.includes(CLEAR), 'a normal frame does not clear');
  terminal.resize(46, 20); await settle();
  assert.equal(terminal.writes.length, 2, 'redrawn on resize, without waiting for the timer');
  assert.ok(terminal.writes[1]!.startsWith(CLEAR), 'the redraw clears the old, wider frame first');
  const lines = frameLines(terminal.writes[1]!);
  assert.equal(lines.length, 20);
  for (const line of lines) assert.ok(cellWidth(line) <= 46);
  await screen.render();
  assert.ok(!terminal.writes[2]!.includes(CLEAR), 'only the frame after a resize clears');
  // Back to the desktop: the wide layout again.
  terminal.resize(160, 40); await settle();
  assert.ok(terminal.writes[3]!.startsWith(CLEAR)); assert.match(terminal.writes[3]!, /Claude accounts/);
  screen.stop();
  terminal.resize(46, 20); await settle();
  assert.equal(terminal.writes.length, 4, 'no redraw after stop');
});

test('a frame whose terminal changed size while it loaded is dropped for the resize\'s own', async () => {
  const terminal = new FakeTerminal(120, 40); let release: () => void = () => {};
  const slow = async (size: { width: number; height: number }): Promise<string[]> => { if (size.width === 120) await new Promise<void>((resolve) => { release = resolve; }); return draw(size); };
  const screen = startScreen(terminal, slow);
  const first = screen.render();
  terminal.resize(46, 20); await settle();
  release(); await first;
  assert.equal(terminal.writes.length, 1, 'only the 46-column frame was written');
  assert.ok(terminal.writes[0]!.startsWith(CLEAR));
  for (const line of frameLines(terminal.writes[0]!)) assert.ok(cellWidth(line) <= 46);
  screen.stop();
});
