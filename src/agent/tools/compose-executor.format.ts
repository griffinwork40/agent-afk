/**
 * Formatting helpers for ComposeExecutor output.
 *
 * Extracted from `compose-executor.ts` to keep it within the 350-code-line
 * ceiling: the formatting block (constants + four functions) was the largest
 * separable internal concern.
 *
 * @module agent/tools/compose-executor.format
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getSessionsDir } from '../../paths.js';
import type { DAGRunResult } from '../dag.js';
import type { SubagentExecutionError } from '../subagent/result.js';

const MAX_NODE_OUTPUT_CHARS = 8_000;
const MAX_ERROR_CHARS = 500;
const MAX_PARTIAL_FINDINGS_CHARS = 4_000;

function formatPartialFindings(partial: unknown): string | undefined {
  if (partial === undefined || partial === null) return undefined;
  const raw = typeof partial === 'string' ? partial : JSON.stringify(partial);
  if (raw.length === 0) return undefined;
  return raw.length > MAX_PARTIAL_FINDINGS_CHARS
    ? raw.slice(0, MAX_PARTIAL_FINDINGS_CHARS) + '\n… (truncated)'
    : raw;
}

/**
 * Per-node truncation event surfaced from `formatDAGResult`. The executor
 * turns each into a `parseWarnings` line so the parent model receives a
 * structured signal that data was lost, plus the spill path it can
 * `read_file` to recover the full output across turns.
 */
export interface TruncationEvent {
  nodeId: string;
  emittedChars: number;
  totalChars: number;
  /** Absolute path where the full raw output was spilled, or undefined if
   *  the spill write failed. The truncation warning still fires either way. */
  spillPath?: string;
}

/**
 * Write the full pre-truncation node output to disk so the parent can
 * retrieve it later via `read_file`. Best-effort: failures are swallowed
 * and the caller continues without a spill path. Layout:
 *   <sessions>/<sessionId>/compose/<callId>/<nodeId>.txt
 *
 * `callId` (the compose tool_use_id) namespaces concurrent or sequential
 * compose calls within one session so repeated node IDs cannot clobber.
 */
function spillNodeOutput(
  sessionId: string,
  callId: string,
  nodeId: string,
  raw: string,
): string | undefined {
  try {
    const dir = join(getSessionsDir(), sessionId, 'compose', callId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${nodeId}.txt`);
    writeFileSync(path, raw, 'utf8');
    return path;
  } catch {
    // Spill is best-effort. The truncation warning still fires without a
    // path; the parent loses the recovery option but not the signal.
    return undefined;
  }
}

export interface FormatDAGResultOptions {
  sessionId: string;
  callId: string;
}

export interface FormatDAGResultReturn {
  content: string;
  truncations: TruncationEvent[];
}

export function formatDAGResult(
  result: DAGRunResult,
  opts: FormatDAGResultOptions,
): FormatDAGResultReturn {
  const sections: string[] = [];
  const truncations: TruncationEvent[] = [];

  for (const [id, output] of Object.entries(result.outputs)) {
    const raw = typeof output === 'string'
      ? output
      : output !== undefined && output !== null
        ? JSON.stringify(output)
        : '(no output)';
    let content: string;
    if (raw.length > MAX_NODE_OUTPUT_CHARS) {
      // Spill BEFORE slicing so the path is known when we build the marker.
      // Spill is best-effort; truncation marker still includes the path
      // hint when the write succeeded so the model can recover the full
      // text by calling `read_file` on it.
      const spillPath = spillNodeOutput(opts.sessionId, opts.callId, id, raw);
      truncations.push({
        nodeId: id,
        emittedChars: MAX_NODE_OUTPUT_CHARS,
        totalChars: raw.length,
        ...(spillPath !== undefined ? { spillPath } : {}),
      });
      const marker = spillPath !== undefined
        ? `\n… (truncated at ${MAX_NODE_OUTPUT_CHARS} / ${raw.length} chars — full output at ${spillPath})`
        : `\n… (truncated at ${MAX_NODE_OUTPUT_CHARS} / ${raw.length} chars)`;
      content = raw.slice(0, MAX_NODE_OUTPUT_CHARS) + marker;
    } else {
      content = raw;
    }
    sections.push(`## ${id}\n${content}`);
  }

  if (result.failed.length > 0) {
    for (const f of result.failed) {
      const msg = f.error.message.length > MAX_ERROR_CHARS
        ? f.error.message.slice(0, MAX_ERROR_CHARS) + '… (truncated)'
        : f.error.message;
      // Attached by `dag-subagent.ts` via `attachSubagentContext` so the
      // assistant text the failed child managed to stream before erroring
      // survives the DAG's `{ id, error }` lossy contract.
      const partial = formatPartialFindings(
        (f.error as SubagentExecutionError).partialOutput,
      );
      const body = partial
        ? `${msg}\n\n### Partial findings before failure:\n${partial}`
        : msg;
      sections.push(`## ${f.id} [FAILED]\n${body}`);
    }
  }

  if (result.skipped.length > 0) {
    sections.push(`## Skipped\n${result.skipped.join(', ')}`);
  }

  return { content: sections.join('\n\n'), truncations };
}

/**
 * Remove the entire compose spill directory for a session. Called from the
 * SessionEnd hook so spill files are reclaimed when the session ends cleanly.
 * Best-effort: a missing directory or fs error is swallowed (the session is
 * ending; nothing useful can be done with a cleanup failure beyond a log
 * line, which would only add noise). Crashed sessions leak files — that is
 * a known gap; no daemon GC job exists today.
 */
export function cleanupComposeSpills(sessionId: string): void {
  if (!sessionId) return;
  try {
    const dir = join(getSessionsDir(), sessionId, 'compose');
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // see docstring — swallowed by design
  }
}

export function formatTruncationWarning(t: TruncationEvent): string {
  const base =
    `node "${t.nodeId}" output truncated: emitted ${t.emittedChars} of ${t.totalChars} chars`;
  return t.spillPath !== undefined
    ? `${base}; full output at ${t.spillPath} (use read_file to retrieve)`
    : `${base}; full output unavailable (spill write failed)`;
}
