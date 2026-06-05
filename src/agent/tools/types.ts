/**
 * Shared types for the session-level tool system.
 *
 * Re-exports `ToolCall` and `ToolResult` from the provider boundary so
 * tool handlers and the session dispatcher don't import from
 * `providers/anthropic-direct/` directly.
 *
 * @module agent/tools/types
 */

export type { ToolCall, ToolResult, RenderHints } from '../providers/anthropic-direct/types.js';
export type { AnthropicToolDef } from '../providers/anthropic-direct/types.js';
export type { ToolDispatcher } from '../providers/anthropic-direct/tool-dispatcher.js';

import type { ToolResult } from '../providers/anthropic-direct/types.js';

/**
 * Per-invocation context forwarded to every tool handler.
 *
 * All fields are optional so callers that don't set a field retain the
 * same behavior as before this type was introduced (back-compat default).
 *
 * Containment model:
 *   - `resolveBase` anchors relative-path resolution and is the
 *     non-revocable session anchor.
 *   - `readRoots`  gates read-class tools  (read_file, glob, grep,
 *     list_directory). Defaults to `[resolveBase]` when unset.
 *   - `writeRoots` gates write-class tools (write_file, edit_file).
 *     Defaults to `[resolveBase]` when unset.
 *   - A path is allowed if it falls inside ANY root in the list.
 *
 * Back-compat: the legacy `cwd` field is kept as an alias for
 * `resolveBase` so existing callers (including tests) that set only
 * `{ cwd: x }` continue to work without change.
 */
export interface ToolHandlerContext {
  /**
   * @deprecated Prefer `resolveBase`. Kept for back-compat; treated as an
   * alias for `resolveBase` inside the shared `resolveAndContain` helper.
   */
  cwd?: string;
  /** Path-resolution anchor for relative paths. Was: cwd. */
  resolveBase?: string;
  /**
   * Allowed roots for read-class tools (read_file, glob, grep,
   * list_directory). Defaults to `[resolveBase]` when unset.
   */
  readRoots?: string[];
  /**
   * Allowed roots for write-class tools (write_file, edit_file) and bash
   * spawn cwd. Defaults to `[resolveBase]` when unset.
   */
  writeRoots?: string[];
  /**
   * Extra environment variables to inject into Bash-tool subprocess
   * spawns. Merged into the child's env on top of `process.env`, with
   * these entries winning on collision.
   *
   * Used by `executePluginSkill` to inject `PLUGIN_ROOT=<plugin.path>`
   * so that shell commands inside plugin SKILL.md bodies — e.g.
   * `python3 "${PLUGIN_ROOT}/scripts/foo.py"` — resolve correctly.
   * Per-context (not per-process) so concurrent plugin-skill subagents
   * don't clobber each other's PLUGIN_ROOT.
   *
   * Tool handlers other than Bash currently ignore this field; if a
   * future handler needs env-aware behavior, it can read this same key.
   */
  env?: Record<string, string>;
}

/**
 * A tool handler function. Receives the model's decoded JSON input, a
 * per-turn cancellation signal, and an optional per-session context.
 * Returns a `ToolResult` with the content to feed back to the model.
 * May throw — the `SessionToolDispatcher` catches and wraps as `{ isError: true }`.
 */
export type ToolHandler = (
  input: unknown,
  signal: AbortSignal,
  context?: ToolHandlerContext,
) => Promise<ToolResult>;

/**
 * Returns `true` when a tool call is safe to run concurrently with other
 * safe calls in the same batch. The `input` parameter is provided for
 * future input-dependent classification (e.g., read-only bash commands).
 */
export type ConcurrencyClassifier = (
  toolName: string,
  input?: unknown,
) => boolean;
