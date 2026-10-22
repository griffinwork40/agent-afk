/**
 * Dependency-free token estimator (chars / 3.5, ceiling).
 *
 * Leaf module on purpose: `memory-store.ts` pulls in better-sqlite3, so
 * callers on the config-load path (the AFK.md tier) import this file directly
 * instead of the `agent/memory` barrel. `memory-store.ts` re-exports it, so
 * every existing `estimateTokens` import keeps working unchanged.
 *
 * @module agent/memory/estimate-tokens
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
