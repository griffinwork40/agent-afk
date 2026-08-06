/**
 * Invariant: a provenance cache is valid for exactly ONE synchronous pass and
 * must never be retained across an `await`.
 *
 * `resolveConfigProvenance()` re-reads the same handful of files for every key
 * it resolves (the raw user file, plus each tier read through the loader's
 * validator). One key is cheap; a menu render resolves every key in a category,
 * so a 20-key screen costs ~80 `readFileSync` + `JSON.parse` cycles over four
 * files whose contents cannot change mid-render.
 *
 * The fix is a memo the CALLER owns, not a module-global one: config files are
 * mutable at runtime — `/config` itself writes them — so a cache that outlives
 * the render that made it would show the user the value they just replaced.
 * Scoping the lifetime to a caller-held object makes staleness structurally
 * impossible instead of merely unlikely (no mtime heuristic, no invalidation
 * hook to forget). Create one per render pass, pass it down, drop it.
 *
 * @module cli/config/provenance-cache
 */

/** A parsed config-file view, or undefined when the loader would skip the file. */
type TierObject = Record<string, unknown> | undefined;

/**
 * Memo over the two file reads behind provenance resolution, keyed by path.
 *
 * The two reads are kept separate because they answer different questions about
 * the same bytes: `raw` is the literal file contents (what an edit replaces),
 * `validated` is the loader's view (what will actually load). Sharing one key
 * space would let a raw read satisfy a validated one and misreport coerced or
 * rejected values.
 */
export interface ProvenanceCache {
  /** Memoized raw (unvalidated) read of `file`. */
  raw(file: string, compute: () => TierObject): TierObject;
  /** Memoized validated read of `file`. */
  validated(file: string, compute: () => TierObject): TierObject;
}

/** A fresh, empty cache. Discard it at the end of the pass that created it. */
export function createProvenanceCache(): ProvenanceCache {
  const rawReads = new Map<string, TierObject>();
  const validatedReads = new Map<string, TierObject>();
  // `undefined` is a real result (absent / malformed / rejected file), so
  // membership — not the stored value — decides whether to recompute.
  const memo = (store: Map<string, TierObject>, file: string, compute: () => TierObject) => {
    if (store.has(file)) return store.get(file);
    const value = compute();
    store.set(file, value);
    return value;
  };
  return {
    raw: (file, compute) => memo(rawReads, file, compute),
    validated: (file, compute) => memo(validatedReads, file, compute),
  };
}

/**
 * Null-object cache: computes every time, caches nothing. The default for
 * one-shot callers (a single `/config set`), so they neither opt in to caching
 * nor pay a branch at each read site.
 */
export const NO_PROVENANCE_CACHE: ProvenanceCache = {
  raw: (_file, compute) => compute(),
  validated: (_file, compute) => compute(),
};
