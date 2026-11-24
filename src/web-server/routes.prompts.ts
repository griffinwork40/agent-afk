/**
 * Prompt-registry read routes for the `afk web` surface.
 *
 * Contract: these handlers are dispatched from `server.ts` after bearer-token
 * and Origin checks have already passed. They are read-only — no writes.
 *
 * Invariant: the registry is loaded via a DYNAMIC import inside each handler
 * so the discovery walk (filesystem traversal, file reads) is never pulled
 * into server startup. `import('../prompts/registry.js')` is lazy and cached
 * by the Node module system after the first call.
 *
 * Invariant: `sourcePath` (absolute on-disk path) is stripped from every wire
 * response. Only `relativePath` reaches the browser.
 */

import type { ServerResponse } from 'node:http';
import type { PromptEntry, PromptKind } from '../prompts/types.js';
import { sendJson } from './routes.js';

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

interface PromptEntryWire {
  id: string;
  kind: string;
  name: string;
  skill?: string;
  phase?: string;
  relativePath: string;
  editable: boolean;
  pinned: boolean;
  tokenEstimate: number;
  injectionContext: string;
}

function toWire(entry: PromptEntry): PromptEntryWire {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    ...(entry.skill !== undefined ? { skill: entry.skill } : {}),
    ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
    relativePath: entry.relativePath,
    editable: entry.editable,
    pinned: entry.pinned,
    tokenEstimate: entry.tokenEstimate,
    injectionContext: entry.injectionContext,
  };
}

// ---------------------------------------------------------------------------
// Registry accessor — dynamic import keeps discovery off the startup path
// ---------------------------------------------------------------------------

async function loadRegistry(): Promise<PromptEntry[]> {
  const { getPromptRegistry } = await import('../prompts/registry.js');
  return getPromptRegistry();
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * `GET /api/prompts` — list all prompts (metadata only, no content).
 *
 * Optional query param: `kind=<PromptKind>` to filter by kind.
 * Returns: `{ prompts: PromptEntryWire[] }`
 */
export async function handleListPrompts(
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const kindFilter = query.get('kind');
  const entries = await loadRegistry();

  const filtered =
    kindFilter !== null
      ? entries.filter((e) => e.kind === (kindFilter as PromptKind))
      : entries;

  sendJson(res, 200, { prompts: filtered.map(toWire) });
}

/**
 * `GET /api/prompts/search?q=<query>` — full-text search across prompt metadata.
 *
 * Requires: `q` parameter (returns 400 if missing or blank).
 * Returns: `{ prompts: PromptEntryWire[] }`
 */
export async function handleSearchPrompts(
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

  const { searchPrompts } = await import('../prompts/registry.js');
  const entries = searchPrompts(q);
  sendJson(res, 200, { prompts: entries.map(toWire) });
}

/**
 * `GET /api/prompts/:id` — get one prompt with its full content.
 *
 * Returns: `{ prompt: PromptEntryWire & { content: string } }`
 * Returns 404 if the id is not found.
 */
export async function handleGetPrompt(
  res: ServerResponse,
  id: string,
): Promise<void> {
  const { getPromptById } = await import('../prompts/registry.js');
  const entry = getPromptById(id);

  if (entry === undefined) {
    sendJson(res, 404, {
      error: 'not_found',
      message: `prompt ${id} not found`,
    });
    return;
  }

  const content = entry.load();
  sendJson(res, 200, { prompt: { ...toWire(entry), content } });
}
