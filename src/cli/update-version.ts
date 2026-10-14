/**
 * Semver comparison helper shared between the passive update-notifier
 * (`update-checker.ts`) and the foreground `afk update` command
 * (`commands/update.ts`).
 *
 * Design decision (prerelease ordering):
 *   Semver specifies that a prerelease version has LOWER precedence than
 *   the associated release (1.2.3-beta.1 < 1.2.3). We implement this rule
 *   for the one case that matters in practice: a user running a prerelease
 *   build should be offered the final release as an update. The inverse
 *   (offering a prerelease as an update over a release) is intentionally
 *   NOT supported — npm's `latest` dist-tag does not point at prereleases,
 *   so `fetchLatestVersion()` will never return one from the standard path.
 *
 *   The `core()` stripping approach is preserved from the original
 *   `update-checker.ts` implementation. An alternative (full semver parse)
 *   is not warranted here: the only inputs are versions from `package.json`
 *   and the npm registry `latest` tag, both well-formed by construction.
 */

/**
 * Returns `true` when `latest` is strictly newer than `current`.
 *
 * Comparison algorithm:
 *   1. Strip prerelease (`-`) and build-metadata (`+`) suffixes from both
 *      versions before comparing numeric segments. This prevents `Number()`
 *      from producing `NaN` for a component like `3-beta.1`, which would
 *      cause all comparisons to silently evaluate to `false`.
 *   2. Compare the resulting `major.minor.patch` triples numerically.
 *   3. Tiebreaker: when the numeric cores are equal, a final release is
 *      considered newer than a prerelease of the same version
 *      (e.g. `1.2.3 > 1.2.3-beta.1`). Prerelease-to-prerelease ordering
 *      is intentionally left undefined — the npm `latest` tag never serves
 *      prereleases, so the tiebreaker is only needed in one direction.
 *
 * @param current - The currently installed version string (e.g. `"1.2.3-beta.1"`).
 * @param latest  - The candidate newer version string (e.g. `"1.2.3"`).
 */
export function isNewerVersion(current: string, latest: string): boolean {
  // Drop prerelease and build-metadata suffixes to get the numeric core.
  const core = (v: string): string => v.split(/[-+]/, 1)[0] ?? v;
  // A `-` immediately after the numeric core denotes a prerelease per semver.
  // `v.includes('-')` is overly broad: a build-metadata string like
  // `1.2.3+build-sha` contains a hyphen in the metadata segment and must NOT
  // be treated as a prerelease. The regex anchors the hyphen right after the
  // three-part version core so only true pre-release markers match.
  const isPrerelease = (v: string): boolean => /^\d+\.\d+\.\d+-/.test(v);

  const c = core(current).split('.').map(Number);
  const l = core(latest).split('.').map(Number);
  const len = Math.max(c.length, l.length);
  for (let i = 0; i < len; i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  // Equal numeric cores: a final release outranks its own prerelease.
  return isPrerelease(current) && !isPrerelease(latest);
}
