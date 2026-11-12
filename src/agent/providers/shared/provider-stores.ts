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
