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
    'default; pass them in `fields` to include them explicitly.',
  input_schema: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description:
          'Session ID, name, or "latest" (default). Resolves via the session sidecar ' +
          'index — accepts the sidecar filename stem, the stored sessionId, or the ' +
          'human-readable session name.',
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
