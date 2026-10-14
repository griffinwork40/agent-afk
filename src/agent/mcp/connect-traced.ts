/**
 * Traced MCP connection helper.
 *
 * Wraps `McpManager.fromConfig` in the standard `mcp_connect_start` /
 * `mcp_connect_done` witness-phase bracket that was previously duplicated
 * in `chat.mcp-setup.ts` and `web-server/session-owner.wiring.ts`.
 *
 * Does NOT handle config-loading, import resolution, or warning routing —
 * those are caller responsibilities. Callers that need additional console
 * output (e.g. `connectReplMcp`) should continue using their own wrappers.
 *
 * @module agent/mcp/connect-traced
 */

import { McpManager } from './manager.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { LoadedMcpConfig } from './config-loader.js';
import type { TraceSink } from '../trace/writer.js';

/**
 * Connect to all enabled MCP servers in `loaded`, bracketed by
 * `mcp_connect_start` / `mcp_connect_done` trace phases.
 *
 * @param loaded  - Result of `loadMcpConfig()`. The caller is responsible for
 *                  checking `enabledCount > 0` before calling; this function
 *                  asserts that invariant in tests but does not guard it at
 *                  runtime (to avoid hiding misconfiguration silently).
 * @param traceSink - Optional witness-layer sink. Forwarded to
 *                    `McpManager.fromConfig` and to `emitSessionPhase`.
 *                    Accepts `TraceSink` (the common base) so both
 *                    `TraceWriter` and plain-sink callers can pass their
 *                    handle without an upcast.
 * @returns The connected `McpManager`.
 * @throws  Re-throws any error from `McpManager.fromConfig` (e.g. `alwaysLoad`
 *          server failures, wire-name collisions) after emitting
 *          `mcp_connect_done` in the `finally` block.
 */
export async function connectMcpTraced(
  loaded: LoadedMcpConfig,
  traceSink: TraceSink | undefined,
): Promise<McpManager> {
  const enabledCount = Object.values(loaded.mcpServers).filter((s) => !s.disabled).length;

  const mcpStartedAt = Date.now();
  void emitSessionPhase(traceSink, {
    phase: 'mcp_connect_start',
    metadata: { serverCount: enabledCount },
  });

  let manager: McpManager;
  try {
    manager = await McpManager.fromConfig(loaded.mcpServers, {
      warnings: loaded.warnings,
      serverLayers: loaded.serverLayers,
      userAllowSecretEnv: loaded.userAllowSecretEnv,
      ...(traceSink !== undefined ? { traceWriter: traceSink } : {}),
    });
  } finally {
    void emitSessionPhase(traceSink, {
      phase: 'mcp_connect_done',
      durationMs: Date.now() - mcpStartedAt,
      metadata: { serverCount: enabledCount },
    });
  }

  return manager;
}
