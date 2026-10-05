/**
 * Tool schema for the `get_facet` built-in tool.
 *
 * Extracted as a standalone module to satisfy the 350-line ceiling ratchet.
 * Imported and registered in `builtinToolSchemas[]` by schemas.ts.
 *
 * @module agent/tools/schemas.facet
 */

import type { AnthropicToolDef } from './types.js';
import type { SessionFacet } from '../facets/schema.js';

/** Internal provenance fields excluded from get_facet default output. */
export const FACET_INTERNAL_FIELDS = [
  'source_session_path',
  'derived_at',
  'source_session_mtime_ms',
  'facet_version',
  'derived_from',
] as const satisfies ReadonlyArray<keyof SessionFacet>;

export const getFacetTool: AnthropicToolDef = {
  name: 'get_facet',
  category: 'read',
  concurrencySafe: true,
  description:
    'Read the structured session facet for a given session. A facet is a validated, ' +
    'consumer-facing projection of a persisted session sidecar — it includes tool call ' +
    'counts, error categories, subagent invocations, world changes, outcome, summary, ' +
    'and (when available) token/cost breakdown.\n\n' +
    'Use this instead of raw session JSON or witness traces when you need a structured, ' +
    'schema-validated summary of what a session did. Defaults to the most recent session.\n\n' +
    'The response is a JSON object. Internal provenance fields (source_session_path, ' +
    'derived_at, facet_version, derived_from, source_session_mtime_ms) are excluded by ' +
    'default; pass them in `fields` to include them explicitly.\n\n' +
    'Every response includes three resolution-context fields regardless of the `fields` ' +
    'allowlist:\n' +
    '  - `session_cwd` — the `cwd` recorded in the session sidecar (null for legacy ' +
    'sidecars that predate the field).\n' +
    '  - `is_current_session` — true when the resolved session is the caller\'s own ' +
    'session (i.e. session id matches the dispatch context).\n' +
    '  - `cwd_mismatch` — true when `session_cwd` differs from the caller\'s working ' +
    'directory (signals a cross-cwd analysis that may be unintentional).',
  input_schema: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description:
          'Session ID, name, or a special alias (default: "latest"). ' +
          'Special values:\n' +
          '  - "latest": the most recently modified sealed session whose sidecar cwd ' +
          'matches the caller\'s working directory. Falls back to the global newest ' +
          'session when no cwd match exists (cwd_mismatch will be true).\n' +
          '  - "current" / "self": the session that invoked this tool call, resolved ' +
          'from the dispatch context\'s session id. Falls back to "latest" semantics ' +
          'when no context session id is available.\n' +
          'Any other string is resolved via the session sidecar index: accepts the ' +
          'sidecar filename stem, the stored sessionId, or the human-readable session name.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional allowlist of top-level fields to include in the response. ' +
          'When omitted, all non-provenance fields are returned. When supplied, ' +
          'ONLY the listed fields are returned — including provenance fields if ' +
          'you name them explicitly.',
      },
    },
    required: [],
  },
};
