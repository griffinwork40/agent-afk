/**
 * JSONL tool-log reader for what-if episode gate output.
 *
 * The episode gate (`AFK_WHATIF_TOOL_LOG`) appends one JSONL line per tool
 * call made during an episode:
 *   `{"ts":number,"tool":string,"input":unknown,"verdict":"executed"|"recorded","subagent":boolean}`
 *
 * This module reads, tolerantly parses, and maps those lines to the
 * {@link ToolRequest} shape expected by {@link EpisodeTrace}.
 *
 * @module whatif/runner/tool-log
 */

import { readFile } from 'node:fs/promises';
import type { ToolRequest } from '../types.js';

// ---------------------------------------------------------------------------
// Internal shape
// ---------------------------------------------------------------------------

interface RawToolLogEntry {
  ts?: unknown;
  tool?: unknown;
  input?: unknown;
  verdict?: unknown;
  subagent?: unknown;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse one raw JSONL line into a {@link ToolRequest}, or return `null` when
 * the line is malformed or missing required fields.
 *
 * Tolerant: unknown extra fields and missing `ts`/`subagent` are ignored.
 */
function parseLine(line: string): ToolRequest | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let raw: RawToolLogEntry;
  try {
    raw = JSON.parse(trimmed) as RawToolLogEntry;
  } catch {
    return null;
  }
  if (typeof raw.tool !== 'string' || raw.tool.length === 0) return null;
  const verdict = raw.verdict === 'executed' || raw.verdict === 'recorded'
    ? raw.verdict
    : null;
  if (verdict === null) return null;
  return { tool: raw.tool, input: raw.input ?? null, verdict };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read and parse a tool-log file created by the episode gate.
 *
 * Tolerant of partial writes and corrupt lines — any unrecognisable line is
 * silently skipped. Returns an empty array when the file does not exist.
 */
export async function readToolLog(path: string): Promise<ToolRequest[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    // ENOENT is normal: no tools were called, or the file was already deleted.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const results: ToolRequest[] = [];
  for (const line of content.split('\n')) {
    const entry = parseLine(line);
    if (entry !== null) results.push(entry);
  }
  return results;
}
