// Run by isolation.test.ts in a child process, with test/isolation.ts loaded
// against stand-in paths and ports. Prints what each forbidden call did.
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { takeViolations } from './isolation.js';
import { dataDir } from '../src/storage.js';

const given = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`${name} is not set`); return value; };
const settings = given('PROBE_SETTINGS'); const install = given('PROBE_INSTALL'); const link = given('PROBE_LINK'); const port = Number(given('PROBE_PORT'));

async function outcome(run: () => unknown): Promise<string> {
  // fetch wraps the socket's error in its own.
  try { await run(); return 'allowed'; } catch (error) { const e = error as Error & { code?: string; cause?: { code?: string } }; return e.code === 'ETEAMAI_ISOLATION' || e.cause?.code === 'ETEAMAI_ISOLATION' ? 'blocked' : `allowed (${e.message})`; }
}
const withHome = (value: string | undefined, run: () => unknown) => async () => {
  const saved = process.env.TEAMAI_HOME;
  if (value === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = value;
  try { return await run(); } finally { process.env.TEAMAI_HOME = saved; }
};
const listenOn = (p: number) => new Promise<void>((resolve, reject) => { const server: Server = createServer(); server.once('error', reject); server.listen(p, '127.0.0.1', () => { server.close(); resolve(); }); });
const connectTo = (options: net.NetConnectOpts) => new Promise<void>((resolve, reject) => { const socket = net.connect(options); socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject); setTimeout(() => { socket.destroy(); resolve(); }, 500); });

if (process.env.PROBE_MODE === 'swallow') {
  test('swallows a breach', async () => { try { await readFile(join(settings, 'config.json')); } catch { /* the code under test hides it */ } });
} else {
  test('probe', async () => {
    const result: Record<string, string> = {
      unsetHome: await outcome(withHome(undefined, () => dataDir())),
      homeInRealHome: await outcome(withHome(settings, () => dataDir())),
      homeLinkedIntoRealHome: await outcome(withHome(link, () => dataDir())),
      readSettings: await outcome(() => readFile(join(settings, 'config.json'))),
      writeInstall: await outcome(() => writeFile(join(install, 'cli.js'), 'changed by a test')),
      readThroughLink: await outcome(() => readFile(join(link, 'config.json'))),
      syncRead: await outcome(() => readFileSync(join(settings, 'config.json'))),
      listenRelayPort: await outcome(() => listenOn(port)),
      listenFixedPort: await outcome(() => listenOn(port + 1 > 65535 ? port - 1 : port + 1)),
      connectRelayPort: await outcome(() => connectTo({ host: '127.0.0.1', port })),
      fetchRelayPort: await outcome(() => fetch(`http://127.0.0.1:${port}/v1/responses`).then((r) => r.text())),
      connectOffMachine: await outcome(() => connectTo({ host: '192.0.2.1', port: 443 })),
      tempHomeWorks: await outcome(() => dataDir()),
      listenAnyPort: await outcome(() => listenOn(0)),
    };
    // Every block above was also recorded; this probe expected them.
    takeViolations();
    console.log(`PROBE ${JSON.stringify(result)}`);
  });
}
