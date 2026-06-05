/**
 * Tool handler for writing files.
 *
 * Validates input, creates parent directories recursively, and writes content
 * to the filesystem. Returns a success message with byte count or an error result.
 *
 * @module agent/tools/handlers/write-file
 */

import { env } from '../../../config/env.js';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { dirname } from 'path';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { assertNotDenylisted } from './write-denylist.js';
import { resolveAndContain } from './_cwd-utils.js';
import { computeLineDiff, type DiffPayload } from '../../../utils/diff.js';

/**
 * Input shape for the write_file tool (validated at runtime).
 */
interface WriteFileInput {
  file_path?: unknown;
  content?: unknown;
}

/**
 * Validate and parse write_file tool input.
 * @throws if required fields are missing or have wrong type
 */
function parseWriteFileInput(input: unknown): {
  file_path: string;
  content: string;
} {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Input must be an object');
  }

  const writeInput = input as WriteFileInput;

  if (typeof writeInput.file_path !== 'string') {
    throw new Error('Input must have a "file_path" field of type string');
  }

  if (typeof writeInput.content !== 'string') {
    throw new Error('Input must have a "content" field of type string');
  }

  return {
    file_path: writeInput.file_path,
    content: writeInput.content,
  };
}

/**
 * Writes content to a file, creating parent directories if needed.
 * Returns a success message with byte count on success.
 * Returns an error result for permission issues.
 * Throws for invalid input (caught by the dispatcher).
 */
export const writeFileHandler: ToolHandler = async (
  input: unknown,
  signal: AbortSignal,
  context?: ToolHandlerContext,
) => {
  if (signal.aborted) {
    return {
      content: 'Aborted',
      isError: true,
    };
  }

  const { file_path: rawFilePath, content } = parseWriteFileInput(input);

  let file_path: string;
  try {
    file_path = resolveAndContain(rawFilePath, context, 'write');
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }

  try {
    assertNotDenylisted(file_path, 'write_file');

    // Opt-out: AFK_WRITE_DIFF=0 (or "false"/"no"/"off") skips the pre-read
    // and diff computation entirely. Aligned with the AFK_SHOW_DIFFS render
    // opt-out in tool-lane-format.ts. Default is ON.
    const writeDiffDisabled = (() => {
      const raw = env.AFK_WRITE_DIFF;
      if (raw === undefined) return false;
      const v = raw.trim().toLowerCase();
      return v === '0' || v === 'false' || v === 'no' || v === 'off';
    })();

    // Best-effort pre-read to drive a render-only diff. ENOENT (new file)
    // is the common case — the diff payload will show an all-additions
    // hunk. Any other read error → skip diff entirely and proceed with
    // the write. Binary content guard: only diff text content (no null
    // bytes), matching the semantics of the diff function (line splitting).
    // TOCTOU note: a concurrent writer between read and write can produce
    // a stale diff; the file write itself is unaffected.
    // Size guard: skip the pre-read entirely for files above MAX_DIFF_PRE_READ.
    // Without this, a write to a multi-hundred-MB file would pull the entire
    // prior content into the Node heap before the diff cell-count guard in
    // computeLineDiff has a chance to reject the work. 10 MiB is a generous
    // bound — text files large enough to exceed it produce diffs the LCS
    // engine would reject anyway via MAX_DIFF_CELLS.
    const MAX_DIFF_PRE_READ = 10 * 1024 * 1024;

    let priorContent: string | null = null;
    if (!writeDiffDisabled) {
      try {
        const st = await stat(file_path);
        if (st.size > MAX_DIFF_PRE_READ) {
          // File too large — skip diff entirely, proceed with write.
          if (env.AFK_DEBUG) {
            console.debug(`[write_file] skipping diff: prior file ${st.size} bytes > ${MAX_DIFF_PRE_READ}`);
          }
        } else {
          const buf = await readFile(file_path);
          // Use TextDecoder with fatal:true to detect invalid UTF-8 without
          // mangling the bytes first. Falls back gracefully on very old Node.
          try {
            priorContent = new TextDecoder('utf-8', { fatal: true }).decode(buf);
          } catch {
            // Binary file — suppress diff
            priorContent = null;
          }
        }
      } catch (statErr) {
        // ENOENT → new file → treat as empty for diff purposes.
        // Any other error → skip diff entirely (keep priorContent === null).
        if (statErr instanceof Error && 'code' in statErr && statErr.code === 'ENOENT') {
          priorContent = '';
        }
      }
    }

    const parentDir = dirname(file_path);
    await mkdir(parentDir, { recursive: true });
    await writeFile(file_path, content, { signal });

    let diff: DiffPayload | null = null;
    // Binary guard: skip diff for content containing null bytes.
    // `isUtf8(Buffer.from(content, 'utf8'))` is always true for JS strings;
    // null-byte check is the real binary signal we want.
    if (priorContent !== null && !content.includes('\0')) {
      const _t0 = performance.now();
      diff = computeLineDiff(priorContent, content);
      const _diffMs = performance.now() - _t0;
      if (_diffMs >= 500) {
        // Always warn in production — a 500 ms+ diff blocks the event loop.
        console.warn(`[write_file] computeLineDiff took ${_diffMs.toFixed(1)}ms`);
      } else if (_diffMs >= 50 && env.AFK_DEBUG) {
        // Developer-only debug log for the 50–499 ms range.
        console.debug(`[write_file] computeLineDiff took ${_diffMs.toFixed(1)}ms`);
      }
    }

    const byteCount = Buffer.byteLength(content, 'utf8');
    return {
      content: `Wrote ${byteCount} bytes to ${file_path}`,
      ...(diff ? { render: { diff } } : {}),
    };
  } catch (err) {
    if (err instanceof Error) {
      if ('code' in err && err.code === 'EACCES') {
        return {
          content: `Permission denied: ${file_path}`,
          isError: true,
        };
      }
      // Generic error
      return {
        content: `Error writing file: ${err.message}`,
        isError: true,
      };
    }
    return {
      content: 'Unknown error writing file',
      isError: true,
    };
  }
};
