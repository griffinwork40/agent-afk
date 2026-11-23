// Invariant: warn once per removed mode per process, buffered across the REPL startup screen clear.
const warnedRemovedModes = new Set<RemovedPermissionMode>();
let deferredPermissionModeWarnings: string[] | null = null;

/** Permission modes that existed before v6 and are no longer accepted in config files. */
export type RemovedPermissionMode = 'default' | 'autonomous';

/** Test-only reset of the warn-once tracker and deferral buffer. Internal API. */
export function _resetPermissionModeWarnCache(): void {
  warnedRemovedModes.clear();
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
    `[afk] permissionMode "${mode}" was removed. The session will run in unrestricted mode. Set "permissionMode": "plan" for a read-only session.`;
  if (deferredPermissionModeWarnings !== null) {
    deferredPermissionModeWarnings.push(message);
  } else {
    // eslint-disable-next-line no-console -- one-shot operator UX warning
    console.warn(message);
  }
}
