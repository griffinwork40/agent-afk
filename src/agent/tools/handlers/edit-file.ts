/**
 * Edit file tool handler.
 *
 * Performs string replacement editing on files. Validates that the old string
 * appears exactly once (unless replace_all is true), then writes the modified
 * content back to the file. Returns a brief diff context showing the change.
 *
 * @module agent/tools/handlers/edit-file
 */

import { env } from '../../../config/env.js';
import { readFile, writeFile } from 'fs/promises';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { assertNotDenylisted } from './write-denylist.js';
import { resolveAndContain } from './_cwd-utils.js';
import { computeLineDiff } from '../../../utils/diff.js';

/**
 * Input shape for the edit_file tool (validated at runtime).
 */
interface EditFileInput {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

/**
 * Validate and parse edit_file tool input.
 * @throws if required fields are missing or have wrong type
 */
function parseEditFileInput(input: unknown): {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
} {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Input must be an object');
  }

  const editInput = input as EditFileInput;

  if (typeof editInput.file_path !== 'string') {
    throw new Error('Input must have a "file_path" field of type string');
  }

  if (typeof editInput.old_string !== 'string') {
    throw new Error('Input must have an "old_string" field of type string');
  }

  if (typeof editInput.new_string !== 'string') {
    throw new Error('Input must have a "new_string" field of type string');
  }

  let replace_all = false;
  if (editInput.replace_all !== undefined) {
    if (typeof editInput.replace_all !== 'boolean') {
      throw new Error('replace_all must be a boolean');
    }
    replace_all = editInput.replace_all;
  }

  return {
    file_path: editInput.file_path,
    old_string: editInput.old_string,
    new_string: editInput.new_string,
    replace_all,
  };
}

/**
 * Count non-overlapping occurrences of a substring in a string.
 */
function countOccurrences(text: string, substring: string): number {
  if (substring.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(substring, pos)) !== -1) {
    count++;
    pos += substring.length;
  }
  return count;
}

/**
 * Execute a string replacement on a file.
 */
export const editFileHandler: ToolHandler = async (
  input: unknown,
  signal: AbortSignal,
  context?: ToolHandlerContext,
): Promise<{ content: string; isError?: boolean }> => {
  // Check if aborted before we start.
  if (signal.aborted) {
    return {
      content: 'Aborted',
      isError: true,
    };
  }

  const { file_path: rawFilePath, old_string, new_string, replace_all } = parseEditFileInput(input);

  let file_path: string;
  try {
    file_path = resolveAndContain(rawFilePath, context, 'write');
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }

  try {
    // Denylist check — must run before the read so we never even open a
    // protected path (mirrors the write_file guard exactly).
    assertNotDenylisted(file_path, 'edit_file');

    // Read the file.
    const content = await readFile(file_path, 'utf-8');

    // Count occurrences.
    const occurrences = countOccurrences(content, old_string);

    if (occurrences === 0) {
      return {
        content: `old_string not found in ${file_path}`,
        isError: true,
      };
    }

    if (occurrences > 1 && !replace_all) {
      return {
        content: `old_string matches ${occurrences} locations in ${file_path}. Use replace_all: true or provide more context.`,
        isError: true,
      };
    }

    // Perform replacement.
    let modified: string;
    if (replace_all) {
      // Replace all occurrences.
      modified = content.split(old_string).join(new_string);
    } else {
      // Replace the first (and only) occurrence.
      const firstIndex = content.indexOf(old_string);
      modified = content.slice(0, firstIndex) + new_string + content.slice(firstIndex + old_string.length);
    }

    // Write back to file.
    await writeFile(file_path, modified, 'utf-8');

    // Build the model-facing result message. The diff itself rides on
    // `render.diff` (out-of-band) — keeping it out of `content` saves
    // tokens (model already supplied old_string + new_string) and lets
    // the renderer produce a richer multi-line block than a string allows.
    const resultMsg =
      occurrences === 1
        ? `Replaced 1 occurrence in ${file_path}`
        : `Replaced ${occurrences} occurrences in ${file_path}`;

    const _t0 = performance.now();
    const diff = computeLineDiff(content, modified);
    const _diffMs = performance.now() - _t0;
    if (_diffMs >= 500) {
      // Always warn in production — a 500 ms+ diff blocks the event loop.
      console.warn(`[edit_file] computeLineDiff took ${_diffMs.toFixed(1)}ms`);
    } else if (_diffMs >= 50 && env.AFK_DEBUG) {
      // Developer-only debug log for the 50–499 ms range.
      console.debug(`[edit_file] computeLineDiff took ${_diffMs.toFixed(1)}ms`);
    }

    return {
      content: resultMsg,
      ...(diff ? { render: { diff } } : {}),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      content: `Error: ${errorMsg}`,
      isError: true,
    };
  }
};
