// Real independent relay process with the same isolation guard as the parent.
import { AccountPool } from '../src/account-pool.js';
import { createProxy } from '../src/proxy.js';
import { claudeProvider } from '../src/providers.js';
import type { StoredAccount } from '../src/types.js';

const [home, upstreamBase, sessionId, preferred, disabled] = process.argv.slice(2);
if (!home || !upstreamBase || !sessionId) throw new Error('Missing child fixture arguments');
process.env.TEAMAI_HOME = home;
const accounts: StoredAccount[] = ['a', 'b'].map((id) => ({ id, provider: 'claude', label: id, enabled: id !== disabled, priority: id === preferred ? 1 : 2, credentialId: id, createdAt: '' }));
const credentials = Object.fromEntries(['a', 'b'].map((id) => [id, { accountId: id, accessToken: `fake-${id}`, refreshToken: null, expiresAt: null }]));
const pool = new AccountPool({ ...claudeProvider, upstreamBase, readQuota: () => null, refresh: async (credential) => credential }, accounts, credentials, { version: 1, accounts: {} });
const proxy = createProxy(pool, 'synthetic-child', () => {});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
if (!address || typeof address === 'string') throw new Error('No child port');
process.send?.({ ready: true });
process.once('message', async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer synthetic-child', 'content-type': 'application/json', 'x-claude-code-session-id': sessionId }, body: JSON.stringify({ messages: [{ role: 'user', content: 'synthetic compact turn' }] }) });
    await response.text();
    process.send?.({ status: response.status });
  } catch (error) { process.send?.({ error: String(error) }); process.exitCode = 1; }
  finally { proxy.closeAllConnections(); proxy.close(); process.disconnect?.(); }
});
