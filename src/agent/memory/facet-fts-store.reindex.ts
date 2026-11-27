/**
 * Late re-index of one session's facet row. Enrichment that lands after the
 * synchronous SessionEnd write (the asynchronous outcome record with commit
 * subjects, changed files and PR links; the yield probe's pr_url) reaches
 * the index through this call. It runs only on those asynchronous paths.
 */
import { join } from 'node:path';
import { getFacetCacheDir, getMemoryDir, validateSessionId } from '../../paths.js';
import { debugLog } from '../../utils/debug.js';
import { readJsonFileLoose } from '../../utils/json-file.js';
import { FacetFtsStore } from './facet-fts-store.js';
import { indexFacetIntoStore } from './memory-store.facet-index.js';

export interface ReindexOptions {
  cwd?: string;
  memoryDir?: string;
  cacheDir?: string;
}

/** Re-project the cached facet and upsert it. Never throws; a busy index is skipped. */
export function reindexSessionFacet(sessionId: string, options: ReindexOptions = {}): void {
  try {
    validateSessionId(sessionId);
    const raw = readJsonFileLoose<unknown>(join(options.cacheDir ?? getFacetCacheDir(), `${sessionId}.json`));
    if (raw === undefined) return;
    const store = new FacetFtsStore(options.memoryDir ?? getMemoryDir(), { busyTimeoutMs: 0 });
    try {
      indexFacetIntoStore(store, raw, { sidecarId: sessionId, ...(options.cwd ? { cwd: options.cwd } : {}) });
    } finally {
      store.close();
    }
  } catch (err) {
    debugLog('facet-fts-store: late re-index failed (non-fatal):', String(err));
  }
}
