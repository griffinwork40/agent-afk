/**
 * Shared witness-layer discovery helpers for listing and resolving traces.
 *
 * Extracted from `src/cli/commands/trace.ts` so that both the CLI and the
 * agent-layer query module (`witness.query.ts`) can import these functions
 * without a CLI → agent or agent → CLI circular dependency.
 *
 * This module belongs to the agent layer and is intentionally import-safe
 * from both sides: it has no Commander/CLI dependencies.
 *
 * @module agent/trace/listing
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getWitnessRoot } from '../../paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One discovered trace, with the mtime used to order "most recent first". */
export interface TraceDirEntry {
  sessionId: string;
  tracePath: string;
  /** Epoch ms of the trace.jsonl mtime; 0 when the file is absent. */
  mtimeMs: number;
  exists: boolean;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan the witness root for sessions that have a `trace.jsonl`, newest
 * first. Returns an empty array when the witness root does not exist yet
 * (no session has ever emitted a trace).
 */
export async function listTraces(): Promise<TraceDirEntry[]> {
  const root = getWitnessRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const entries: TraceDirEntry[] = [];
  for (const sessionId of names) {
    const tracePath = join(root, sessionId, 'trace.jsonl');
    try {
      const st = await stat(tracePath);
      if (st.isFile()) {
        entries.push({ sessionId, tracePath, mtimeMs: st.mtimeMs, exists: true });
      }
    } catch {
      // Not a session dir, or no trace.jsonl inside — skip silently.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

/** Resolve `latest` to the newest session id, or `null` when none exist. */
export async function resolveLatestSession(): Promise<string | null> {
  const traces = await listTraces();
  return traces[0]?.sessionId ?? null;
}
