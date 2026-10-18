/**
 * MCP server-state accessor wiring and per-session option resolvers for
 * {@link SessionToolDispatcher}.
 *
 * Extracted from `dispatcher.ts` to keep that file within the 350-code-line
 * ceiling. Two concerns live here:
 *
 * 1. `GetMcpServerStates` / `resolveMcpServerStates` — normalise the optional
 *    MCP state accessor into the guaranteed non-null form `CoreExecDeps` needs
 *    so `unknownToolMessage` can name failing servers (#4064).
 *
 * 2. `resolveMaxOutputBytes` — extract the inline multi-condition guard from
 *    the constructor so the 350-line ceiling is not breached.
 *
 * @module agent/tools/dispatcher.mcp-states
 */

import type { McpServerStateLike } from '../mcp/failure-notice.js';

/** Shape of the getMcpServerStates option on SessionToolDispatcherOptions (#4064). */
export type GetMcpServerStates = () => readonly McpServerStateLike[];

/**
 * Resolve an optional `getMcpServerStates` option to a guaranteed accessor.
 * Returns `() => []` when the caller does not wire an MCP manager, so callers
 * of `unknownToolMessage` can call it unconditionally without a null check.
 */
export function resolveMcpServerStates(
  opt: GetMcpServerStates | undefined,
): GetMcpServerStates {
  return opt ?? (() => []);
}

/**
 * Validate and return a positive-finite `maxOutputBytes` cap, or `undefined`.
 *
 * Extracted from the dispatcher constructor so the inline multi-line condition
 * does not push `dispatcher.ts` over the 350-code-line ceiling.
 */
export function resolveMaxOutputBytes(raw: number | undefined): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}
