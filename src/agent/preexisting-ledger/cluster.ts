/**
 * Clustering and ranking logic for pre-existing-defect hits.
 *
 * Extracted from `scripts/backfill-preexisting-ledger.ts` so that unit
 * tests can exercise the real implementation rather than a copy.
 *
 * @module agent/preexisting-ledger/cluster
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterHit {
  locus: string;
  signal: string;
  category: string;
  transcriptFile: string;
  sessionDate: string;
}

export interface Cluster {
  locus: string;
  category: string;
  sessionCount: number;
  transcriptFiles: string[];
  lastSeen: string;
}

// ---------------------------------------------------------------------------
// clusterHits
// ---------------------------------------------------------------------------

/**
 * Groups hits by normalized locus, deduplicates within the same transcript
 * file, and ranks by descending session count then descending lastSeen.
 */
export function clusterHits(hits: ClusterHit[]): Cluster[] {
  // Normalise locus: trim backticks and whitespace.
  const normalize = (l: string) => l.replace(/^`|`$/g, '').trim();

  const map = new Map<string, { category: string; files: Set<string>; dates: string[] }>();
  for (const hit of hits) {
    const key = normalize(hit.locus);
    if (!map.has(key)) {
      map.set(key, { category: hit.category, files: new Set(), dates: [] });
    }
    const entry = map.get(key)!;
    entry.files.add(hit.transcriptFile);
    if (hit.sessionDate) entry.dates.push(hit.sessionDate);
  }

  const clusters: Cluster[] = [];
  for (const [locus, { category, files, dates }] of map.entries()) {
    const lastSeen = dates.length > 0 ? dates.sort().at(-1)! : '';
    clusters.push({ locus, category, sessionCount: files.size, transcriptFiles: [...files], lastSeen });
  }

  // Rank: descending sessionCount, then descending lastSeen.
  clusters.sort((a, b) => {
    if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount;
    return b.lastSeen.localeCompare(a.lastSeen);
  });

  return clusters;
}
