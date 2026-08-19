/**
 * Builtin-deny gate for read-denylist carve-outs: both the static
 * `READ_ALLOWLIST_REL` entries (read-denylist.ts) and the `AFK_HOME`-relocated
 * derivative of the `.afk/`-prefixed ones (#779).
 *
 * Invariant: this gate CANNOT be expressed by calling `isReadDenied`. That
 * function consults the very allow list this gate is building — and consults it
 * BEFORE the builtin deny loop — so asking it would both re-enter and always
 * answer "not denied" for the entry under test. The gate therefore matches the
 * derived entries against the builtin deny prefixes directly. (The bash surface
 * does ask `isReadDenied`, which is exactly why its apparently-correct gate at
 * `bash-restriction-hook.ts` never actually fires.)
 *
 * Contract: the discriminator between "the root this carve-out is meant to
 * pierce" and "a different root that must still win" is EQUALITY, never prefix.
 * The carve-out exists to reach `<afkHome>/config/mcp.json` through the denied
 * `<afkHome>/config` root, so that root is excluded from the gate by exact
 * match. A root that merely CONTAINS the relocated home — `~/.ssh` when
 * `AFK_HOME=~/.ssh/afk` — is a prefix, not an equal, so it stays in the gate and
 * still denies. Using prefix matching for the exclusion would re-open the hole;
 * using equality for the gate itself would miss it.
 *
 * Callers remove the specifically carved deny entry by provenance before
 * invoking this function. They must not remove every root with the same
 * canonical path: an independent builtin can resolve to that path through a
 * symlink and must continue to enforce the floor.
 *
 * @module agent/tools/handlers/read-denylist-carveout
 */

/**
 * Platform-aware prefix-or-equal containment. `relative` avoids hard-coding
 * `/`, which would silently disable nested-root checks on Windows.
 */
import { isAbsolute, relative, sep } from 'node:path';
import { homedir } from 'node:os';

function isUnderRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Drop any derived carve-out that falls under a builtin denied root other than
 * the one it is carving out of. The caller supplies only roots that must gate
 * the entries, preserving the source identity of duplicate canonical paths.
 *
 * @param derived     Relocated carve-out entries (absolute, symlink-resolved).
 * @param gateRoots   Builtin roots that are not the designated carved source.
 * @returns The subset safe to union into the allow list: an entry under any
 *          of `gateRoots` is dropped, never kept. Not reachable today, but
 *          note the edge case for a future caller: an EMPTY `gateRoots`
 *          excludes nothing, so every entry passes through kept — the
 *          fail-closed guarantee depends on the caller populating `gateRoots`
 *          with every root that is not the legitimately pierced one.
 */
export function gateDerivedCarveOuts(
  derived: readonly string[],
  gateRoots: readonly string[],
): string[] {
  return derived.filter((entry) => !gateRoots.some((root) => isUnderRoot(entry, root)));
}

/**
 * Gate roots for ONE specific carve-out, identified by the exact builtin
 * source (never a resolved path — see module contract above) it legitimately
 * pierces: every resolved builtin root EXCEPT the one whose `source` equals
 * `piercedSource`.
 *
 * This is what makes the gate per-entry rather than one shared set for every
 * carve-out. `~/.ssh` and `~/.afk/config` are different sources, so excluding
 * one for a given entry never exempts the other — a carve-out that pierces
 * `~/.afk/config` still gets caught by the `~/.ssh` root (and vice versa) if
 * it happens to resolve underneath it (#815 review: a single shared exclusion
 * set silently dropped the `.ssh/config` / `.ssh/known_hosts` carve-outs
 * because it only ever excluded `~/.afk/config`).
 *
 * `piercedSource` of `undefined` (no mapping for this carve-out) excludes
 * nothing, so an unmapped entry is gated by every root — fails CLOSED rather
 * than silently going ungated.
 */
function gateRootsExcludingSource(
  resolvedBuiltinEntries: readonly { source: string; root: string }[],
  piercedSource: string | undefined,
): string[] {
  return resolvedBuiltinEntries
    .filter(({ source }) => source !== piercedSource)
    .map(({ root }) => root);
}

/**
 * Maps each static `READ_ALLOWLIST_REL` entry (read-denylist.ts) to the exact
 * builtin denylist source string it is carved out of. `.ssh/config` and
 * `.ssh/known_hosts` pierce a DIFFERENT root than `.afk/config/mcp.json`, so
 * each needs its own exclusion via {@link gateRootsExcludingSource} — a
 * single shared exclusion set is what regressed the ssh carve-outs (#815
 * review). An entry with no mapping here is gated by every builtin root
 * (fails closed): the "every READ_ALLOWLIST_REL entry stays allowed" test in
 * the sibling test file would catch the omission before it could ship.
 *
 * Spelled here (not read-denylist.ts) so this module owns the full gate
 * mechanism, static and derived alike; read-denylist.ts only supplies the
 * resolved entries and the builtin roots.
 */
const CARVEOUT_PIERCED_SOURCE: Readonly<Record<string, string>> = {
  '.afk/config/mcp.json': `${homedir()}/.afk/config`,
  '.afk/config/schedules.json': `${homedir()}/.afk/config`,
  '.ssh/config': `${homedir()}/.ssh`,
  '.ssh/known_hosts': `${homedir()}/.ssh`,
};

/**
 * Gate every static carve-out in `entries` against the builtin deny roots,
 * excluding — per entry, via {@link CARVEOUT_PIERCED_SOURCE} — only the one
 * root it is mapped to pierce.
 *
 * @param entries Paired (not two parallel arrays) so read-denylist.ts can
 *   hand over both derivations together: `rel` is the
 *   {@link CARVEOUT_PIERCED_SOURCE} lookup key (e.g. `.ssh/config`); `resolved`
 *   is that same entry already resolved the way `isReadDenied` compares it.
 *   This module never needs its own resolver.
 */
export function gateStaticCarveOuts(
  entries: readonly { rel: string; resolved: string }[],
  resolvedBuiltinEntries: readonly { source: string; root: string }[],
): string[] {
  return entries.flatMap(({ rel, resolved }) =>
    gateDerivedCarveOuts(
      [resolved],
      gateRootsExcludingSource(resolvedBuiltinEntries, CARVEOUT_PIERCED_SOURCE[rel]),
    ),
  );
}
