/**
 * The recovery text a forked sub-agent sees when a path falls outside its
 * granted roots. Extracted from `path-approval-hook.ts` so the wording and the
 * two downstream consumers that key on it live in one documented place.
 */

/** Which containment check produced the denial. */
export type ForkDenialMode = 'read' | 'write';

/**
 * Invariant: a fork's grant roots are FIXED AT DISPATCH. `computeInheritedReadRoots`
 * and the additive-`readRoots` union both build NEW arrays for the child
 * (`src/agent/subagent.ts`), and the child resolves containment against its own
 * grant manager — so a parent-side widening performed AFTER the fork started
 * (`/allow-dir`, an elicitation approval, `revokeRoot`) CANNOT reach a running
 * child. Re-dispatch is therefore the ONLY remedy that works on an in-flight
 * fork, which is why both branches below name it explicitly and neither offers
 * "ask the operator to grant it" as an in-flight option. Do not reintroduce
 * grant-widening as the suggested read remedy: it reads as actionable, is not,
 * and sends the fork into retry-until-timeout — the exact failure #544 was
 * opened to stop.
 *
 * Contract: the CALLER prefixes this body with the byte-stable
 * `Sub-agent path access denied:` string — see `SUBAGENT_PATH_DENIAL_REASON_PREFIX`
 * in `../denial-circuit-breaker.ts`, matched by substring, not by prefix
 * position. The remedy body returned here is NOT byte-stable, but it IS
 * fingerprinted: `src/improve/scan/detectors/subagent-read-denial.ts` hashes the
 * ENTIRE normalized reason (`normalizeReason` collapses path-shaped tokens to
 * `<path>`, then `computeFingerprint` SHA-256s it), so any reword here rotates
 * the failure-card slug and restarts that card's severity ladder. That rotation
 * is silent — every detector test builds its own fixture string rather than
 * importing this module — so a reword must be a deliberate decision, not a
 * drive-by edit.
 */
export function buildForkDenialRemedy(args: { mode: ForkDenialMode; resolvedPath: string }): string {
  const { mode, resolvedPath } = args;
  const grant = JSON.stringify(resolvedPath);

  if (mode === 'write') {
    return (
      `Writes are confined to this fork's granted write roots by design ` +
      `(worktree isolation). To allow it, the parent must re-dispatch you via ` +
      `the \`agent\` tool with \`writeRoots: [${grant}]\`, or perform the write ` +
      `itself. Return this exact path requirement to your parent.`
    );
  }

  return (
    `Reads are confined to this fork's granted read roots. To allow it, the parent ` +
    `must re-dispatch you via the \`agent\` tool with \`readRoots: [${grant}]\`, or ` +
    `read the path itself and pass the content to you in the prompt. A grant made ` +
    `after you were dispatched cannot reach you — your roots were fixed at dispatch. ` +
    `Return this exact path requirement to your parent.`
  );
}
