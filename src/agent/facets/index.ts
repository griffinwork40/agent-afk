/**
 * src/agent/facets — AFK-native session facets.
 *
 * A SessionFacet is a structured, consumer-facing projection of a persisted
 * session, derived lazily and cached on disk. Consumers (evals, debug views,
 * improvement loops) depend on this public surface — never on the raw
 * session-store shape.
 *
 * Public API:
 *   - deriveSessionFacet(session, opts) — pure session → facet
 *   - getOrDeriveFacet(id, opts)        — lazy read-through cache
 *   - loadStoredSession(id, dir)        — validated session loader
 *   - listSessionIds(opts)             — enumerate persisted sessions
 *   - SessionFacet / schema exports
 */

export {
  FACET_VERSION,
  SessionFacetSchema,
  StoredSessionInputSchema,
  FacetOutcomeSchema,
  SubagentPersistenceSchema,
  SubagentInvocationSchema,
  WorldChangesSchema,
  type SessionFacet,
  type StoredSessionInput,
  type ToolEventInput,
  type FacetOutcome,
  type SubagentInvocation,
  type WorldChanges,
} from './schema.js';

export { deriveSessionFacet, type DeriveOptions } from './derive.js';

export {
  getOrDeriveFacet,
  loadStoredSession,
  listSessionIds,
  type FacetStoreOptions,
} from './store.js';
