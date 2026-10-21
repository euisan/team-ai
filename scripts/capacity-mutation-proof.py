#!/usr/bin/env python3
"""Prove the capacity, test-isolation and storage-race tests each reject a single regression; always restore source bytes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out-dir', required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
args.out_dir.mkdir(parents=True, exist_ok=True)

# Each mutation replaces one implementation line, independently of all others.
cases = [
    ('http-capacity', 'src/proxy.ts', "response.status === 503 && isCapacityOverloadBody(errorBody)", "response.status === 503 && false", '503 capacity retries unboundedly', 'test/codex-capacity-proxy.test.ts'),
    ('stream-capacity', 'src/codex-capacity.ts', "if (type === 'response.failed' && isCapacityOverloadPayload(payload)) return 'capacity';", "if (false) return 'capacity';", 'gate suppresses early capacity', 'test/codex-capacity.test.ts'),
    ('same-account-lease', 'src/proxy.ts', 'else capacityHeld = account; // retain the lease: another request cannot steal this slot', 'else { pool.release(account); capacityHeld = account; }', 'a capacity wait retains its account lease', 'test/codex-capacity-proxy.test.ts'),
    ('unlimited-attempts', 'src/proxy.ts', '  while (!res.destroyed) {\n    const forced:', '  while (!res.destroyed && capacityRetries < 2) {\n    const forced:', '503 capacity retries unboundedly', 'test/codex-capacity-proxy.test.ts'),
    ('fixed-interval', 'src/proxy.ts', 'await waitForRetry(settings.retryMs, res);', 'await waitForRetry(settings.retryMs * 2 ** (capacityRetries - 1), res);', '503 capacity retries unboundedly', 'test/codex-capacity-proxy.test.ts'),
    ('preamble-hold', 'src/codex-capacity.ts', "if (kind === 'output') { output = true; holding = false; yield* flush(); yield frame; }", "if (kind === 'output' || kind === 'preamble') { output = true; holding = false; yield* flush(); yield frame; }", 'gate suppresses early capacity', 'test/codex-capacity.test.ts'),
    ('hold-deadline', 'src/codex-capacity.ts', 'const remaining = Math.max(0, deadline! - Date.now());', 'const remaining = Math.max(0, deadline! - Date.now() + 1);', 'hold deadline releases preamble promptly', 'test/codex-capacity.test.ts'),
    ('after-output-end', 'src/codex-capacity.ts', "if (kind === 'capacity') { if (output) outcome.afterOutput = true; else outcome.retry = true; return; }", "if (kind === 'capacity') { if (output) { outcome.afterOutput = true; continue; } else outcome.retry = true; return; }", 'gate filters capacity after output', 'test/codex-capacity.test.ts'),
    ('after-output-filter', 'src/codex-capacity.ts', "if (kind === 'capacity') { if (output) outcome.afterOutput = true; else outcome.retry = true; return; }", "if (kind === 'capacity') { if (output) { outcome.afterOutput = true; yield frame; } else outcome.retry = true; return; }", 'gate filters capacity after output', 'test/codex-capacity.test.ts'),
    ('non-capacity-failure', 'src/codex-capacity.ts', "if (type === 'response.failed' && isCapacityOverloadPayload(payload)) return 'capacity';", "if (type === 'response.failed') return 'capacity';", 'gate passes non-capacity failures', 'test/codex-capacity.test.ts'),
    ('cancel-backoff', 'src/proxy.ts', "    res.once('close', done);", '    // cancellation wakeup removed', 'client disconnect stops capacity retries.*wait', 'test/codex-capacity-proxy.test.ts'),
    ('cancel-refresh', 'src/proxy.ts', 'await Promise.race([pool.refresh(account), new Promise<never>((_resolve, reject) => { cancelRefresh = reject; })]);', 'await pool.refresh(account);', 'client disconnect during a shared token refresh', 'test/codex-capacity-proxy.test.ts'),
    ('buffer-ceiling', 'src/codex-capacity.ts', 'const room = SSE_MAX_FRAME_BYTES - pending.length - heldBytes;', 'const room = 2 * SSE_MAX_FRAME_BYTES - pending.length - heldBytes;', 'memory ceiling', 'test/codex-capacity.test.ts'),
    ('claude-http-isolation', 'src/proxy.ts', "pool.provider.id === 'codex' && pool.codexCapacity.enabled && response.status === 503", "pool.codexCapacity.enabled && response.status === 503", 'Claude keeps 503 and SSE failures unchanged', 'test/codex-capacity-proxy.test.ts'),
    ('claude-stream-isolation', 'src/proxy.ts', "const isCodexCapacityStream = pool.provider.id === 'codex' && pool.codexCapacity.enabled", 'const isCodexCapacityStream = pool.codexCapacity.enabled', 'Claude keeps 503 and SSE failures unchanged', 'test/codex-capacity-proxy.test.ts'),
    ('activity-count', 'src/proxy.ts', 'track.setCapacityRetries(++capacityRetries);', 'capacityRetries++;', 'a capacity wait retains its account lease', 'test/codex-capacity-proxy.test.ts'),
    ('reload-adoption', 'src/config-reload.ts', '    pool.codexCapacity = capacity;', '    // capacity adoption removed', 'Codex capacity settings are validated and adopted atomically', 'test/live-reload.test.ts'),
    ('reload-validation', 'src/config-reload.ts', '  const capacity = codexCapacitySettings(config);', '  const capacity = codexCapacitySettings({});', 'Codex capacity settings are validated and adopted atomically', 'test/live-reload.test.ts'),
    # Test isolation: each guard switched off on its own. The probes target stand-ins, so a broken guard touches nothing real.
    ('isolation-files', 'test/isolation.ts', "if (forbiddenRoots.some((root) => inside(root, real) || inside(root, resolve(path)))) violate(`file access to ${path}`);", 'if (false) violate(`file access to ${path}`);', 'the isolation guard blocks', 'test/isolation.test.ts'),
    ('isolation-home', 'test/isolation.ts', "if (homes.some((home) => inside(home, real)) || !inside(temporary, real) || real === temporary) violate(", "if (false) violate(", 'the isolation guard blocks', 'test/isolation.test.ts'),
    ('isolation-fixed-port', 'test/isolation.ts', "if (port !== 0 && !held.has(port)) violate(", "if (false) violate(", 'the isolation guard blocks', 'test/isolation.test.ts'),
    ('isolation-relay-port', 'test/isolation.ts', "if (forbiddenPorts.has(port)) violate(`connection to the relay's port ${port}`);", "if (false) violate(`connection to the relay's port ${port}`);", 'the isolation guard blocks', 'test/isolation.test.ts'),
    ('isolation-network', 'test/isolation.ts', "if (!loopback(host)) violate(", "if (false) violate(", 'the isolation guard blocks', 'test/isolation.test.ts'),
    ('isolation-swallowed', 'test/isolation.ts', "const found = takeViolations(); if (found.length) throw new Error(`Test isolation was breached:", "const found = takeViolations(); if (false) throw new Error(`Test isolation was breached:", 'a breach that the code under test swallows', 'test/isolation.test.ts'),
    # Storage races: the fix taken back out, one piece at a time.
    ('storage-shared-temp', 'src/storage.ts', "const temp = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;", "const temp = `${path}.${process.pid}.tmp`;", 'concurrent atomic saves use independent temporary files', 'test/storage-race.test.ts'),
    ('storage-no-file-lock', 'src/storage.ts', 'const locked = (): Promise<T> => withFileLock(path, run);', 'const locked = (): Promise<T> => run();', 'from another process|from different processes', 'test/storage-race.test.ts'),
    ('storage-stale-lock', 'src/storage.ts', 'if (await staleLock(lock)) await rm(lock, { force: true }); else await delay(LOCK_POLL_MS);', 'await delay(LOCK_POLL_MS);', 'a lock left by a process that died', 'test/storage-race.test.ts'),
]
results = []
for name, filename, before, after, pattern, test_file in cases:
    path = root / filename
    original = path.read_bytes()
    text = original.decode()
    if text.count(before) != 1:
        raise SystemExit(f'{name}: expected exactly one mutation anchor, got {text.count(before)}')
    line = text[:text.index(before)].count('\n') + 1
    digest = hashlib.sha256(original).hexdigest()
    try:
        path.write_text(text.replace(before, after, 1))
        command = ['node', '--test', '--test-reporter=tap', '--import', 'tsx', '--import', './test/isolation.ts', f'--test-name-pattern={pattern}', test_file]
        result = subprocess.run(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60, check=False)
        output = result.stdout.decode(errors='replace')
        (args.out_dir / f'{name}.log').write_text(output)
        failed_tests = re.findall(r'^not ok \d+ - (.*)$', output, re.M)
        killed = result.returncode != 0 and bool(failed_tests)
    finally:
        path.write_bytes(original)
    restored = hashlib.sha256(path.read_bytes()).hexdigest() == digest
    entry = dict(name=name, file=filename, line=line, original=before, mutated=after, command=command, exit=result.returncode, killed=killed, restored=restored, failedTests=failed_tests)
    results.append(entry)
    print(f'{name}: exit={result.returncode} killed={killed} restored={restored}; {filename}:{line}; {", ".join(failed_tests)}', flush=True)
(args.out_dir / 'mutations.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
print(f'MUTATIONS: {sum(r["killed"] and r["restored"] for r in results)}/{len(results)} killed and restored')
sys.exit(0 if all(r['killed'] and r['restored'] for r in results) else 1)
