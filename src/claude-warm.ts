import type { ProbeTemplate } from './types.js';

export const CLAUDE_WARM_MODEL = 'claude-haiku-4-5-20251001';

export interface ClaudeWarmRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ClaudeWarmSpec extends ClaudeWarmRequest {
  timeoutMs: number;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
}

export type SpawnResult = number | { code: number; transient?: boolean; reason?: string };

export function buildClaudeWarmRequest(
  port: number,
  accountId: string,
  options: { host?: string; token?: string; probeTemplate?: ProbeTemplate | null } = {},
): ClaudeWarmRequest {
  const host = options.host || '127.0.0.1';
  const template = options.probeTemplate;
  const path = template?.path || '/v1/messages';
  const query = template?.query || '?beta=true';
  const url = `http://${host}:${port}/tc-acct/${encodeURIComponent(accountId)}/claude${path}${query}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${options.token ?? ''}`,
    'anthropic-version': template?.version || '2023-06-01',
    'anthropic-beta': template?.beta || 'oauth-2025-04-20',
    'user-agent': template?.userAgent || 'claude-cli/2.1.260 (external, cli)',
  };
  const payload: Record<string, unknown> = {
    model: CLAUDE_WARM_MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  };
  if (template?.system) {
    payload.system = template.system;
  }
  return {
    url,
    headers,
    body: JSON.stringify(payload),
  };
}

export async function sendClaudeWarm(spec: ClaudeWarmSpec): Promise<SpawnResult> {
  if (spec.signal.aborted) {
    throw Object.assign(new Error('warm aborted'), { name: 'AbortError' });
  }
  const fetchImpl = spec.fetchFn || fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  spec.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
  }, spec.timeoutMs);
  timer.unref?.();

  try {
    const res = await fetchImpl(spec.url, {
      method: 'POST',
      headers: spec.headers,
      body: spec.body,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    if (res.ok) return 0;
    const transient = res.status >= 500 || res.status === 408;
    return {
      code: res.status,
      transient,
      reason: `HTTP ${res.status}${text ? `: ${text.slice(0, 100)}` : ''}`,
    };
  } catch (error: unknown) {
    if (spec.signal.aborted) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw Object.assign(new Error(`warm timed out after ${spec.timeoutMs}ms`), { code: 'ETIMEDOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    spec.signal.removeEventListener('abort', onAbort);
  }
}
