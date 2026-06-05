/**
 * Live-refresh integration test for the `notifications/tools/list_changed`
 * path wired in PR 3.
 *
 * What this test proves end-to-end:
 *   - A connected MCP server can send `notifications/tools/list_changed`.
 *   - The manager's `onToolListChanged` closure calls `refreshServer()`.
 *   - `refreshServer()` re-lists tools and merges new wire-name entries.
 *   - `getMcpTools()` / `getMcpHandlers()` / `getMcpToolWireNames()` return
 *     the updated set on the very next call (Option A: read fresh per-query).
 *   - The new tool is callable through the bridged handler.
 *   - `onToolsRefreshed` fires for observability.
 *
 * Timing strategy: the test waits on `onToolsRefreshed` (a Promise-resolver)
 * to know the refresh completed, then asserts. We do NOT poll. The trigger
 * file is created AFTER `fromConfig()` resolves so the server's initial
 * tools/list returns the pre-trigger set deterministically.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { McpManager } from './manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '__fixtures__/test-server-dynamic.mjs');

let manager: McpManager | undefined;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-refresh-'));
});

afterEach(async () => {
  if (manager) {
    await manager.disconnectAll();
    manager = undefined;
  }
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Wait up to `timeoutMs` for `onToolsRefreshed(serverName)` to fire for
 * the given server. Returns a Promise the test can `await`.
 *
 * Constraint (externally-governed — async notification path): we MUST
 * register the listener BEFORE writing the trigger file. Otherwise the
 * server can win the race and the refresh completes before we subscribe.
 */
function waitForRefresh(
  mgr: McpManager,
  serverName: string,
  timeoutMs = 4000,
): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(
      () => rejectFn(new Error(`refresh for ${serverName} did not fire within ${timeoutMs}ms`)),
      timeoutMs,
    );
    mgr.onToolsRefreshed = (name) => {
      if (name === serverName) {
        clearTimeout(timer);
        resolveFn();
      }
    };
  });
}

describe('McpManager — notifications/tools/list_changed live refresh', () => {
  it(
    'picks up a newly-registered tool without restarting the session',
    async () => {
      const triggerPath = join(tmp, 'trigger');
      manager = await McpManager.fromConfig({
        dyn: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
          env: { MCP_FIXTURE_TRIGGER_FILE: triggerPath },
        },
      });

      // Pre-trigger snapshot: only `ping` is bridged.
      const before = manager.getMcpToolWireNames().sort();
      expect(before).toEqual(['mcp__dyn__ping']);

      // Subscribe BEFORE writing the trigger — see constraint comment above.
      const refreshed = waitForRefresh(manager, 'dyn');
      writeFileSync(triggerPath, '');

      await refreshed;

      // Post-refresh: both `ping` and `pong` are bridged.
      const after = manager.getMcpToolWireNames().sort();
      expect(after).toEqual(['mcp__dyn__ping', 'mcp__dyn__pong']);

      // The new tool's schema is also returned by `getMcpTools()`.
      const tools = manager.getMcpTools();
      const pong = tools.find((t) => t.name === 'mcp__dyn__pong');
      expect(pong).toBeDefined();
      expect(pong?.description).toContain('Returns "ping"');

      // The new tool is callable through the bridged handler.
      const handlers = manager.getMcpHandlers();
      const pongHandler = handlers.get('mcp__dyn__pong');
      expect(pongHandler).toBeDefined();
      const signal = new AbortController().signal;
      const result = await pongHandler!({}, signal, { sessionId: 'test' });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain('ping');

      // toolCount on the server state was updated in place.
      const state = manager.getServerStates().find((s) => s.serverName === 'dyn');
      expect(state?.toolCount).toBe(2);
    },
    10_000,
  );

  it(
    'refreshServer() throws when the server is not connected',
    async () => {
      manager = await McpManager.fromConfig({
        absent: {
          type: 'stdio',
          command: '/this/path/does/not/exist-mcp',
        },
      });
      // Server should have failed to connect — refreshServer rejects.
      await expect(manager.refreshServer('absent')).rejects.toThrow(/not connected/);
    },
    8_000,
  );

  it(
    'refreshServer() throws when the server name is unknown',
    async () => {
      manager = await McpManager.fromConfig({});
      await expect(manager.refreshServer('nope')).rejects.toThrow(/not connected/);
    },
  );
});
