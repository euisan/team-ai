import { startServer, type RunningServer, type StartOptions } from '../src/runtime.js';
import { updateConfig } from '../src/storage.js';
import type { TeamAIConfig } from '../src/types.js';

// Test servers listen on port 0 (test/isolation.ts refuses fixed ports).
export const anyPorts = { claudePort: 0, codexPort: 0, controlPort: 0 } as const;

// The real server, started from config.json with every port set to 0. The
// ports it bound are then written to config.json, which is where reload and
// the dashboard look for them, and to the test's own copy of the config. A
// restart in the same home starts from port 0 again.
export async function startOnAnyPorts(config?: TeamAIConfig, options: StartOptions = { background: false }): Promise<RunningServer> {
  await updateConfig((file) => { Object.assign(file.proxy, anyPorts); });
  const server = await startServer(options);
  const bound = { ...(server.ports.claude ? { claudePort: server.ports.claude } : {}), ...(server.ports.codex ? { codexPort: server.ports.codex } : {}), controlPort: server.ports.control };
  await updateConfig((file) => { Object.assign(file.proxy, bound); });
  if (config) Object.assign(config.proxy, bound);
  return server;
}
