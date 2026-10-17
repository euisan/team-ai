import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../src/runtime.js';
import { defaultConfig } from '../src/storage.js';
import type { TeamAIConfig } from '../src/types.js';

// The real server, started from a config.json in a throwaway TEAMAI_HOME with
// one synthetic Codex account. Background work (profile, usage and token
// refreshes) is off, so nothing here reaches the network: every request below
// is answered by the relay itself before it would go upstream.

const MB = 1024 * 1024;
const TOKEN = 'local-test-token';

async function freePort(): Promise<number> {
  const probe = createServer(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const address = probe.address(); assert(address && typeof address !== 'string');
  await new Promise<void>((r) => probe.close(() => r())); return address.port;
}

async function home(edit: (config: TeamAIConfig) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'teamai-start-'));
  const previous = process.env.TEAMAI_HOME; process.env.TEAMAI_HOME = root;
  const config = defaultConfig();
  config.proxy = { ...config.proxy, claudePort: await freePort(), codexPort: await freePort(), controlPort: await freePort(), clientToken: TOKEN };
  config.warmupIntervalMs = 0; config.externalUsage = { enabled: false };
  config.accounts = [{ id: 'x', provider: 'codex', label: 'x@example.com', enabled: true, priority: null, credentialId: 'codex:x', createdAt: '' }];
  edit(config);
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  await writeFile(join(root, 'credentials.json'), JSON.stringify({ 'codex:x': { accessToken: 'synthetic', refreshToken: null, expiresAt: null, accountId: 'x' } }));
  const restore = async () => { if (previous === undefined) delete process.env.TEAMAI_HOME; else process.env.TEAMAI_HOME = previous; await rm(root, { recursive: true, force: true }); };
  return { root, config, restore };
}

// A raw POST: fetch would refuse to read a response the server sends before
// the upload is done.
function post(port: number, body: Buffer): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/responses', method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
      const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

const listening = (port: number): Promise<boolean> => new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => { res.resume(); resolve(true); });
  req.on('error', () => resolve(false)); req.end();
});

test('proxy.maxBodyMb from config.json reaches the running proxy', async () => {
  for (const limitMb of [1, 2]) {
    const h = await home((c) => { c.proxy.maxBodyMb = limitMb; });
    const server = await startServer({ background: false });
    try {
      const res = await post(h.config.proxy.codexPort, Buffer.alloc(3 * MB, 'a'));
      assert.equal(res.status, 413);
      assert.equal(res.headers['x-teamai-413-reason'], 'body_limit');
      assert.match(res.text, new RegExp(`over the relay's ${limitMb}\\.0 MB \\(${limitMb * MB} bytes\\) limit`), `limit ${limitMb} MB`);
    } finally { await server.stop(); await h.restore(); }
  }
});

test('stop() closes every port the server opened', async () => {
  const h = await home();
  const server = await startServer({ background: false });
  try {
    assert.equal(await listening(h.config.proxy.codexPort), true);
    assert.equal(await listening(h.config.proxy.controlPort!), true);
  } finally { await server.stop(); }
  try {
    assert.equal(await listening(h.config.proxy.codexPort), false);
    assert.equal(await listening(h.config.proxy.controlPort!), false);
  } finally { await h.restore(); }
});
