// Re-exports from Foundation (src/utils/permission-mode.ts) so CLI-layer
// consumers keep a single import path. The warn-once state and defer/flush
// buffer live in utils so src/remote/ can also reach them without a
// cross-layer import.
export {
  classifyPermissionMode,
  _resetPermissionModeWarnCache,
  deferPermissionModeWarnings,
  flushDeferredPermissionModeWarnings,
  warnPermissionModeRemoval,
  warnPermissionModeNotConfigurable,
  warnPermissionModeUnknown,
} from '../../utils/permission-mode.js';
export type { RemovedPermissionMode } from '../../utils/permission-mode.js';
