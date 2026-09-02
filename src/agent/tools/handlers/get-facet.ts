/**
 * Handler for the `get_facet` built-in tool.
 *
 * Returns a structured, filtered session facet as JSON. Supports "latest",
 * session ID, or session name resolution. Filters internal provenance fields
 * from default output.
 *
 * @module agent/tools/handlers/get-facet
 */

import { getOrDeriveFacet, listSessionIds, loadStoredSession } from '../../facets/index.js';
import { resolveSessionByName } from '../../trace/session-name-resolver.js';
import { FACET_INTERNAL_FIELDS } from '../schemas.facet.js';
import type { ToolHandler } from '../types.js';

export const getFacetHandler: ToolHandler = async (input, _signal) => {
  const obj = (input ?? {}) as Record<string, unknown>;
  const sessionArg = typeof obj['session'] === 'string' ? obj['session'] : 'latest';
  const fields = Array.isArray(obj['fields']) ? (obj['fields'] as string[]) : null;

  let sessionId: string | undefined;

  if (sessionArg === 'latest') {
    const ids = listSessionIds();
    const entries = ids
      .map((id) => ({ id, session: loadStoredSession(id) }))
      .filter(
        (e): e is { id: string; session: NonNullable<ReturnType<typeof loadStoredSession>> } =>
          e.session != null,
      )
      .sort((a, b) => (b.session.savedAt ?? 0) - (a.session.savedAt ?? 0));
    sessionId = entries[0]?.id;
  } else {
    const resolved = resolveSessionByName(sessionArg);
    sessionId = resolved?.sessionId;
  }

  if (!sessionId) {
    return { content: `Session not found: ${sessionArg}`, isError: true };
  }

  const facet = getOrDeriveFacet(sessionId);
  if (!facet) {
    return { content: `Session not found: ${sessionArg}`, isError: true };
  }

  const raw = facet as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const exclude = new Set<string>(FACET_INTERNAL_FIELDS);

  if (fields && fields.length > 0) {
    for (const f of fields) result[f] = raw[f];
  } else {
    for (const [k, v] of Object.entries(raw)) {
      if (!exclude.has(k)) result[k] = v;
    }
  }

  return { content: JSON.stringify(result, null, 2) };
};
