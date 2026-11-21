/**
 * Shared classification helper for permissionMode values.
 *
 * Lives in Foundation (src/utils/) so both the CLI config parser (Surface)
 * and the remote host registry (Core/Infra) can consume it without introducing
 * a cross-layer import.
 *
 * Foundation cannot import from Core/Infra (agent/), so the valid-mode set is
 * defined here independently. Keep it in sync with PermissionMode in
 * src/agent/types/sdk-types.ts — when a mode is added or removed there, update
 * this set too.
 *
 * @module utils/permission-mode
 */

/**
 * Local mirror of the `PermissionMode` union from `src/agent/types/sdk-types.ts`.
 * Foundation cannot import from Core/Infra (agent/), so this type is duplicated
 * here intentionally. Keep in sync when modes are added or removed in sdk-types.ts.
 */
export type PermissionMode = 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

/**
 * Valid permissionMode values. Must stay in sync with the `PermissionMode`
 * union in `src/agent/types/sdk-types.ts`.
 */
export const VALID_PERMISSION_MODE_SET: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto',
]);

/** Permission modes that existed before v6 and are no longer accepted. */
export type RemovedPermissionMode = 'default' | 'autonomous';

export const REMOVED_PERMISSION_MODES: ReadonlySet<string> = new Set<RemovedPermissionMode>([
  'default', 'autonomous',
]);

/**
 * Classify a raw permissionMode string from any config source.
 *
 * - `'valid'`   — accepted; callers should apply the value.
 * - `'removed'` — existed before v6; callers should warn and drop.
 * - `'unknown'` — unrecognised; callers should warn with valid options and drop.
 */
export function isPermissionMode(value: string): value is PermissionMode {
  return (VALID_PERMISSION_MODE_SET as ReadonlySet<string>).has(value);
}

export function classifyPermissionMode(value: string): 'valid' | 'removed' | 'unknown' {
  if (isPermissionMode(value)) return 'valid';
  if (REMOVED_PERMISSION_MODES.has(value)) return 'removed';
  return 'unknown';
}
