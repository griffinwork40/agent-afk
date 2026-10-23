/**
 * Lazy default-store factories for provider classes.
 *
 * The default `MemoryStore` and `StateStore` are created at first use rather
 * than at construction time. This means importing a provider module (and the
 * module-scope singletons it exports) no longer opens SQLite handles as a side
 * effect — only the first `query()` / `buildDispatcher()` call does.
 *
 * Injected stores (passed via constructor options) are still accepted and used
 * immediately; laziness applies only to the auto-created defaults.
 *
 * @module agent/providers/shared/provider-stores
 */

import { MemoryStore } from '../../memory/index.js';
import { StateStore } from '../../state/state-store.js';
import { getStateDatabasePath } from '../../../paths.js';

/** Create the default MemoryStore (opened on first call, not at import time). */
export function makeDefaultMemoryStore(): MemoryStore {
  return new MemoryStore();
}

/** Create the default StateStore (opened on first call, not at import time). */
export function makeDefaultStateStore(): StateStore {
  return new StateStore(getStateDatabasePath());
}

// Invariant: one SQLite handle per process for the shared plugin-API state store.
// Using a separate factory function (makeDefaultStateStore) per call would open
// a new Database handle on every surface startup, leaking handles and breaking
// compare-and-swap atomicity across the plugin injection and the provider layer.
let _sharedPluginStateStore: StateStore | undefined;

/**
 * Return the process-wide shared StateStore used for plugin API injection.
 *
 * The same instance is returned on every call, so the plugin layer and the
 * provider layer share one SQLite handle rather than opening two separate
 * connections to the same file. Created lazily on first call.
 */
export function getSharedPluginStateStore(): StateStore {
  _sharedPluginStateStore ??= new StateStore(getStateDatabasePath());
  return _sharedPluginStateStore;
}
