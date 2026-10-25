/**
 * SDK-owned MCP manager lifecycle for `AgentSession`.
 *
 * When a caller passes `AgentConfig.mcpServers` WITHOUT `AgentConfig.mcpManager`,
 * the SDK builds and owns a manager via `McpManager.fromConfig`. The owned
 * manager is disconnected by `AgentSession.close()`; a caller-supplied
 * `mcpManager` is NEVER disconnected by the SDK (the caller owns its lifecycle).
 *
 * Isolation rule: this module is the only place where `McpManager.fromConfig`
 * is called on the SDK session path. Surface-specific paths (CLI, Telegram,
 * web-server) continue to build their own managers before constructing
 * `AgentSession` and pass them in as `config.mcpManager`.
 *
 * @module agent/session/agent-session.mcp
 */

import { McpManager } from '../mcp/manager.js';
import type { AgentConfig } from '../types.js';

/**
 * Result of `initSdkOwnedMcpManager`. `ownedManager` is non-null only when
 * the SDK built a manager from `config.mcpServers`; the caller must disconnect
 * it on session close. `resolvedManager` is whichever manager the provider
 * should use (caller-supplied or SDK-built), or `undefined` when none applies.
 */
export interface SdkMcpResult {
  /** The manager the SDK built and owns (must be disconnected on close). */
  ownedManager: McpManager | undefined;
  /**
   * The manager to thread into the provider. Equal to `config.mcpManager`
   * when the caller supplied one, or to `ownedManager` when the SDK built
   * one from `config.mcpServers`, or `undefined` when neither applies.
   */
  resolvedManager: McpManager | undefined;
}

/**
 * Disconnect an SDK-owned MCP manager, swallowing errors (close is best-effort).
 * No-op when `manager` is undefined (no SDK-owned manager for this session).
 */
export async function disconnectOwnedManager(manager: McpManager | undefined): Promise<void> {
  if (manager !== undefined) await manager.disconnectAll().catch(() => {});
}

/**
 * Start the async MCP manager construction from `config.mcpServers` and return
 * a promise that patches the session's owned/resolved manager fields when done.
 *
 * Extracted from `AgentSession` constructor to keep `agent-session.ts` within
 * the 350-code-line ceiling. The callbacks write directly into the calling
 * `AgentSession`'s private fields — caller supplies them as lambdas.
 *
 * @param config           - Current `AgentConfig`.
 * @param setOwnedManager  - Stores the SDK-built manager for later disconnect.
 * @param patchConfig      - Patches `config.mcpManager` with the resolved manager.
 * @param isClosed         - Returns true when `AgentSession.close()` has run.
 *
 * Close-before-resolve (item 3): if the session is closed while `fromConfig`
 * is in flight, `setOwnedManager` / `patchConfig` are skipped and the
 * newly-built manager is disconnected immediately. The caller's
 * `disconnectOwnedManager(this.ownedMcpManager)` in `close()` is a no-op
 * because `this.ownedMcpManager` was never set. Caller-supplied managers
 * are never disconnected here (they have no `ownedManager`).
 */
export function startMcpInit(
  config: AgentConfig,
  setOwnedManager: (m: McpManager) => void,
  patchConfig: (m: McpManager) => void,
  isClosed: () => boolean,
): Promise<void> {
  return initSdkOwnedMcpManager(config).then(({ ownedManager, resolvedManager }) => {
    if (isClosed()) {
      // Session closed while MCP init was in flight: disconnect the freshly-
      // built owned manager immediately instead of registering it for later.
      // Caller-supplied managers (ownedManager === undefined) are never touched.
      if (ownedManager !== undefined) {
        void ownedManager.disconnectAll().catch(() => {});
      }
      return;
    }
    if (ownedManager !== undefined) setOwnedManager(ownedManager);
    if (resolvedManager !== undefined) patchConfig(resolvedManager);
  });
}

/**
 * Build an SDK-owned `McpManager` from `config.mcpServers` when needed.
 *
 * Decision table:
 *   - `config.mcpManager` is set → return it as `resolvedManager`, no SDK ownership.
 *   - `config.mcpServers` is set (and non-empty) → build + return an SDK-owned manager.
 *   - Neither → return `{ ownedManager: undefined, resolvedManager: undefined }`.
 *
 * Failures from `McpManager.fromConfig` propagate to the caller (they will
 * surface on `AgentSession.waitForInitialization()` via the init-promise chain).
 * Non-`alwaysLoad` server failures are recorded as `status: 'error'` in
 * `mcpServerStatus()` — they do not throw.
 */
export async function initSdkOwnedMcpManager(config: AgentConfig): Promise<SdkMcpResult> {
  // Caller-supplied manager wins; SDK never owns or disconnects it.
  if (config.mcpManager !== undefined) {
    return { ownedManager: undefined, resolvedManager: config.mcpManager };
  }

  const servers = config.mcpServers;
  if (servers === undefined || Object.keys(servers).length === 0) {
    return { ownedManager: undefined, resolvedManager: undefined };
  }

  // Build an SDK-owned manager. All servers default to the 'user-global' trust
  // layer (no project-level env-containment restrictions) because the SDK path
  // receives configs programmatically — not from an untrusted project .mcp.json.
  const manager = await McpManager.fromConfig(servers);
  return { ownedManager: manager, resolvedManager: manager };
}
