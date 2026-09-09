/**
 * Memory viewer routes for the `afk web` surface.
 *
 * Contract: these handlers are dispatched from `server.ts` after bearer-token
 * and Origin checks have already passed. A fresh MemoryStore is opened per
 * request and closed before the response is sent to avoid holding the SQLite
 * connection open across idle periods.
 */

import type { ServerResponse } from 'node:http';
import { MemoryStore } from '../agent/memory/memory-store.js';
import { sendJson } from './routes.js';

const VALID_CATEGORIES = new Set(['preference', 'convention', 'decision', 'learning']);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ---- helpers ---------------------------------------------------------------

function clampLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// ---- route handlers --------------------------------------------------------

/**
 * `GET /api/memory/search?q=...&category=...&limit=...`
 *
 * Searches cross-session memory (facts + procedures) using the MemoryStore
 * FTS5 engine. Requires a non-empty `q` parameter.
 */
export async function handleSearchMemory(
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const q = query.get('q') ?? '';
  if (!q.trim()) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: 'q parameter is required and must be non-empty',
    });
    return;
  }

  const rawCategory = query.get('category');
  if (rawCategory !== null && !VALID_CATEGORIES.has(rawCategory)) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}`,
    });
    return;
  }

  const limit = clampLimit(query.get('limit'));
  const store = new MemoryStore();
  try {
    const results = store.search(q, {
      ...(rawCategory ? { category: rawCategory as 'preference' | 'convention' | 'decision' | 'learning' } : {}),
      limit,
    });
    sendJson(res, 200, { results });
  } finally {
    store.close();
  }
}

/**
 * `GET /api/memory/hot`
 *
 * Returns the current HOT.md content and usage statistics.
 */
export async function handleGetHotMemory(res: ServerResponse): Promise<void> {
  const store = new MemoryStore();
  try {
    const content = store.loadHot();
    const usage = store.hotUsage();
    sendJson(res, 200, { content, usage });
  } finally {
    store.close();
  }
}
