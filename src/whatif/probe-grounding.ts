/**
 * Probe-grounding for the what-if prediction engine.
 *
 * Validates path-like tokens in synthetic probes against the repo manifest.
 * Probes that reference non-existent paths are dropped before episode
 * construction; dropped probes are recorded for results.json.
 *
 * @module whatif/probe-grounding
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DroppedProbe {
  /** Prediction id that contained this probe (e.g. "p1"). */
  predictionId: string;
  /** The original probe text. */
  probe: string;
  /** Human-readable reason, e.g. "references non-existent path: src/main.py". */
  reason: string;
}

/** Minimum shape required by groundProbes — any object with id and probes. */
export interface GroundedPrediction {
  id: string;
  probes: string[];
}

export interface GroundProbesResult<T extends GroundedPrediction> {
  /** Predictions with non-existent-path probes removed. Predictions with all probes dropped are still included (probes: []). */
  predictions: T[];
  droppedProbes: DroppedProbe[];
}

// ---------------------------------------------------------------------------
// Path-token heuristic
// ---------------------------------------------------------------------------

/**
 * Known file extensions that make a token look like a file path.
 * Conservative — only canonical project extensions to avoid false positives.
 */
const KNOWN_EXTENSIONS = new Set([
  'py', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'yaml', 'yml', 'toml', 'md', 'txt',
  'go', 'rs', 'rb', 'java', 'kt', 'cs', 'cpp', 'c', 'h',
  'sh', 'bash', 'zsh', 'env', 'cfg', 'ini', 'conf',
  'lock', 'sum',
]);

/**
 * Tokens that look like paths but are actually common identifiers.
 * Checked after extension detection to avoid false positives.
 */
const FALSE_POSITIVE_PATTERNS = [
  /^node\.js$/i,
  /^e\.g\.$/i,
  /^i\.e\.$/i,
  /^etc\.$/i,
  /^https?:\/\//i,    // URLs
  /^www\./i,           // URLs without scheme
  /^\.\.\./,           // ellipsis
];

/**
 * Strip surrounding backticks, quotes, and punctuation from a token.
 */
function stripSurround(token: string): string {
  return token.replace(/^[`'"([\]]+|[`'")\].,;:!?]+$/g, '');
}

/**
 * Return true when `token` looks like a file path reference.
 *
 * Heuristic: a token is a path if:
 *   - It contains a forward slash (e.g. "src/main.py"), OR
 *   - It ends with a known file extension (e.g. "config.yaml")
 * AND it does not match known false-positive patterns.
 */
function looksLikePath(token: string): boolean {
  const stripped = stripSurround(token);
  if (!stripped || stripped.length < 3) return false;

  for (const pat of FALSE_POSITIVE_PATTERNS) {
    if (pat.test(stripped)) return false;
  }

  // Has a slash (path component separator) — treat as path.
  if (stripped.includes('/')) return true;

  // Ends with a known extension (e.g. "config.yaml").
  const dot = stripped.lastIndexOf('.');
  if (dot > 0) {
    const ext = stripped.slice(dot + 1).toLowerCase();
    if (KNOWN_EXTENSIONS.has(ext)) return true;
  }

  return false;
}

/**
 * Extract all path-like tokens from a probe string.
 *
 * Splits on whitespace and punctuation boundaries, then filters by heuristic.
 * Returns deduplicated list of cleaned path tokens.
 */
export function extractPathTokens(probe: string): string[] {
  // Split on whitespace, commas, and sentence-ending punctuation.
  const rawTokens = probe.split(/[\s,;]+/);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawTokens) {
    const token = stripSurround(raw);
    if (!token || seen.has(token)) continue;
    if (looksLikePath(token)) {
      seen.add(token);
      result.push(token);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// ExistenceChecker
// ---------------------------------------------------------------------------

/**
 * Injectable existence checker. Given a path token (relative), returns true
 * when that path exists in the repo/cwd.
 *
 * In production: checks allPaths (git ls-files set) first, then falls back
 * to filesystem.
 * In tests: a simple Set lookup or custom function.
 */
export type ExistenceChecker = (relPath: string) => boolean;

/**
 * Build an existence checker from a git ls-files path set.
 * Returns true when the path is in the set OR when the set is empty
 * (i.e., no git repo context — no grounding is possible, let everything pass).
 */
export function makeSetChecker(allPaths: Set<string>): ExistenceChecker {
  if (allPaths.size === 0) {
    // Outside git — cannot validate. Pass everything.
    return () => true;
  }
  return (relPath: string) => allPaths.has(relPath);
}

// ---------------------------------------------------------------------------
// groundProbes
// ---------------------------------------------------------------------------

/**
 * Filter probes in each prediction against the existence checker.
 *
 * A probe is dropped when it contains at least one path-like token that
 * does NOT pass the existence check. The dropped probe is recorded in
 * `droppedProbes` with the first offending path as reason.
 *
 * Predictions whose probes are all dropped are retained in the output
 * array with `probes: []` so downstream code (episodes.ts syntheticEpisodes)
 * simply emits zero episodes for them — no downstream breakage.
 */
export function groundProbes<T extends GroundedPrediction>(
  predictions: T[],
  existenceChecker: ExistenceChecker,
): GroundProbesResult<T> {
  const droppedProbes: DroppedProbe[] = [];
  const groundedPredictions: T[] = [];

  for (const pred of predictions) {
    const keptProbes: string[] = [];

    for (const probe of pred.probes) {
      const pathTokens = extractPathTokens(probe);

      if (pathTokens.length === 0) {
        // No path references — keep as-is.
        keptProbes.push(probe);
        continue;
      }

      // Find first non-existent path token.
      const missingToken = pathTokens.find((t) => !existenceChecker(t));
      if (missingToken) {
        droppedProbes.push({
          predictionId: pred.id,
          probe,
          reason: `references non-existent path: ${missingToken}`,
        });
      } else {
        keptProbes.push(probe);
      }
    }

    groundedPredictions.push({ ...pred, probes: keptProbes });
  }

  return { predictions: groundedPredictions, droppedProbes };
}
