/**
 * Facet indexing helper for MemoryStore.
 *
 * Extracts the `indexFacet` concern — parsing a raw (loosely-typed) facet
 * object and delegating to FacetFtsStore — out of memory-store.ts so that
 * file stays under the 350-code-line ceiling.
 *
 * Contract: safe on any input shape; returns without side-effects when the
 * input is null, non-object, or missing a session_id.
 *
 * @module agent/memory/memory-store.facet-index
 */

import type { FacetFtsStore } from './facet-fts-store.js';

/**
 * Index a session facet into `store` for `type: 'session'` search results.
 *
 * Accepts a raw `unknown` value (the facet as written to the cache dir) and
 * extracts `brief_summary`, `underlying_goal`, `primary_success`, and
 * `decisions` for indexing. Silently no-ops on null, non-object, array, or
 * missing session_id — callers never need to guard the input before calling.
 */
export function indexFacetIntoStore(store: FacetFtsStore, raw: unknown): void {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;
  const session_id = typeof obj['session_id'] === 'string' ? obj['session_id'].trim() : '';
  if (!session_id) return;
  const brief_summary = typeof obj['brief_summary'] === 'string' ? obj['brief_summary'] : '';
  const underlying_goal = typeof obj['underlying_goal'] === 'string' ? obj['underlying_goal'] : '';
  const primary_success = typeof obj['primary_success'] === 'string' ? obj['primary_success'] : '';
  const decisionsRaw = obj['decisions'];
  const decisions = Array.isArray(decisionsRaw)
    ? decisionsRaw.filter((d): d is string => typeof d === 'string').join(' ')
    : typeof decisionsRaw === 'string'
      ? decisionsRaw
      : '';
  store.indexFacet({ session_id, brief_summary, underlying_goal, primary_success, decisions });
}
