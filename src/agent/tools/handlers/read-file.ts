/**
 * Handler for the `read_file` tool.
 *
 * Reads a file from the filesystem and returns its content formatted with
 * line numbers. Supports offset (starting line) and limit (max lines to return).
 * Detects binary files and returns an error for files with null bytes.
 *
 * @module agent/tools/handlers/read-file
 */

import { promises as fs } from 'fs';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';

/**
 * Validates input and reads a file.
 *
 * Input shape:
 * ```ts
 * {
 *   file_path: string;      // required, absolute path
 *   offset?: number;        // optional, 1-based line number (default 1)
 *   limit?: number;         // optional, max lines to return (default 2000)
 * }
 * ```
 *
 * Output format: line numbers right-aligned with tab separator.
 * ```
 *    1\tline content
 *    2\tnext line
 * ```
 */
const readFileImpl = async (
  input: unknown,
  _signal: AbortSignal,
  context: ToolHandlerContext | undefined,
  cwd: string | undefined,
) => {
  // Validate input shape
  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected an object', isError: true };
  }

  const obj = input as Record<string, unknown>;
  const rawFilePath = obj['file_path'];
  const offset = obj['offset'] ?? 1;
  const limit = obj['limit'] ?? 2000;

  // Validate required field
  if (typeof rawFilePath !== 'string') {
    return { content: 'Invalid input: file_path must be a string', isError: true };
  }

  // Validate optional fields
  if (typeof offset !== 'number' || offset < 1) {
    return { content: 'Invalid input: offset must be a positive number', isError: true };
  }

  if (typeof limit !== 'number' || limit < 1) {
    return { content: 'Invalid input: limit must be a positive number', isError: true };
  }

  let filePath: string;
  try {
    filePath = resolveAndContain(rawFilePath, context, 'read', cwd);
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }

  try {
    // Read the entire file as a buffer first to detect binary content
    const buffer = await fs.readFile(filePath);

    // Binary detection: check for null bytes in first 8KB
    const checkSize = Math.min(8192, buffer.length);
    for (let i = 0; i < checkSize; i++) {
      if (buffer[i] === 0) {
        return { content: `File appears to be binary: ${filePath}`, isError: true };
      }
    }

    // Decode as UTF-8
    const content = buffer.toString('utf-8');

    // Handle empty file
    if (content.length === 0) {
      return { content: '' };
    }

    const lines = content.split('\n');

    // Apply offset (1-based, so offset=1 means start at index 0)
    const startIdx = Math.max(0, offset - 1);
    const endIdx = Math.min(lines.length, startIdx + limit);
    const selectedLines = lines.slice(startIdx, endIdx);

    const totalLines = lines.length;

    // Offset past end of file: file has content but the requested range is empty.
    if (selectedLines.length === 0) {
      return {
        content: `... (offset ${offset} is past end of file — file has ${totalLines} lines)`,
      };
    }

    // Format with line numbers (right-aligned, tab-separated). Width is based on the
    // highest line number in the entire file — matches cat -n behavior.
    const width = String(totalLines).length;

    const formatted = selectedLines
      .map((line, idx) => {
        const lineNumber = startIdx + idx + 1;
        return `${String(lineNumber).padStart(width, ' ')}\t${line}`;
      })
      .join('\n');

    // Partial view: append a footer with the full range so the model knows there's more.
    if (selectedLines.length < totalLines) {
      const shownStart = startIdx + 1;
      const shownEnd = startIdx + selectedLines.length;
      const more = shownEnd < totalLines ? ` — pass offset=${shownEnd + 1} to continue` : '';
      return {
        content: `${formatted}\n... (showing lines ${shownStart}-${shownEnd} of ${totalLines}${more})`,
      };
    }

    return { content: formatted };
  } catch (err) {
    // Handle specific error types
    if (err instanceof Error) {
      const errWithCode = err as Error & { code?: string };
      if (errWithCode.code === 'ENOENT') {
        return { content: `File not found: ${filePath}`, isError: true };
      }
      if (errWithCode.code === 'EACCES') {
        return { content: `Permission denied: ${filePath}`, isError: true };
      }
      // Generic error
      return { content: `Error reading file: ${err.message}`, isError: true };
    }
    return { content: 'Unknown error reading file', isError: true };
  }
};

/**
 * Create a `read_file` handler closed over a session-specific base path.
 *
 * When invoked without a dispatcher context (or one lacking `resolveBase`/
 * `cwd`), `cwd` becomes the resolve base — so a handler built for a worktree
 * session anchors and confines relative paths to that tree instead of the host
 * `process.cwd()`. `cwd === undefined` preserves the legacy unconfined behavior.
 * Mirrors `createGlobHandler`/`createGrepHandler` so all six filesystem handlers
 * share one session-cwd fallback tier. See issue #434.
 */
export function createReadFileHandler(cwd?: string): ToolHandler {
  return (input, signal, context) => readFileImpl(input, signal, context, cwd);
}

/** Bare `read_file` handler with no session cwd (`createReadFileHandler()`). */
export const readFileHandler: ToolHandler = createReadFileHandler();
