import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CODEX_WARM_MODEL = 'gpt-6-luna';

export interface WarmCommand { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }

export function resolveCodexCliBin(env: NodeJS.ProcessEnv = process.env): string { return env.TEAMAI_CODEX_BIN || 'codex'; }

export function buildCodexWarmArgs(port: number, accountId: string, host = '127.0.0.1'): string[] {
  const base = `http://${host}:${port}/tc-acct/${encodeURIComponent(accountId)}/codex`;
  return [
    '-c', 'model_provider="teamai"',
    '-c', 'model_providers.teamai.name="TeamAI Codex Relay"',
    '-c', `model_providers.teamai.base_url="${base}"`,
    '-c', 'model_providers.teamai.env_key="TEAMAI_PROXY_TOKEN"',
    '-c', 'model_providers.teamai.wire_api="responses"',
    '-c', 'model_providers.teamai.request_max_retries=0',
    '-c', 'model_providers.teamai.stream_max_retries=0',
    'exec', '--skip-git-repo-check', '--model', CODEX_WARM_MODEL, 'hi',
  ];
}

/** Build an actual official Codex CLI invocation without copying credentials. */
export function buildCodexWarmCommand(port: number, accountId: string, options: { env?: NodeJS.ProcessEnv; host?: string; token?: string } = {}): WarmCommand {
  const env = { ...process.env, ...options.env };
  const home = join(env.TEAMAI_HOME || tmpdir(), 'teamai-warm');
  return { command: resolveCodexCliBin(env), args: buildCodexWarmArgs(port, accountId, options.host), env: { ...env, CODEX_HOME: home, TEAMAI_PROXY_TOKEN: options.token ?? env.TEAMAI_PROXY_TOKEN ?? '' }, cwd: home };
}

export function spawnCodexWarm(spec: WarmCommand & { timeoutMs: number; signal: AbortSignal }): Promise<number> {
  return new Promise((resolve, reject) => {
    if (spec.signal.aborted) { reject(new Error('warm aborted')); return; }
    let child: ChildProcess;
    void mkdir(spec.cwd, { recursive: true, mode: 0o700 }).then(() => {
      if (spec.signal.aborted) { reject(new Error('warm aborted')); return; }
      try { child = spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: 'ignore', shell: process.platform === 'win32' }); }
      catch (error) { reject(error); return; }
      const onAbort = () => child.kill('SIGKILL');
      spec.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error(`warm timed out after ${spec.timeoutMs}ms`), { code: 'ETIMEDOUT' })); }, spec.timeoutMs);
      timer.unref?.();
      const cleanup = () => { clearTimeout(timer); spec.signal.removeEventListener('abort', onAbort); };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('exit', (code, signal) => { cleanup(); if (signal) reject(Object.assign(new Error(`codex terminated by ${signal}`), { signal })); else resolve(code ?? 0); });
    }, reject);
  });
}

