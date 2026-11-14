// Retention for Claude session bindings. A binding is what keeps a conversation
// on its first account, but a conversation that is over leaves that binding
// behind; enough of them make every group edit look blocked by a session that
// no longer exists. Claude Code itself keeps a transcript per conversation, and
// its modification time is the best evidence of when the conversation last did
// anything — including for bindings written before lastSeenAt existed.
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pruneStaleSessions } from './storage.js';

function projectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

// Session id → transcript modification time. A missing or unreadable tree is
// simply no evidence: the caller falls back to the binding's own timestamps.
export async function claudeTranscriptTimes(): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  const root = projectsDir();
  let projects: string[];
  try { projects = await readdir(root); } catch { return times; }
  await Promise.all(projects.map(async (project) => {
    const dir = join(root, project);
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    await Promise.all(entries.map(async (name) => {
      if (!name.endsWith('.jsonl')) return;
      try {
        const info = await stat(join(dir, name));
        times.set(name.slice(0, -'.jsonl'.length), info.mtimeMs);
      } catch { /* removed while listing */ }
    }));
  }));
  return times;
}

// The sweep both the relay and the dashboard use. Every binding whose own
// timestamps and whose transcript are older than the retention window is
// dropped; a session that is still around keeps its binding.
export async function pruneInactiveClaudeSessions(options: { retentionMs?: number; now?: number } = {}): Promise<number> {
  const times = await claudeTranscriptTimes();
  return pruneStaleSessions({ retentionMs: options.retentionMs, now: options.now, lastActivity: (sessionId) => times.get(sessionId) ?? null });
}
