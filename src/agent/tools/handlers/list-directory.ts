/**
 * Handler for the `list_directory` tool.
 *
 * Lists the contents of a directory and returns entries with type annotations.
 * Directories are suffixed with `/`, files are plain names. Entries are sorted
 * alphabetically with directories first.
 *
 * @module agent/tools/handlers/list-directory
 */

import { promises as fs } from 'fs';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';

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
export const listDirectoryHandler: ToolHandler = async (input, _signal, context?: ToolHandlerContext) => {
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
    resolvedPath = resolveAndContain(rawPath, context, 'read');
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

    // Join with newlines
    const content = sorted.join('\n');
    return { content };
  } catch (err) {
    // Handle specific error types
    if (err instanceof Error) {
      const errWithCode = err as Error & { code?: string };
      if (errWithCode.code === 'ENOENT') {
        return { content: `Directory not found: ${resolvedPath}`, isError: true };
      }
      if (errWithCode.code === 'ENOTDIR') {
        return { content: `Not a directory: ${resolvedPath}`, isError: true };
      }
      if (errWithCode.code === 'EACCES') {
        return { content: `Permission denied: ${resolvedPath}`, isError: true };
      }
      // Generic error
      return { content: `Error listing directory: ${err.message}`, isError: true };
    }
    return { content: 'Unknown error listing directory', isError: true };
  }
};
