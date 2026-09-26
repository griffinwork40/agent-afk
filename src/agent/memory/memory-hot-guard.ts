/**
 * Structural guard: child sessions may never write hot memory.
 *
 * Invariant: a forked sub-agent must not rewrite HOT.md. HOT.md is injected
 * verbatim into every future session's system prompt, so an unsupervised
 * child write mutates the ambient context of the parent and of every session
 * after it.
 *
 * Contract: this guard is the load-bearing enforcement point, applied where
 * the memory handlers are built for a child dispatcher. It does NOT depend on
 * a hook registry being present. `createChildMemoryHotBlockHook` (a PreToolUse
 * hook) remains as an earlier, friendlier rejection on first-party surfaces,
 * but hooks only run when a registry reaches the dispatcher, and library
 * embedders (`query()` / `AgentSession` from `src/index.ts`) can leave
 * `config.hookRegistry` undefined. Before #2093 children could not call
 * `memory_update` at all; this guard keeps that guarantee for target:"hot"
 * while allowing target:"fact".
 *
 * The child signal is `readOnlyState`, which `createChildProviderFactory`
 * (src/agent/tools/nesting.ts) sets on every child it builds.
 *
 * @module agent/memory/memory-hot-guard
 */

import type { ToolHandler } from '../tools/types.js';

/** Returned to the model when a child session attempts a hot-memory write. */
export const CHILD_HOT_WRITE_DENIED =
  'memory_update error: sub-agent sessions may not write target:"hot" (HOT.md is injected into ' +
  'every future session\'s system prompt). Use target:"fact" to persist findings to the ' +
  'searchable archive instead.';

/**
 * Wrap `memory_update` in `handlers` so target:"hot" is rejected when
 * `isChildSession` is true. Returns `handlers` unchanged for top-level
 * sessions. The input map is never mutated; a copy is returned for children.
 */
export function guardChildHotWrites(
  handlers: Map<string, ToolHandler>,
  isChildSession: boolean,
): Map<string, ToolHandler> {
  if (!isChildSession) return handlers;
  const inner = handlers.get('memory_update');
  if (inner === undefined) return handlers;
  const guarded = new Map(handlers);
  guarded.set('memory_update', async (input, ...rest) => {
    const target = (input as { target?: unknown } | null | undefined)?.target;
    if (target === 'hot') return { content: CHILD_HOT_WRITE_DENIED, isError: true };
    return inner(input, ...rest);
  });
  return guarded;
}
