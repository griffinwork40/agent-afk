/**
 * Namespace re-export of the registry surface.
 *
 * Lets callers write `registry.dispatch(...)`, `registry.list()` without
 * importing each function individually. Kept in a small satellite file so
 * `slash/index.ts` stays focused on wiring.
 */

import * as registryImpl from './registry.js';

export const registry = registryImpl;
