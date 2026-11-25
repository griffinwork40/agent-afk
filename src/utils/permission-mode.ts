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

// SYNC: keep in sync with src/agent/types/sdk-types.ts (VALID_PERMISSION_MODES); enforced by src/utils/permission-mode.test.ts.
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
 * Permission modes accepted in config files (`afk.config.json`) and host
 * entries (`hosts.json`). Intentionally narrower than the full SDK set:
 * `acceptEdits`, `dontAsk`, and `auto` are available only via the
 * `--permission-mode` CLI flag. This matches the `settable-keys.ts` enum
 * for the `permissionMode` config key (human-tier privilege-escalation gate).
 */
export type ConfigPermissionMode = 'plan' | 'bypassPermissions';
export const CONFIG_PERMISSION_MODES: ReadonlySet<ConfigPermissionMode> = new Set<ConfigPermissionMode>([
  'plan', 'bypassPermissions',
]);

export function isConfigPermissionMode(value: string): value is ConfigPermissionMode {
  return (CONFIG_PERMISSION_MODES as ReadonlySet<string>).has(value);
}

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

// ---------------------------------------------------------------------------
// Warn-once helpers (Foundation layer so src/remote/ can import without
// pulling in src/cli/). src/cli/config/permission-mode-warning.ts re-exports
// these and adds defer/flush support for the REPL startup screen.
// ---------------------------------------------------------------------------

const warnedRemovedModes = new Set<string>();
const warnedUnknownModes = new Set<string>();
const warnedNotConfigurableModes = new Set<string>();
let deferredPermissionModeWarnings: string[] | null = null;

/** Test-only reset of the warn-once tracker and deferral buffer. Internal API. */
export function _resetPermissionModeWarnCache(): void {
  warnedRemovedModes.clear();
  warnedUnknownModes.clear();
  warnedNotConfigurableModes.clear();
  deferredPermissionModeWarnings = null;
}

/** Start buffering warnings instead of writing to stderr. Idempotent. */
export function deferPermissionModeWarnings(): void {
  deferredPermissionModeWarnings ??= [];
}

/** Print buffered warnings and end deferral. A second flush is a no-op. */
export function flushDeferredPermissionModeWarnings(): void {
  const pending = deferredPermissionModeWarnings ?? [];
  deferredPermissionModeWarnings = null;
  // eslint-disable-next-line no-console -- one-shot operator UX warning
  for (const msg of pending) console.warn(msg);
}

export function warnPermissionModeRemoval(mode: RemovedPermissionMode): void {
  if (warnedRemovedModes.has(mode)) return;
  warnedRemovedModes.add(mode);
  const message =
    `[afk] permissionMode "${mode}" was removed. The session will run in bypassPermissions. Set "permissionMode": "plan" for a read-only session.`;
  if (deferredPermissionModeWarnings !== null) {
    deferredPermissionModeWarnings.push(message);
  } else {
    // eslint-disable-next-line no-console -- one-shot operator UX warning
    console.warn(message);
  }
}

export function warnPermissionModeNotConfigurable(value: string): void {
  if (warnedNotConfigurableModes.has(value)) return;
  warnedNotConfigurableModes.add(value);
  const message =
    `[afk] permissionMode "${value}" is a valid mode for --permission-mode but is not accepted in afk.config.json. Valid config modes: plan, bypassPermissions.`;
  if (deferredPermissionModeWarnings !== null) {
    deferredPermissionModeWarnings.push(message);
  } else {
    // eslint-disable-next-line no-console -- one-shot operator UX warning
    console.warn(message);
  }
}

export function warnPermissionModeUnknown(value: string): void {
  if (warnedUnknownModes.has(value)) return;
  warnedUnknownModes.add(value);
  const message =
    `[afk] permissionMode "${value}" is not recognised and will be ignored. Valid config modes: plan, bypassPermissions. For other modes use --permission-mode.`;
  if (deferredPermissionModeWarnings !== null) {
    deferredPermissionModeWarnings.push(message);
  } else {
    // eslint-disable-next-line no-console -- one-shot operator UX warning
    console.warn(message);
  }
}
