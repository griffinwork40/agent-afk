/**
 * Harness-only tool-result flags for the journal write path (#2978).
 *
 * A provider's native tool_result (Anthropic `tool_result` block, OpenAI
 * `role:'tool'` message) cannot carry `incomplete` / `incompleteReason` /
 * `partialNodeCount`: the object is sent to the API verbatim, and an unknown
 * key is a 400. So the flags ride beside it instead, keyed by object
 * identity, and the provider's `toJournal` reads them back when it writes the
 * journal `tool_result` block. That lets a facet rebuilt from the journal
 * alone see the compose soft-deadline partial signal (#2970).
 *
 * Invariant: keyed by identity in a `WeakMap`, so flags die with the native
 * object. An in-place edit (microcompaction replacing `content`) keeps them;
 * a clone has none, which only loses the flag, never invents one. Adapters
 * re-tag the natives they build from journal blocks on resume, so a later
 * resync writes the flags back.
 *
 * @module agent/journal/result-flags
 */

/** The journal-persisted subset of a tool result's partial-answer flags. */
export interface JournalResultFlags {
  incomplete?: true;
  incompleteReason?: string;
  partialNodeCount?: number;
}

/** Structural source: a `ToolResult` or a journal `tool_result` block. */
interface FlagSource {
  incomplete?: boolean;
  incompleteReason?: string;
  partialNodeCount?: number;
}

const flags = new WeakMap<object, JournalResultFlags>();

/**
 * Reduce `src` to the flags worth persisting: empty unless `incomplete` is
 * true. `partialNodeCount` is kept only as a non-negative integer.
 */
export function pickResultFlags(src: FlagSource): JournalResultFlags {
  if (src.incomplete !== true) return {};
  const n = src.partialNodeCount;
  return {
    incomplete: true,
    ...(src.incompleteReason ? { incompleteReason: src.incompleteReason } : {}),
    ...(typeof n === 'number' && Number.isInteger(n) && n >= 0 ? { partialNodeCount: n } : {}),
  };
}

/** Attach `src`'s flags to `native`. A no-op when `src` is not incomplete. */
export function tagResultFlags(native: object, src: FlagSource): void {
  const picked = pickResultFlags(src);
  if (picked.incomplete === true) flags.set(native, picked);
}

/** The flags tagged on `native`, as a spreadable object (`{}` when none). */
export function readResultFlags(native: object): JournalResultFlags {
  return flags.get(native) ?? {};
}
