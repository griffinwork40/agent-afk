import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pidAlive, readFakeLog, writeFakeLspServer } from './__test-utils__/fake-lsp-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(here, name)).href);

describe('LSP spawn-time exit guardian', () => {
  // Windows TerminateProcess does not dispatch Node's POSIX signal handlers.
  it.each(['ready', 'starting', 'disposing', 'natural',
    ...(process.platform === 'win32' ? [] : ['sigterm', 'sigterm-owned', 'sigterm-once'])])(
    'kills the server tree on host termination (%s)', async (mode) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'afk-lsp-exit-'));
      const log = path.join(root, 'log.jsonl');
      const server = path.join(root, 'server.cjs');
      const host = path.join(root, 'host.mts');
      writeFakeLspServer(server, { logFile: log, spawnGrandchild: true, silent: mode === 'starting' });
      const pids: number[] = [];
      try {
        writeFileSync(host, [
          `import { getLspPool } from ${moduleUrl('pool.ts')};`,
          `import { TYPESCRIPT_SERVER_DEFINITION } from ${moduleUrl('typescript-default.ts')};`,
          `import { readFileSync } from 'node:fs';`,
          mode === 'sigterm-once' ? `process.once('SIGTERM', () => setTimeout(() => process.exit(42), 20));` : '',
          `const pool = getLspPool();`,
          `const pending = pool.acquire({ definition: TYPESCRIPT_SERVER_DEFINITION, command: process.execPath, args: [${JSON.stringify(server)}], source: 'override' }, ${JSON.stringify(root)});`,
          mode === 'starting'
            ? `while (true) { try { if (readFileSync(${JSON.stringify(log)}, 'utf8').includes('grandchild')) break; } catch {} await new Promise(r => setTimeout(r, 10)); }`
            : `await pending;`,
          mode === 'disposing' ? 'void pool.disposeAll();' : '',
          mode === 'sigterm-owned' ? `process.on('SIGTERM', () => process.exit(42));` : '',
          mode.startsWith('sigterm')
            ? `process.kill(process.pid, 'SIGTERM'); setTimeout(() => process.exit(99), 2000);`
            : mode === 'natural' ? '' : 'process.exit(0);',
        ].join('\n'));
        const result = spawnSync(process.execPath, ['--import', 'tsx/esm', host], {
          encoding: 'utf8', timeout: 15_000,
        });
        for (const entry of readFakeLog(log)) {
          if (entry.spawn) pids.push(entry.spawn);
          if (entry.grandchild) pids.push(entry.grandchild);
        }
        expect(result.error, result.stderr).toBeUndefined();
        expect(pids).toHaveLength(2);
        if (mode === 'sigterm') expect(result.signal).toBe('SIGTERM');
        else expect(result.status, result.stderr).toBe(mode.startsWith('sigterm-') ? 42 : 0);
        await expect.poll(() => pids.every((pid) => !pidAlive(pid)), { timeout: 5000 }).toBe(true);
      } finally {
        // Cleanup also runs on regression so a failing guardian test never leaks.
        for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
        rmSync(root, { recursive: true, force: true });
      }
    }, 25_000,
  );
});
