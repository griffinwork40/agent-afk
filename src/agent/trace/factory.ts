/**
 * Production trace-writer factory.
 *
 * Centralizes the wiring from "I'm a CLI entry point" → "I have a
 * TraceWriter that writes to the canonical witness-layer location".
 *
 * Canonical path: `$AFK_HOME/state/witness/<sessionLabel>/trace.jsonl`
 * (see {@link getTraceDir}). The `sessionLabel` is either supplied by the
 * caller (e.g. when resuming) or freshly generated via `randomUUID()`.
 *
 * Opt-out: set `AFK_TRACE_DISABLED=1` in the environment to return
 * `null` from {@link createDefaultTraceWriter}. Useful for tests,
 * sandboxes, or operators who explicitly do not want on-disk witness
 * records.
 *
 * See `docs/philosophy/afk-contract.md` — the witness layer is the
 * durable evidence record for unattended (AFK) work.
 *
 * @module agent/trace/factory
 */

import { env } from '../../config/env.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { getTraceDir } from '../../paths.js';
import { NdjsonTraceWriter, type TraceWriter } from './writer.js';

/** Options for {@link createDefaultTraceWriter}. */
export interface CreateDefaultTraceWriterOptions {
  /**
   * Pre-assigned label used as the trace directory name. When the CLI is
   * resuming a known session, pass its id here so the trace appends to
   * the existing directory. Otherwise omit — the factory generates a
   * fresh UUID. The label is independent of the SDK's runtime session
   * id (the SDK id is recorded inside the trace events themselves).
   */
  sessionLabel?: string;
}

/** Return value of {@link createDefaultTraceWriter} on success. */
export interface CreatedTraceWriter {
  /** The writer instance — pass into `AgentConfig.traceWriter`. */
  writer: TraceWriter;
  /** Absolute filesystem path the writer will append to. Surface this
   *  in startup logs so operators know where their witness record lives. */
  tracePath: string;
  /** The label that names the trace directory. Same as
   *  `options.sessionLabel` when provided, else the generated UUID. */
  sessionLabel: string;
}

/**
 * Construct a {@link NdjsonTraceWriter} rooted at the canonical witness
 * directory, or return `null` when tracing is disabled.
 *
 * Disabled when:
 *   - `AFK_TRACE_DISABLED` env var is set to `'1'` (operator opt-out).
 *
 * The writer is lazy: it doesn't create the directory or open the file
 * until the first {@link TraceWriter.write} call. A session that
 * initializes and immediately closes without any intervening events
 * still writes the directory + a `session_sealed` line (the seal goes
 * through the same enqueue path).
 */
/**
 * Read the last non-empty line of an NDJSON trace file and return its `seq`
 * value, or `undefined` when the file is absent, empty, or unparseable.
 * Synchronous because it runs once per resume before any async work starts.
 */
function readLastSeq(tracePath: string): number | undefined {
  if (!existsSync(tracePath)) return undefined;
  const content = readFileSync(tracePath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return undefined;
  try {
    const lastLine = lines[lines.length - 1] ?? '';
    const last = JSON.parse(lastLine) as Record<string, unknown>;
    const seq = last['seq'];
    return typeof seq === 'number' ? seq : undefined;
  } catch {
    return undefined;
  }
}

export function createDefaultTraceWriter(
  options: CreateDefaultTraceWriterOptions = {},
): CreatedTraceWriter | null {
  if (env.AFK_TRACE_DISABLED === '1') return null;

  const sessionLabel = options.sessionLabel ?? randomUUID();
  const traceDir = getTraceDir(sessionLabel);
  const tracePath = `${traceDir}/trace.jsonl`;
  const lastSeq = readLastSeq(tracePath);
  const writer = new NdjsonTraceWriter({
    traceDir,
    ...(lastSeq !== undefined ? { startSeq: lastSeq + 1 } : {}),
  });
  return {
    writer,
    tracePath: writer.getTracePath(),
    sessionLabel,
  };
}
