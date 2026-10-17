/**
 * The single write-capability predicate for a child tool surface.
 *
 * Shared by the `agent` tool path (`resolveChildToolAccess` →
 * `childWriteCapable`) and compose node resolution (`resolveComposeNodeAgent`
 * → `readOnly`), so both dispatch paths agree on which named agents are
 * read-only for the #3754 implementation-intent gate.
 *
 * @module agent/tools/subagent/write-capability
 */

/**
 * True when the surface can mutate the filesystem: it can call write_file /
 * edit_file, or it can run bash without the read-only bash gate. An undefined
 * allowlist means inherit-all, which is write-capable.
 */
export function isChildWriteCapable(
  effectiveAllowedTools: readonly string[] | undefined,
  effectiveReadOnlyBash: boolean,
): boolean {
  const canWriteFiles =
    effectiveAllowedTools === undefined ||
    effectiveAllowedTools.includes('write_file') ||
    effectiveAllowedTools.includes('edit_file');
  const canMutateViaBash =
    (effectiveAllowedTools === undefined || effectiveAllowedTools.includes('bash')) &&
    effectiveReadOnlyBash !== true;
  return canWriteFiles || canMutateViaBash;
}
