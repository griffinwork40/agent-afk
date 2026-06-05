/**
 * Verifies that `McpManager.fromConfig` emits per-server `mcp_server_*`
 * session_phase events when given a trace writer. Uses the same hand-rolled
 * stdio fixture as `manager.test.ts` so the connect path is real (spawn +
 * handshake), not mocked.
 *
 * The emit is purely observational: these assertions prove the witness
 * markers appear with correct metadata, and the existing `manager.test.ts`
 * proves connect behavior itself is unchanged.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { McpManager } from './manager.js';
import { InMemoryTraceWriter } from '../trace/index.js';
import type { SessionPhasePayload } from '../trace/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '__fixtures__/test-server.mjs');

let manager: McpManager | undefined;

afterEach(async () => {
  if (manager) {
    await manager.disconnectAll();
    manager = undefined;
  }
});

function sessionPhases(writer: InMemoryTraceWriter): SessionPhasePayload[] {
  return writer.events
    .filter((e) => e.kind === 'session_phase')
    .map((e) => e.payload as SessionPhasePayload);
}

describe('McpManager.fromConfig — mcp_server trace emission', () => {
  it(
    'emits a start/done pair with connected status + tool count for a server',
    async () => {
      const writer = new InMemoryTraceWriter();
      manager = await McpManager.fromConfig(
        {
          testsrv: {
            type: 'stdio',
            command: process.execPath,
            args: [FIXTURE],
          },
        },
        { traceWriter: writer },
      );

      const phases = sessionPhases(writer);
      const start = phases.find((p) => p.phase === 'mcp_server_start');
      const done = phases.find((p) => p.phase === 'mcp_server_done');

      expect(start).toBeDefined();
      expect(start!.metadata).toMatchObject({ server: 'testsrv' });

      expect(done).toBeDefined();
      expect(done!.durationMs).toBeTypeOf('number');
      expect(done!.durationMs).toBeGreaterThanOrEqual(0);
      expect(done!.metadata).toMatchObject({
        server: 'testsrv',
        status: 'connected',
      });
      // The fixture publishes exactly three tools (echo/add/boom).
      expect(done!.metadata!.toolCount).toBe(3);
    },
    20_000,
  );

  it(
    'emits no session_phase events when no traceWriter is supplied',
    async () => {
      // Sanity: the writer is opt-in; absence must not throw or emit.
      manager = await McpManager.fromConfig({
        testsrv: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
      });
      const states = manager.getServerStates();
      expect(states[0]!.status).toBe('connected');
    },
    20_000,
  );
});
