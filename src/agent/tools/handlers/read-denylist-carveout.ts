/**
 * Builtin-deny gate for the `AFK_HOME`-relocated read carve-outs (#779).
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
 * @module agent/tools/handlers/read-denylist-carveout
 */

/**
 * Prefix-or-equal containment, matching the shape `isReadDenied` uses for its
 * own deny loop so the two cannot drift apart.
 */
function isUnderRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * Drop any derived carve-out that falls under a builtin denied root other than
 * the one it is carving out of.
 *
 * @param derived     Relocated carve-out entries (absolute, symlink-resolved).
 * @param builtinDeny The full builtin deny prefix list.
 * @param carvedRoots The denied root(s) the carve-out legitimately pierces —
 *                    excluded from the gate by exact match.
 * @returns The subset safe to union into the allow list. Fails CLOSED: an entry
 *          under any other builtin root is dropped, never kept.
 */
export function gateDerivedCarveOuts(
  derived: readonly string[],
  builtinDeny: readonly string[],
  carvedRoots: readonly string[],
): string[] {
  const gateRoots = builtinDeny.filter((root) => !carvedRoots.includes(root));
  return derived.filter((entry) => !gateRoots.some((root) => isUnderRoot(entry, root)));
}
