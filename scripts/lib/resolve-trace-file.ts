/**
 * Shared trace-file resolver for witness-trace analysis scripts.
 *
 * Previously duplicated verbatim in `scripts/measure-read-dedup.ts` and
 * `scripts/measure-tool-rounds.ts`. Extracted here so both scripts share
 * identical session-discovery and error-message logic.
 *
 * Contract: pure resolution — reads the filesystem but never prints to stdout,
 * never exits. Callers own error reporting and `process.exit`.
 *
 * Exported errors use the same messages both scripts previously emitted so
 * that any consumer-level output is byte-identical.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Resolved trace path or a structured error the caller may print and exit on. */
export type TraceResolution = { path: string } | { error: string };

/**
 * Arguments accepted by the resolver. All fields optional to support both
 * callers:
 *
 * - `measure-read-dedup.ts` passes `file`, `session`, or `latest`.
 * - `measure-tool-rounds.ts` passes only `session` or `latest` (no `--file`).
 *
 * Contract: exactly one of `file`, `session`, or `latest` is truthy (callers
 * validate before calling — the resolver trusts the precondition).
 */
export interface TraceArgs {
  /** Absolute or CWD-relative path to a trace.jsonl file. */
  file?: string;
  /** Session label prefix to look up under the witness dir. */
  session?: string;
  /** Resolve to the most-recently-modified session. */
  latest?: boolean;
}

/**
 * Resolve the trace file path given a witness directory and caller arguments.
 *
 * Replaces the two identical inline `resolveTraceFile()` functions.
 *
 * @param witnessDir  Absolute path to the witness directory
 *                    (`$AFK_STATE_DIR/witness`).
 * @param args        Parsed CLI arguments (one of file/session/latest truthy).
 * @param cwd         Working directory for resolving a relative `--file` path.
 *                    Defaults to `process.cwd()`.
 */
export function resolveTraceFile(
  witnessDir: string,
  args: TraceArgs,
  cwd: string = process.cwd(),
): TraceResolution {
  // ── --file: resolve directly without scanning the witness dir ─────────────
  if (args.file) {
    // Use path.isAbsolute() for platform-aware detection so Windows paths
    // like `C:\...` are handled correctly (finding #3319-medium).
    const p = isAbsolute(args.file) ? args.file : join(cwd, args.file);
    if (!existsSync(p)) return { error: `File not found: ${p}` };
    return { path: p };
  }

  // ── Session lookup: witness dir must exist ──────────────────────────────
  if (!existsSync(witnessDir)) {
    return { error: `Witness directory not found: ${witnessDir}` };
  }

  const sessions = readdirSync(witnessDir)
    .filter(d => existsSync(join(witnessDir, d, 'trace.jsonl')))
    .map(d => ({
      name: d,
      tracePath: join(witnessDir, d, 'trace.jsonl'),
      mtime: statSync(join(witnessDir, d, 'trace.jsonl')).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (sessions.length === 0) {
    return { error: 'No sessions with traces found.' };
  }

  // ── --latest ────────────────────────────────────────────────────────────
  if (args.latest) return { path: sessions[0]!.tracePath };

  // ── --session <prefix> ──────────────────────────────────────────────────
  const prefix = args.session!;
  const match = sessions.filter(s => s.name.startsWith(prefix));
  if (match.length === 0) return { error: `No session matching prefix: ${prefix}` };
  if (match.length > 1) {
    return { error: `Ambiguous session prefix "${prefix}" -- matches: ${match.map(m => m.name).join(', ')}` };
  }
  return { path: match[0]!.tracePath };
}
