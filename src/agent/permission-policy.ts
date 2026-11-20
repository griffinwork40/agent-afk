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
 * @module agent/permission-policy
 */

import type { PermissionMode } from './types/sdk-types.js';

/**
 * True when the permission mode disables typed-file path containment and the
 * path-approval prompt (the dispatcher's `allowAll`). Only `bypassPermissions`
 * qualifies; every other mode (`default`, `plan`, `acceptEdits`, `dontAsk`,
 * `auto`) preserves containment.
 */
export function pathContainmentBypassed(
  mode: PermissionMode | string | undefined,
): boolean {
  return mode === 'bypassPermissions';
}
