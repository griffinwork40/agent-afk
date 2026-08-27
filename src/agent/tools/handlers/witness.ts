/**
 * Tool handlers for witness-layer trace search.
 *
 * Two built-in tools:
 *   - `read_witness`   — read/filter events from one session's trace
 *   - `search_witness`  — text-search across recent sessions' traces
 *
 * Both are read-only, concurrency-safe, and available in every subagent fork
 * automatically — no config, no MCP, no index. At current corpus scale
 * (~2 K sessions, ~444 MB) a linear NDJSON scan is fast enough.
 *
 * @module agent/tools/handlers/witness
 */

import type { ToolHandler } from '../types.js';
import { readSessionTrace, searchAcrossSessions } from './witness.query.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asObj(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  return input as Record<string, unknown>;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

// ---------------------------------------------------------------------------
// read_witness handler
// ---------------------------------------------------------------------------

export const readWitnessHandler: ToolHandler = async (input) => {
  const obj = asObj(input);
  if (!obj) {
    return { content: 'Invalid input: expected object', isError: true };
  }

  const session = typeof obj['session'] === 'string' ? obj['session'] : undefined;
  const kinds = asStringArray(obj['kinds']);
  const toolName = typeof obj['tool_name'] === 'string' ? obj['tool_name'] : undefined;
  const errorsOnly = typeof obj['errors_only'] === 'boolean' ? obj['errors_only'] : false;
  const limit = typeof obj['limit'] === 'number' ? obj['limit'] : undefined;

  try {
    const result = await readSessionTrace({
      session,
      kinds,
      toolName,
      errorsOnly,
      limit,
    });
    return { content: JSON.stringify(result) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `read_witness failed: ${msg}`, isError: true };
  }
};

// ---------------------------------------------------------------------------
// search_witness handler
// ---------------------------------------------------------------------------

export const searchWitnessHandler: ToolHandler = async (input) => {
  const obj = asObj(input);
  if (!obj) {
    return { content: 'Invalid input: expected object', isError: true };
  }

  if (typeof obj['query'] !== 'string' || !obj['query']) {
    return { content: 'Invalid input: query (string) is required', isError: true };
  }

  const query = obj['query'] as string;
  const sessions = typeof obj['sessions'] === 'number' ? obj['sessions'] : undefined;
  const kinds = asStringArray(obj['kinds']);
  const since = typeof obj['since'] === 'string' ? obj['since'] : undefined;
  const toolName = typeof obj['tool_name'] === 'string' ? obj['tool_name'] : undefined;

  try {
    const result = await searchAcrossSessions({
      query,
      sessions,
      kinds,
      since,
      toolName,
    });
    return { content: JSON.stringify(result) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `search_witness failed: ${msg}`, isError: true };
  }
};
