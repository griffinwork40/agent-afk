/**
 * Validation logic for patch_apply tool.
 *
 * Validates a set of file changes before they are applied:
 *   - Path containment via write roots
 *   - Write denylist enforcement
 *   - Optional SHA-256 hash verification
 *   - Edit exact-match-once enforcement
 *   - Mutual-exclusion between `edits` and `content`
 *
 * All errors across ALL files are collected before returning — validation
 * never short-circuits after the first failure.
 *
 * @module agent/tools/handlers/patch-validate
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import type { ToolHandlerContext } from '../types.js';
import { assertNotDenylisted } from './write-denylist.js';
import { resolveAndContain } from './_cwd-utils.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single file change in a patch. */
export interface PatchFileChange {
  path: string;
  /** Optional SHA-256 hash to verify before applying (format: "sha256:<hex>"). */
  expected_hash?: string;
  /** Sequential string replacements — each `old` must match exactly once. */
  edits?: Array<{ old: string; new: string }>;
  /** Full replacement content (mutually exclusive with `edits`). */
  content?: string;
}

/** A single validation error for a file. */
export interface ValidationError {
  path: string;
  error: string;
  detail?: string;
}

/** Result of validating a batch of patch changes. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /**
   * Current file contents keyed by resolved path, for rollback.
   * `null` means the file did not exist before the patch (new file);
   * `''` means the file existed and was empty.
   */
  fileContents: Map<string, string | null>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of UTF-8 string content. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * Returns 0 immediately for an empty needle.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Exported validator
// ---------------------------------------------------------------------------

/**
 * Validate all changes in a patch. Collects ALL errors — never short-circuits
 * on the first failure.
 *
 * @param changes     - Array of file changes to validate.
 * @param resolveBase - Base directory for resolving relative paths.
 * @param context     - Optional tool-handler context (write roots, allowAll).
 */
export async function validatePatchChanges(
  changes: PatchFileChange[],
  resolveBase: string,
  context?: ToolHandlerContext,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const fileContents = new Map<string, string | null>();

  for (const change of changes) {
    const rawPath = change.path;

    // 1. Resolve path and check containment within write roots.
    let resolvedPath: string;
    try {
      resolvedPath = resolveAndContain(rawPath, context, 'write', resolveBase);
    } catch (err) {
      errors.push({
        path: rawPath,
        error: 'path_containment',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue; // Cannot proceed without a valid resolved path.
    }

    // 2. Write denylist check.
    try {
      assertNotDenylisted(resolvedPath, 'patch_apply');
    } catch (err) {
      errors.push({
        path: rawPath,
        error: 'write_denied',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue; // Cannot validate further for a denied path (matches path_containment pattern).
    }

    // 3. Mutual exclusion: edits and content are mutually exclusive.
    if (change.edits !== undefined && change.content !== undefined) {
      errors.push({
        path: rawPath,
        error: 'mutually_exclusive',
        detail: '`edits` and `content` cannot both be provided for the same file.',
      });
      // Cannot validate further for this file without knowing the mode.
      continue;
    }

    // 4. At least one of edits or content must be present.
    if (change.edits === undefined && change.content === undefined) {
      errors.push({
        path: rawPath,
        error: 'no_change_specified',
        detail: 'At least one of `edits` or `content` must be provided.',
      });
      continue;
    }

    // 5. Read current file content (needed for hash check and edit validation).
    let currentContent: string | undefined;
    try {
      currentContent = await readFile(resolvedPath, 'utf-8');
    } catch (err) {
      // File may not exist yet (new file via content). Only treat as an error
      // if we need to verify the hash or apply edits.
      if (change.expected_hash !== undefined || change.edits !== undefined) {
        errors.push({
          path: rawPath,
          error: 'file_read_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      // New file with `content` only — that's fine; record null as the
      // sentinel meaning "did not exist before the patch" so the engine can
      // distinguish a new file (null) from an existing empty file ('').
      fileContents.set(resolvedPath, null);
      currentContent = '';
    }

    // Store content for rollback (only when not already set by the new-file branch above).
    if (!fileContents.has(resolvedPath)) {
      fileContents.set(resolvedPath, currentContent);
    }

    // 6. Hash verification (if expected_hash provided).
    if (change.expected_hash !== undefined) {
      const prefix = 'sha256:';
      if (!change.expected_hash.startsWith(prefix)) {
        errors.push({
          path: rawPath,
          error: 'invalid_hash_format',
          detail: `expected_hash must start with "sha256:". Got: "${change.expected_hash}"`,
        });
        continue; // Cannot meaningfully validate edits on a file with a bad hash format.
      }
      const expectedHex = change.expected_hash.slice(prefix.length);
      const actualHex = sha256Hex(currentContent);
      if (actualHex !== expectedHex) {
        errors.push({
          path: rawPath,
          error: 'hash_mismatch',
          detail:
            `File hash mismatch. Expected sha256:${expectedHex}, ` +
            `got sha256:${actualHex}. The file may have been modified.`,
        });
        continue; // File is in a different state than expected; skip edit validation.
      }
    }

    // 7. Edit exact-match-once validation.
    if (change.edits !== undefined) {
      // Apply edits sequentially on a running copy to validate each against the
      // progressively-modified content (matches how the engine will apply them).
      let runningContent = currentContent;
      for (let i = 0; i < change.edits.length; i++) {
        const edit = change.edits[i]!;
        const occurrences = countOccurrences(runningContent, edit.old);
        if (occurrences === 0) {
          errors.push({
            path: rawPath,
            error: 'edit_not_found',
            detail: `Edit #${i + 1}: \`old\` string not found in file.`,
          });
          // Stop validating further edits for this file: the content state is
          // now uncertain, so subsequent edits would be validated against
          // incorrect content (producing false edit_not_found errors).
          break;
        } else if (occurrences > 1) {
          errors.push({
            path: rawPath,
            error: 'edit_ambiguous',
            detail:
              `Edit #${i + 1}: \`old\` string matches ${occurrences} locations. ` +
              `Provide enough context to make it unique.`,
          });
        } else {
          // Advance running content for subsequent edit validations.
          const idx = runningContent.indexOf(edit.old);
          runningContent =
            runningContent.slice(0, idx) + edit.new + runningContent.slice(idx + edit.old.length);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    fileContents,
  };
}
