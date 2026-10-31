import type { IncomingMessage, ServerResponse } from 'node:http';
import { secureEqual } from './proxy.js';
import { issueClaudeSession } from './storage.js';
import type { TeamAIConfig } from './types.js';

export const CLAUDE_SESSION_PATH = '/claude/sessions';

export async function handleClaudeSessionControl(req: IncomingMessage, res: ServerResponse, token: string): Promise<boolean> {
  if (req.url !== CLAUDE_SESSION_PATH) return false;
  res.setHeader('content-type', 'application/json');
  if (!secureEqual(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), token)) {
    res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' })); return true;
  }
  if (req.method !== 'POST') { res.writeHead(405).end(JSON.stringify({ error: 'Use POST' })); return true; }
  // This endpoint accepts no client-selected ID, even in a request body.
  req.resume();
  try { const sessionId = await issueClaudeSession(); res.writeHead(201).end(JSON.stringify({ sessionId })); }
  catch { res.writeHead(500).end(JSON.stringify({ error: 'Claude session storage unavailable; refusing new session' })); }
  return true;
}

export async function prepareClaudeArgs(args: string[], config: TeamAIConfig): Promise<string[]> {
  const named = (name: string): boolean => args.some((arg) => arg === name || arg.startsWith(`${name}=`));
  if (named('--session-id') || named('--fork-session')) throw new Error('TeamAI issues Claude session IDs; --session-id and --fork-session are unsupported. Use --resume for a previously bound session.');
  if (named('--resume') || named('--continue') || args.some((arg) => /^-[^-]*[rc]/.test(arg))) return [...args];
  const port = config.proxy.controlPort ?? config.proxy.claudePort + 100;
  const response = await fetch(`http://${config.proxy.host}:${port}${CLAUDE_SESSION_PATH}`, {
    method: 'POST', headers: { authorization: `Bearer ${config.proxy.clientToken}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Cannot register new Claude session (control ${response.status}); check session storage and update/restart the relay if needed`);
  const body = await response.json() as { sessionId?: unknown };
  if (typeof body.sessionId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(body.sessionId)) throw new Error('Relay returned an invalid Claude session ID');
  return ['--session-id', body.sessionId, ...args];
}
