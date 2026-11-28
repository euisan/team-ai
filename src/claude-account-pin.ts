import { readFile } from 'node:fs/promises';
import { claudeGroupArgs, parseGroups } from './groups.js';
import { loadState, paths } from './storage.js';
import type { PersistedState, ProviderId, QuotaWindow, StoredAccount, TeamAIConfig } from './types.js';

export interface ClaudeAccountLike {
  id: string;
  provider?: ProviderId;
  label: string;
  enabled: boolean;
  retired?: boolean;
}

export type AccountRefResult<T extends ClaudeAccountLike> =
  | { ok: true; account: T }
  | { ok: false; reason: 'unknown' | 'wrong_provider' | 'ambiguous'; error: string };

// Resolve a Claude account label or id using the same rule as group members:
// an exact id match wins over a label match, and ambiguous labels fail.
export function resolveClaudeAccountRef<T extends ClaudeAccountLike>(accounts: readonly T[], ref: string): AccountRefResult<T> {
  const claude = accounts.filter((a) => !a.retired && (a.provider === undefined || a.provider === 'claude'));
  const exact = claude.filter((a) => a.id === ref);
  const matches = exact.length ? exact : claude.filter((a) => a.label === ref);
  if (!matches.length) {
    if (accounts.some((a) => !a.retired && a.provider !== undefined && a.provider !== 'claude' && (a.id === ref || a.label === ref))) {
      return { ok: false, reason: 'wrong_provider', error: `Account "${ref}" is not a Claude account; --account supports only Claude accounts` };
    }
    return { ok: false, reason: 'unknown', error: `Unknown Claude account "${ref}"` };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous', error: `Ambiguous Claude account "${ref}"; use its id` };
  }
  return { ok: true, account: matches[0]! };
}

export function parseClaudeAccountArgs(
  args: string[],
  envAccount = process.env.TEAMAI_ACCOUNT,
): { args: string[]; accountRef?: string; explicit: boolean } {
  const pass: string[] = [];
  let explicitRef: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      pass.push(...args.slice(i));
      break;
    }
    if (arg !== '--account' && !arg.startsWith('--account=')) {
      pass.push(arg);
      continue;
    }
    if (explicitRef !== undefined) throw new Error('--account may be supplied only once');
    const value = arg === '--account' ? args[++i] : arg.slice('--account='.length);
    if (!value || !value.trim() || value.startsWith('-')) throw new Error('--account requires an account label or id');
    explicitRef = value;
  }
  const accountRef = explicitRef ?? (envAccount || undefined);
  return {
    args: pass,
    ...(accountRef === undefined ? {} : { accountRef }),
    explicit: explicitRef !== undefined,
  };
}

export function isClaudeResumeArgs(args: string[]): boolean {
  const stop = args.indexOf('--');
  const flagArgs = stop >= 0 ? args.slice(0, stop) : args;
  const named = (name: string): boolean => flagArgs.some((arg) => arg === name || arg.startsWith(`${name}=`));
  return named('--resume') || named('--continue') || flagArgs.some((arg) => /^-[^-]*[rc]/.test(arg));
}

export function windowExhausted(window: QuotaWindow | undefined, now = Date.now()): boolean {
  if (!window || typeof window.usage !== 'number') return false;
  if (window.resetsAt !== null && window.resetsAt !== undefined && window.resetsAt <= now) return false;
  return window.usage >= 1;
}

export function checkPrelaunchClaudeAccountState(
  account: StoredAccount,
  state: PersistedState,
  serverRunning: boolean,
  now = Date.now(),
): void {
  const saved = state.accounts[account.credentialId];
  if (!saved) return;
  const rolled = saved.resetsAt !== null && saved.resetsAt !== undefined && saved.resetsAt <= now;
  const cooldownUntil = rolled ? null : (saved.cooldownUntil ?? null);
  if (cooldownUntil !== null && cooldownUntil > now && (saved.cooldownReason || serverRunning)) {
    throw new Error(`Claude account "${account.label}" (${account.id}) is in cooldown (${saved.cooldownReason || 'active'})`);
  }
  if (windowExhausted(saved.windows?.['5h'], now)) {
    throw new Error(`Claude account "${account.label}" (${account.id}) has exhausted its 5h quota window`);
  }
  if (windowExhausted(saved.windows?.['7d'], now)) {
    throw new Error(`Claude account "${account.label}" (${account.id}) has exhausted its 7d quota window`);
  }
  if (!rolled && typeof saved.usage === 'number' && saved.usage >= 1) {
    throw new Error(`Claude account "${account.label}" (${account.id}) has exhausted its quota`);
  }
  if (serverRunning && saved.error) {
    throw new Error(`Claude account "${account.label}" (${account.id}) is unavailable: ${saved.error}`);
  }
}

async function hasRunningServer(): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(paths().server, 'utf8')) as { pid?: number };
    if (!value.pid) return false;
    process.kill(value.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ClaudeLaunchSelection {
  args: string[];
  group?: string;
  account?: StoredAccount;
  resume: boolean;
}

export async function resolveClaudeLaunchSelection(
  input: string[],
  config: TeamAIConfig,
): Promise<ClaudeLaunchSelection> {
  const grouped = claudeGroupArgs(input, config);
  const { args, accountRef } = parseClaudeAccountArgs(grouped.args);
  const resume = isClaudeResumeArgs(args);
  if (accountRef === undefined) {
    return {
      args,
      ...(grouped.group === undefined ? {} : { group: grouped.group }),
      resume,
    };
  }
  const resolved = resolveClaudeAccountRef(config.accounts, accountRef);
  if (!resolved.ok) throw new Error(resolved.error);
  const account = resolved.account;
  if (!account.enabled) {
    throw new Error(`Claude account "${account.label}" (${account.id}) is disabled`);
  }
  if (grouped.group !== undefined) {
    const groups = parseGroups(config.groups, config.accounts);
    if (!groups[grouped.group]?.includes(account.id)) {
      throw new Error(`Claude account "${account.label}" (${account.id}) is not in group "${grouped.group}"`);
    }
  }
  if (!resume) {
    const [state, serverRunning] = await Promise.all([loadState(), hasRunningServer()]);
    checkPrelaunchClaudeAccountState(account, state, serverRunning);
  }
  return {
    args,
    ...(grouped.group === undefined ? {} : { group: grouped.group }),
    account,
    resume,
  };
}
