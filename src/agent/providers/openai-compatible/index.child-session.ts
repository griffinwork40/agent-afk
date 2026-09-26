/**
 * Child-session option and helpers for {@link OpenAICompatibleProvider}.
 *
 * Extracted from `index.ts` to keep the file ceiling under 428 code lines.
 * The public surface of `index.ts` is unchanged — callers set
 * `OpenAICompatibleProviderOptions.readOnlyState` exactly as before.
 *
 * Also re-exports `stateToolSchemas` / `stateReadToolSchemas` so
 * `index.ts` can replace two separate state-related import lines with
 * one import from this sibling, keeping the net code-line count below the
 * baseline.
 *
 * @module agent/providers/openai-compatible/index.child-session
 */

export { stateToolSchemas, stateReadToolSchemas } from '../../state/state-schemas.js';

/**
 * Extra options carried by child sessions (sub-agents forked by
 * {@link createChildProviderFactory}).  Merged into
 * {@link OpenAICompatibleProviderOptions} via interface extension.
 */
export interface ChildSessionOptions {
  /**
   * When true, expose only `state_get` and `state_query` (no state_put/cas/delete).
   * Independent of `readOnlyMemory` — child sessions can write facts while being
   * denied state-store mutations. Set by `createChildProviderFactory`.
   */
  readOnlyState?: boolean;
}

/**
 * Returns true when state-store writes should be blocked: either the session is
 * fully read-only (`readOnlyMemory`) or it is a child session that may write
 * facts but must not mutate the state store (`readOnlyState`).
 */
export function isStateRestricted(
  readOnlyMemory: boolean | undefined,
  readOnlyState: boolean | undefined,
): boolean {
  return readOnlyMemory === true || readOnlyState === true;
}

/**
 * Returns true when the read-only memory-prompt variant should be used.
 * Child sessions (`readOnlyState`) can write facts but not hot memory, so
 * they receive the same constrained prompt as fully read-only sessions.
 */
export function isMemoryRestricted(
  readOnlyMemory: boolean | undefined,
  readOnlyState: boolean | undefined,
): boolean {
  return (readOnlyMemory ?? false) || (readOnlyState ?? false);
}
