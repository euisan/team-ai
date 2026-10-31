import { randomBytes } from 'node:crypto';
import type { AccountPool } from './account-pool.js';

// Kept inside the relay process, never sent to a conversation client.
const tokens = new WeakMap<AccountPool, string>();
export function claudeWarmToken(pool: AccountPool): string {
  let token = tokens.get(pool);
  if (!token) { token = randomBytes(32).toString('base64url'); tokens.set(pool, token); }
  return token;
}
