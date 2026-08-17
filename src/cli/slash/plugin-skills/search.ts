/**
 * Intent-based fuzzy search for the `/skills <query>` path.
 *
 * When a user passes a query to `/skills`, this module scores every skill
 * across NAME + DESCRIPTION + HINT text and returns results ranked best-first.
 *
 * Ranking tiers (lower score = better match):
 *   0 — exact prefix on the bare skill name (e.g. "min" → "/mint")
 *   1 — subsequence match on the bare skill name
 *   2 — substring match anywhere in description or hint text
 *   3 — subsequence match anywhere in description or hint text
 *
 * Within a tier, results are sorted alphabetically by bare skill name for
 * stability. Skills that do not match in any tier are omitted.
 *
 * The subsequence matcher mirrors `isSubsequence` from `../../../cli/input/slash-match.ts`
 * (kept local so this module has zero dependency on the slash-match layer,
 * which carries browser-safe constraints this file does not share).
 */

export interface SearchableSkill {
  /** Bare slash name without leading `/`, e.g. `mint`, `plugin:deploy`. */
  name: string;
  /** One-line description used for the listing and for search scoring. */
  description: string;
  /** Optional short hint text (argumentHint / whenToUse excerpt). */
  hint?: string;
}

export interface SearchResult {
  skill: SearchableSkill;
  /** Tier: 0=name-prefix, 1=name-subsequence, 2=desc-substring, 3=desc-subsequence. */
  tier: 0 | 1 | 2 | 3;
}

/**
 * True when every character of `needle` appears in `haystack` in order.
 * Both inputs are expected pre-lowercased. Mirrors `isSubsequence` in
 * `src/cli/input/slash-match.ts` — kept here so this module is self-contained.
 */
function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Score a single skill against a lowercased query.
 * Returns the tier (0–3) on match, or `null` on no match.
 */
function scoreSingle(skill: SearchableSkill, q: string): 0 | 1 | 2 | 3 | null {
  const nameLow = skill.name.toLowerCase();
  // Strip any namespace prefix (e.g. `plugin:deploy` → `deploy`) for matching
  // the bare part, but also match the full namespaced name.
  const bareLow = nameLow.includes(':') ? nameLow.split(':').pop()! : nameLow;

  // Tier 0: name prefix match (bare or full namespaced)
  if (bareLow.startsWith(q) || nameLow.startsWith(q)) return 0;

  // Tier 1: subsequence on name
  if (isSubsequence(q, bareLow) || isSubsequence(q, nameLow)) return 1;

  const descLow = skill.description.toLowerCase();
  const hintLow = (skill.hint ?? '').toLowerCase();
  const combined = `${descLow} ${hintLow}`;

  // Tier 2: substring anywhere in description+hint
  if (combined.includes(q)) return 2;

  // Tier 3: subsequence in description+hint
  if (isSubsequence(q, combined)) return 3;

  return null;
}

/**
 * Search a universe of skills for `query`. Returns ranked results (best
 * match first), with each tier sorted alphabetically by bare name for
 * stability. Unmatched skills are excluded.
 *
 * An empty or whitespace-only query returns all skills unsorted (caller
 * should fall through to the full listing path).
 *
 * Multi-word queries: each whitespace-delimited token is scored independently
 * via `scoreSingle`. A skill matches only when ALL tokens match; the result
 * tier is the MAX (worst) tier across all tokens, ensuring multi-word queries
 * are as strict or stricter than their individual tokens.
 */
export function searchSkills(
  universe: readonly SearchableSkill[],
  query: string,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  const tokens = q.split(/\s+/).filter((t) => t.length > 0);

  const buckets: [SearchResult[], SearchResult[], SearchResult[], SearchResult[]] = [[], [], [], []];

  for (const skill of universe) {
    let tier: 0 | 1 | 2 | 3 | null;

    if (tokens.length === 1) {
      // Single-token path — unchanged behaviour.
      tier = scoreSingle(skill, tokens[0]!);
    } else {
      // Multi-token path: ALL tokens must match; take the MAX (worst) tier.
      let maxTier: 0 | 1 | 2 | 3 = 0;
      let allMatch = true;
      for (const token of tokens) {
        const t = scoreSingle(skill, token);
        if (t === null) { allMatch = false; break; }
        if (t > maxTier) maxTier = t as 0 | 1 | 2 | 3;
      }
      tier = allMatch ? maxTier : null;
    }

    if (tier !== null) {
      buckets[tier].push({ skill, tier });
    }
  }

  // Within each tier, sort alphabetically by bare name for stable output.
  const byName = (a: SearchResult, b: SearchResult): number =>
    a.skill.name.localeCompare(b.skill.name);
  for (const bucket of buckets) bucket.sort(byName);

  return ([] as SearchResult[]).concat(...buckets);
}
