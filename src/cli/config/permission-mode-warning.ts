import type { RemovedPermissionMode } from '../../utils/permission-mode.js';
export { classifyPermissionMode } from '../../utils/permission-mode.js';
export type { RemovedPermissionMode } from '../../utils/permission-mode.js';

// Invariant: warn once per removed mode per process, buffered across the REPL startup screen clear.
const warnedRemovedModes = new Set<string>();
// Warn once per unknown value per process (keyed by the raw string).
const warnedUnknownModes = new Set<string>();
// Warn once per value that is a valid SDK mode but not accepted in config files.
const warnedNotConfigurableModes = new Set<string>();
let deferredPermissionModeWarnings: string[] | null = null;

/** Test-only reset of the warn-once tracker and deferral buffer. Internal API. */
export function _resetPermissionModeWarnCache(): void {
  warnedRemovedModes.clear();
  warnedUnknownModes.clear();
  warnedNotConfigurableModes.clear();
  deferredPermissionModeWarnings = null;
}

/** Start buffering the removal warning instead of writing to stderr. Idempotent. */
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
    `[afk] permissionMode "${value}" is not recognised and will be ignored. Valid modes: plan, bypassPermissions.`;
  if (deferredPermissionModeWarnings !== null) {
    deferredPermissionModeWarnings.push(message);
  } else {
    // eslint-disable-next-line no-console -- one-shot operator UX warning
    console.warn(message);
  }
}
