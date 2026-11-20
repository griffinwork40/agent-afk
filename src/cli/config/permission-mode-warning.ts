// Invariant: warn once per process, buffered across the REPL startup screen clear.
let warnedPermissionModeRemoval = false;
let deferredPermissionModeWarnings: string[] | null = null;

/** Test-only reset of the warn-once tracker and deferral buffer. Internal API. */
export function _resetPermissionModeWarnCache(): void {
  warnedPermissionModeRemoval = false;
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

export function warnPermissionModeRemoval(): void {
  if (warnedPermissionModeRemoval) return;
  warnedPermissionModeRemoval = true;
  const message =
    '[afk] permissionMode "default" was removed. The session will run in bypassPermissions. Set "permissionMode": "plan" for a read-only session.';
  if (deferredPermissionModeWarnings !== null) {
    deferredPermissionModeWarnings.push(message);
  } else {
    // eslint-disable-next-line no-console -- one-shot operator UX warning
    console.warn(message);
  }
}
