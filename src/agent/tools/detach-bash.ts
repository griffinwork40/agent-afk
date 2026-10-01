/**
 * Bash-specific detach helpers for the Ctrl+B contract (#2542).
 *
 * Extracted from `handlers/bash.ts` to keep that file under the 350-line
 * ceiling. The bash handler calls {@link applyBashDetach} when the
 * `detachRegistry` is present in the handler context, enabling Ctrl+B to free
 * the model's turn while keeping the shell process running.
 *
 * Flow:
 *   1. After spawning the process but before waiting on its output, the handler
 *      calls `applyBashDetach(...)`. That function:
 *       a. Registers the call with the detach registry (returns a token).
 *       b. Installs a once-listener on `token.detachSignal`.
 *   2. If Ctrl+B fires: the listener calls the provided `onDetach` callback,
 *      which the bash handler defines as a closure over its local state.
 *   3. When the process eventually closes, `onDetach` must wire a separate
 *      `proc.once('close', ...)` for late delivery via `token.deliver()`.
 *   4. The registry emits 'settled'; the REPL's notifier injects the result.
 *
 * OpenAI-compatible parity (Invariant:D2): both provider loops call
 * `dispatcher.execute()` → `callHandlerContext()` → the same bash handler.
 * The detach contract lives entirely inside the handler and the shared
 * `ToolHandlerContext` — no provider-specific code path is needed.
 *
 * @module agent/tools/detach-bash
 */

import type { DetachableToolRegistry, DetachToken, DetachedToolResult } from './detach-registry.js';

/**
 * Maximum characters of the command to include in the detach label shown to
 * the user. Keep short — it appears inline in the notification line.
 */
const MAX_LABEL_CHARS = 60;

/**
 * Build the human-readable label for a detached bash call.
 * Collapses whitespace and truncates with an ellipsis.
 */
export function bashDetachLabel(command: string): string {
  const collapsed = command.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_LABEL_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

/**
 * Build the {@link DetachedToolResult} delivered to the registry's 'settled'
 * notifier once the detached process actually finishes.
 */
export function buildBashDelivery(
  toolUseId: string,
  label: string,
  output: string,
  exitCode: number | undefined,
  startedAt: number,
): DetachedToolResult {
  const status = exitCode === 0 || exitCode === undefined ? 'completed' : 'failed';
  return { toolUseId, label, status, output, exitCode, durationMs: Date.now() - startedAt };
}

/**
 * Wire the detach contract into an in-flight bash execution.
 *
 * Registers the call with the registry and installs a one-time 'abort'
 * listener on the returned token's `detachSignal`. When the signal fires,
 * `token.notifyDetached()` is called and then `onDetach(token, label)` is
 * invoked so the bash handler (which owns the local process/resolve state)
 * can complete the detach without this helper closing over those variables.
 *
 * The guard `token.shouldDetach()` ensures the callback never fires after
 * the process has already settled normally (idempotent).
 *
 * @returns The registered token (for testing / introspection).
 */
export function applyBashDetach(
  registry: DetachableToolRegistry,
  toolUseId: string,
  command: string,
  onDetach: (token: DetachToken, label: string) => void,
): DetachToken {
  const label = bashDetachLabel(command);
  const token = registry.register(toolUseId);
  token.detachSignal.addEventListener('abort', () => {
    if (!token.shouldDetach()) return; // normal close already settled
    token.notifyDetached();
    onDetach(token, label);
  }, { once: true });
  return token;
}

/**
 * Set of tool names that opt in to the detach contract.
 * Literal names (not imported constants) keep this a dependency-free leaf;
 * tests pin them against real tool-name constants.
 *
 * Invariant: tools listed here MUST call `applyBashDetach` (or equivalent)
 * and implement the full token lifecycle. A tool that registers but never
 * delivers leaks the registry slot until session end / cancelAll().
 */
export const DETACHABLE_TOOLS: ReadonlySet<string> = new Set(['bash']);

export function isDetachableTool(name: string): boolean {
  return DETACHABLE_TOOLS.has(name);
}

/** Re-export registry type for use in the dispatcher without importing the full module. */
export type { DetachableToolRegistry };
