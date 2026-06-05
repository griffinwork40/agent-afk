/**
 * Semver tag picker used by the plugin installer.
 *
 * `git tag --list --sort=-v:refname` already gives us a decent ordering for
 * release-style tags, but:
 *   - the list often contains non-semver tags (`latest`, `stable`, release-
 *     candidate schemes that don't follow semver) — we have to filter them
 *     out so the picker doesn't accidentally pin to `banana`.
 *   - pre-releases (`v1.0.0-rc.1`) sort after their base (`v1.0.0`) in the
 *     -v:refname order, but we want them to rank *lower* so users get the
 *     stable release by default.
 *
 * Pure function. No FS, no network.
 *
 * @module agent/plugins/versions
 */

interface ParsedVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(tag: string): ParsedVersion | null {
  const m = SEMVER_RE.exec(tag);
  if (!m) return null;
  const [, maj, min, pat, pre] = m;
  return {
    raw: tag,
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
    prerelease: pre ?? null,
  };
}

function comparePrerelease(a: string | null, b: string | null): number {
  // Per semver: absence of prerelease > presence of prerelease. So a stable
  // version (null) outranks a pre-release.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const aParts = a.split('.');
  const bParts = b.split('.');
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff;
    } else if (aNum) {
      return -1; // numeric identifiers rank lower than alphanumeric
    } else if (bNum) {
      return 1;
    } else {
      if (ap < bp) return -1;
      if (ap > bp) return 1;
    }
  }
  return 0;
}

function compare(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Pick the highest-ranked semver tag from `tags`, returning the original
 * string (including any `v` prefix). Non-semver entries are ignored.
 *
 * Returns `null` when no tag parses as semver.
 */
export function pickLatestSemverTag(tags: readonly string[]): string | null {
  const parsed = tags
    .map((t) => parse(t.trim()))
    .filter((p): p is ParsedVersion => p !== null);
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => compare(b, a));
  return parsed[0]?.raw ?? null;
}
