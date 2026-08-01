import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Case-awareness for the credential floors.
 *
 * Invariant: every comparison exported here is ADDITIVE — it can only ever turn
 * a non-match into a match, never the reverse. The exact (case-sensitive)
 * comparison is always tried first and short-circuits on success, so wiring
 * these helpers in can only ever DENY more than the raw `===` / `startsWith` /
 * `includes` they replace. That one-directional property is what makes it safe
 * to put them under an unconditional security floor: a wrong probe result costs
 * an over-block (a usability bug the operator sees immediately), never an
 * under-block (a silent credential leak nobody sees).
 */

/** Cached process-wide probe result. `undefined` = not yet probed. */
let caseInsensitive: boolean | undefined;

/**
 * Probe whether `probeDir` lives on a case-insensitive volume by asking the
 * filesystem to resolve a case-flipped spelling of its own basename and
 * comparing (dev, ino).
 *
 * Contract: returns `true` (case-insensitive) / `false` (case-sensitive) /
 * `undefined` (indeterminate — caller must fail closed). An `ENOENT` on the
 * flipped spelling is a definitive `false`, not an error: the volume declined
 * to resolve the variant, which is exactly what case-sensitivity means.
 */
function probeCaseInsensitive(probeDir: string): boolean | undefined {
  const base = basename(probeDir);
  const flipped = base === base.toLowerCase() ? base.toUpperCase() : base.toLowerCase();
  // No alphabetic characters to flip — this path cannot answer the question.
  if (flipped === base) return undefined;

  let self;
  try {
    self = statSync(probeDir);
  } catch {
    // The probe path itself is unreadable; we learned nothing.
    return undefined;
  }

  try {
    const variant = statSync(join(dirname(probeDir), flipped));
    return self.dev === variant.dev && self.ino === variant.ino;
  } catch {
    // The flipped spelling does not resolve => the volume is case-sensitive.
    return false;
  }
}

/**
 * Whether path comparisons against the credential floors should be case-folded.
 *
 * Probes the home directory's volume once per process and caches the result.
 * Home is the right volume to probe because essentially every denylist entry
 * lives under it (`~/.ssh`, `~/.afk`, `~/.aws`, `~/.config`).
 *
 * Known limitation: a single process-wide answer is wrong for the mixed-volume
 * case (a case-sensitive APFS volume mounted beneath a case-insensitive system
 * disk, or vice versa). Erring toward folding means the mixed case over-blocks
 * rather than under-blocks, which is the correct direction for a security
 * floor. Per-volume probing is the follow-up if that ever bites.
 */
export function isCaseInsensitiveFs(): boolean {
  if (caseInsensitive !== undefined) return caseInsensitive;

  let probed = probeCaseInsensitive(homedir());
  if (probed === undefined) probed = probeCaseInsensitive(process.cwd());

  // Fail closed: an indeterminate probe folds, which over-blocks rather than
  // leaving a case-variant spelling of a credential path readable.
  caseInsensitive = probed ?? true;
  return caseInsensitive;
}

/**
 * Whether `real` is `blocked` itself or sits underneath it.
 *
 * Replaces the bare `real === blocked || real.startsWith(blocked + '/')` at the
 * denylist comparison sites. The exact comparison runs first, so behaviour on a
 * case-sensitive volume is bit-for-bit unchanged.
 */
export function pathIsWithin(real: string, blocked: string): boolean {
  if (real === blocked || real.startsWith(blocked + '/')) return true;
  if (!isCaseInsensitiveFs()) return false;

  const r = real.toLowerCase();
  const b = blocked.toLowerCase();
  return r === b || r.startsWith(b + '/');
}

/**
 * Whether `haystack` (a normalized bash command line) mentions `needle`.
 *
 * Replaces the bare `scanned.includes(sub)` in the bash restriction hook. Same
 * additive contract as `pathIsWithin`.
 */
export function textMentionsPath(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  if (!isCaseInsensitiveFs()) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Reset the cached probe. Tests only — lets a suite exercise both the
 * case-sensitive and case-insensitive branches in one process.
 */
export function _resetFsCaseCacheForTests(value?: boolean): void {
  caseInsensitive = value;
}
