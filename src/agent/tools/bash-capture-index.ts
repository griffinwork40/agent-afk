/**
 * Searchable index for bash output capture files.
 *
 * Bash captures are written to:
 *   $AFK_STATE_DIR/witness/<sessionId>/bash-captures/<toolUseId>.txt
 * when a command's output exceeds the 100 KB model-facing cap.
 *
 * This module scans the witness tree for capture files and returns a
 * filterable, sorted list that the `afk captures list` CLI command uses
 * to display recent captures with session, timestamp, size, and a
 * one-line command preview extracted from the capture's first line.
 *
 * Design decisions:
 * - Read-only; never writes or mutates capture files.
 * - Best-effort: per-session errors (unreadable dirs) are caught and
 *   skipped so a single corrupt session never aborts the whole scan.
 * - Command preview is taken from the first non-empty line of the
 *   capture file (the bash handler writes the raw output, not a header).
 *   When the file is empty or unreadable the preview is "(no preview)".
 * - Results are sorted by file mtime, newest first, then limited to
 *   `maxResults` before returning — callers don't have to page manually.
 *
 * @module agent/tools/bash-capture-index
 */

import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { getWitnessRoot } from '../../paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One discovered bash capture entry. */
export interface CaptureEntry {
  /** Session that produced the capture. */
  sessionId: string;
  /** `toolUseId` slug (filename without `.txt`). */
  toolUseId: string;
  /** Absolute path to the `.txt` capture file. */
  filePath: string;
  /** File mtime in epoch ms. */
  mtimeMs: number;
  /** File size in bytes. */
  sizeBytes: number;
  /** First non-empty line of the capture, truncated to `PREVIEW_MAX_CHARS`. */
  preview: string;
}

/** Options for {@link listCaptures}. */
export interface ListCapturesOptions {
  /** Filter to a specific session id (exact match). */
  sessionId?: string;
  /** Maximum entries to return (default: 20, hard ceiling: 500). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters shown in the command preview. */
const PREVIEW_MAX_CHARS = 120;

/** Bytes to read from each capture file for the preview extraction. */
const PREVIEW_READ_BYTES = 512;

/** Hard ceiling on results even when the caller asks for more. */
const MAX_RESULTS_CEILING = 500;

/** Default number of results when the caller doesn't specify. */
const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Preview extraction
// ---------------------------------------------------------------------------

/**
 * Read the first non-empty line from a capture file.
 *
 * Opens the file and reads at most `PREVIEW_READ_BYTES` bytes — enough to
 * capture any reasonable first line without loading the full (up to 8 MB)
 * capture into memory. Returns "(no preview)" on any read error or when the
 * file has no non-empty lines within the sampled range.
 */
async function extractPreview(filePath: string): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.allocUnsafe(PREVIEW_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PREVIEW_READ_BYTES, 0);
    if (bytesRead === 0) return '(empty capture)';

    const text = buf.subarray(0, bytesRead).toString('utf8');
    // Find the first non-empty line.
    for (const line of text.split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed.length > 0) {
        return trimmed.length <= PREVIEW_MAX_CHARS
          ? trimmed
          : `${trimmed.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
      }
    }
    return '(no preview)';
  } catch {
    return '(no preview)';
  } finally {
    await fh?.close().catch(() => { /* best-effort */ });
  }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan the witness tree for bash capture files and return a sorted,
 * filterable list.
 *
 * Returns an empty array when no captures exist or the witness root is absent.
 * Per-session errors (unreadable directories, permission errors) are swallowed
 * so a single corrupt session cannot abort the full scan.
 */
export async function listCaptures(options: ListCapturesOptions = {}): Promise<CaptureEntry[]> {
  const { sessionId: filterSession } = options;
  const limit = Math.min(
    MAX_RESULTS_CEILING,
    options.limit !== undefined && options.limit > 0 ? options.limit : DEFAULT_LIMIT,
  );

  const witnessRoot = getWitnessRoot();

  // Enumerate session directories.
  let sessionDirs: string[];
  try {
    sessionDirs = await readdir(witnessRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  // Apply session filter if provided.
  if (filterSession !== undefined) {
    sessionDirs = sessionDirs.filter((d) => d === filterSession);
  }

  // Collect all entries across sessions.
  const entries: CaptureEntry[] = [];

  await Promise.all(
    sessionDirs.map(async (sid) => {
      const capturesDir = join(witnessRoot, sid, 'bash-captures');
      let files: string[];
      try {
        files = await readdir(capturesDir);
      } catch {
        // No bash-captures dir for this session, or unreadable — skip.
        return;
      }

      await Promise.all(
        files
          .filter((f) => f.endsWith('.txt'))
          .map(async (fname) => {
            const filePath = join(capturesDir, fname);
            let fileStat: Awaited<ReturnType<typeof stat>>;
            try {
              fileStat = await stat(filePath);
              if (!fileStat.isFile()) return;
            } catch {
              return;
            }

            const toolUseId = fname.slice(0, -4); // strip ".txt"
            const preview = await extractPreview(filePath);

            entries.push({
              sessionId: sid,
              toolUseId,
              filePath,
              mtimeMs: fileStat.mtimeMs,
              sizeBytes: fileStat.size,
              preview,
            });
          }),
      );
    }),
  );

  // Sort newest first, then apply the limit.
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.slice(0, limit);
}
