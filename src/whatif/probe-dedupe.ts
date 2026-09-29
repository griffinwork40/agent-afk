/**
 * Near-duplicate probe deduplication for the what-if prediction engine.
 *
 * Normalises probe strings and drops exact and near-duplicate entries
 * (word-token Jaccard similarity >= threshold) before episodes are built.
 * Diversity in probes is essential: each probe should exercise a genuinely
 * different user request, not a rewording of another.
 *
 * @module whatif/probe-dedupe
 */

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a probe string for duplicate comparison:
 * lowercase → strip punctuation → collapse whitespace.
 */
function normaliseProbe(probe: string): string {
  return probe
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Jaccard similarity
// ---------------------------------------------------------------------------

/**
 * Word-token Jaccard similarity between two normalised strings.
 * Returns a value in [0, 1]; 1 = identical token sets.
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(' ').filter(Boolean));
  const tokensB = new Set(b.split(' ').filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DedupeResult {
  kept: string[];
  dropped: string[];
}

/**
 * Remove exact and near-duplicate probes from `probes`.
 *
 * Algorithm (order-preserving, keeps first occurrence):
 * 1. Normalise each probe (lowercase, strip punctuation, collapse whitespace).
 * 2. Drop exact normalised duplicates.
 * 3. Drop near-duplicates where word-token Jaccard similarity against any
 *    already-kept probe >= `threshold` (default 0.8).
 *
 * @param probes    Array of probe strings; may contain duplicates.
 * @param threshold Jaccard similarity threshold for near-duplicate removal
 *                  (default 0.8). Must be in (0, 1].
 */
export function dedupeProbes(probes: string[], threshold = 0.8): DedupeResult {
  const kept: string[] = [];
  const dropped: string[] = [];
  const keptNorm: string[] = [];

  for (const probe of probes) {
    const norm = normaliseProbe(probe);

    // Exact duplicate (by normalised form)?
    if (keptNorm.includes(norm)) {
      dropped.push(probe);
      continue;
    }

    // Near-duplicate (Jaccard >= threshold against any already-kept)?
    let isNearDup = false;
    for (const k of keptNorm) {
      if (jaccardSimilarity(norm, k) >= threshold) {
        isNearDup = true;
        break;
      }
    }

    if (isNearDup) {
      dropped.push(probe);
    } else {
      kept.push(probe);
      keptNorm.push(norm);
    }
  }

  return { kept, dropped };
}
