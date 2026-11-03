/**
 * Read-scope resolution for `executeOnce` — the single step that derives
 * `childInheritedReadRoots` from the parent manager's `getReadScopeInputs`.
 *
 * Extracted from `subagent-executor.execute-once.helpers.ts` to keep that
 * file within the 350-code-line ceiling (#4472).
 *
 * @module agent/tools/subagent-executor.execute-once.read-scope
 */

/**
 * Resolves the `childInheritedReadRoots` that `executeOnce` passes to
 * `buildChildConfig` as the nested child `SubagentManager`'s `parentReadRoots`.
 *
 * `getReadScopeInputs` is optional — it was added in #4438 and may be absent on
 * managers constructed before the update.  The `??` fallback collapses two
 * distinct parent states into `{ parentReadRoots: undefined, parentCwd: undefined }`:
 *   (a) unwired manager — method absent (back-compat)
 *   (b) known-unconfined parent — method present, both fields undefined
 * The skill/compose path distinguishes them; this path cannot without breaking
 * the optional-method back-compat contract.  Both cases produce `undefined`
 * `childInheritedReadRoots`, which is safe: the child manager's own
 * cwd-derivation governs, matching pre-#4438 behavior.  Tracked: #4472.
 */
export function resolveChildInheritedReadRoots(
  getReadScopeInputs: (() => { parentReadRoots: string[] | undefined; parentCwd: string | undefined }) | undefined,
): { childScopeInputs: { parentReadRoots: string[] | undefined; parentCwd: string | undefined }; childInheritedReadRoots: string[] | undefined } {
  const childScopeInputs = getReadScopeInputs?.() ?? {
    parentReadRoots: undefined,
    parentCwd: undefined,
  };
  const childInheritedReadRoots = childScopeInputs.parentReadRoots
    ?? (childScopeInputs.parentCwd !== undefined ? [childScopeInputs.parentCwd] : undefined);
  return { childScopeInputs, childInheritedReadRoots };
}
