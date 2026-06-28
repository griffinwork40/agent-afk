/**
 * Permission-mode policy predicates.
 *
 * Single source of truth for "does this permission mode disable typed-file
 * path containment and the path-approval elicitation prompt?" — i.e. the
 * dispatcher's `allowAll` flag. Both providers derive `allowAll` (the per-call
 * dispatcher flag AND the provider's `getGrants().allowAll`, which the
 * path-approval hook consults) through THIS predicate, so the two reads stay in
 * lockstep. Divergence fails UNSAFE — the `setPermissionMode` comments in each
 * provider's query.ts explain why (a badge can clear while the agent stays
 * unrestricted, or vice versa).
 *
 * Why `autonomous` (AFK) qualifies alongside `bypassPermissions`:
 * AFK mode runs unattended. A keyboard-blocking path-approval prompt would
 * stall the session against a human who is away — exactly the friction AFK
 * exists to remove, and it would make AFK MORE restrictive than the new-install
 * default (`bypassPermissions`). The safety mechanism in AFK is instead the
 * afk-mode-gate (`agent/afk-mode-gate.ts`), a risk-classifier ceiling that
 * independently refuses high-risk / irreversible ops — destructive bash,
 * write-denylist paths, `.git`-store writes, and writes that escape the
 * workspace root — regardless of `allowAll`. So AFK = bypass-level path freedom
 * + the risk gate, matching the posture "autonomous on reversible work;
 * high-risk / irreversible refused".
 *
 * @module agent/permission-policy
 */

import type { PermissionMode } from './types/sdk-types.js';

/**
 * True when the permission mode disables typed-file path containment and the
 * path-approval prompt (the dispatcher's `allowAll`). Both `bypassPermissions`
 * (explicit full power) and `autonomous` (AFK) qualify; every other mode
 * (`default`, `plan`, `acceptEdits`, `dontAsk`, `auto`) preserves containment.
 */
export function pathContainmentBypassed(
  mode: PermissionMode | string | undefined,
): boolean {
  return mode === 'bypassPermissions' || mode === 'autonomous';
}
