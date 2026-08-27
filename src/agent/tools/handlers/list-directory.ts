/**
 * Handler for the `list_directory` tool.
 *
 * Lists the contents of a directory and returns entries with type annotations.
 * Directories are suffixed with `/`, files are plain names. Entries are sorted
 * alphabetically with directories first.
 *
 * Invariant: output is capped at {@link MAX_ENTRIES} entries (matching the glob
 * tool's 500-entry convention). Directories with thousands of entries — like
 * `~/.afk/state/sessions/` (15k+) — would otherwise inject 600KB+ into the
 * context window and overflow smaller models in a single tool result.
 *
 * @module agent/tools/handlers/list-directory
 */

import { promises as fs } from 'fs';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';
import { fsErrorToToolResult } from './_fs-error.js';

/**
 * Maximum entries returned before truncation. Matches glob's 500-entry cap
 * so model-facing tools have a consistent ceiling. The full readdir runs
 * regardless — only the returned string is capped.
 */
export const MAX_ENTRIES = 500;

/**
 * Validates input and lists a directory.
 *
 * Input shape:
 * ```ts
 * {
 *   path: string;      // required, absolute path to directory
 * }
 * ```
 *
 * Output format: one entry per line, directories suffixed with `/`.
 * ```
 * directory1/
 * directory2/
 * file1.txt
 * file2.ts
 * ```
 */
const listDirectoryImpl = async (
  input: unknown,
  _signal: AbortSignal,
  context: ToolHandlerContext | undefined,
  cwd: string | undefined,
) => {
  // Validate input shape
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid input: expected an object');
  }

  const obj = input as Record<string, unknown>;
  const rawPath = obj['path'];

  // Validate required field
  if (typeof rawPath !== 'string') {
    throw new Error('Invalid input: path must be a string');
  }

  let resolvedPath: string;
  try {
    resolvedPath = resolveAndContain(rawPath, context, 'read', cwd);
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }

  try {
    // Read directory with file type information
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });

    // Separate directories and files
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`);
    const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name);

    // Sort each group alphabetically
    dirs.sort();
    files.sort();

    // Combine: directories first, then files
    const sorted = [...dirs, ...files];

    // Handle empty directory
    if (sorted.length === 0) {
      return { content: '(empty directory)' };
    }

    // Cap output to prevent context-window overflow on huge directories.
    const total = sorted.length;
    const capped = sorted.slice(0, MAX_ENTRIES);
    let content = capped.join('\n');
    if (total > MAX_ENTRIES) {
      content += `\n[results capped at ${MAX_ENTRIES} entries — ${total} total in directory]`;
    }
    return { content };
  } catch (err) {
    // Handle specific error types
    const known = fsErrorToToolResult(err, resolvedPath, 'Directory');
    if (known) return known;
    if (err instanceof Error) {
      return { content: `Error listing directory: ${err.message}`, isError: true };
    }
    return { content: 'Unknown error listing directory', isError: true };
  }
};

/**
 * Create a `list_directory` handler closed over a session-specific base path.
 * See `createReadFileHandler` — `cwd` is the last resolve-base tier for
 * out-of-context invocations; a no-op on the dispatcher path. Issue #434.
 */
export function createListDirectoryHandler(cwd?: string): ToolHandler {
  return (input, signal, context) => listDirectoryImpl(input, signal, context, cwd);
}

/** Bare `list_directory` handler with no session cwd (`createListDirectoryHandler()`). */
export const listDirectoryHandler: ToolHandler = createListDirectoryHandler();
