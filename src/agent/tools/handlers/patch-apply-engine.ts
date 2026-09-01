/**
 * Atomic patch-apply engine for the patch_apply tool.
 *
 * Applies a validated set of file changes atomically using temp-file + rename.
 * Supports dry-run mode (returns diff without touching the filesystem) and
 * best-effort rollback on partial failure.
 *
 * @module agent/tools/handlers/patch-apply-engine
 */

import { createHash, randomBytes } from 'crypto';
import { writeFile, rename, mkdir, unlink, chmod, stat } from 'fs/promises';
import { dirname, join, isAbsolute, resolve } from 'path';
import { computeLineDiff } from '../../../utils/diff.js';
import type { PatchFileChange, ValidationError } from './patch-validate.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of applying (or dry-running) a patch. */
export interface PatchApplyResult {
  status: 'applied' | 'dry_run' | 'validation_failed' | 'partial_failure';
  /** Unified diff of all changes (empty string if no changes). */
  diff: string;
  files_changed: Array<{
    path: string;
    before_hash: string;
    after_hash: string;
  }>;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of UTF-8 content. */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Format a structured {@link DiffPayload} as a unified-diff string for a
 * given file pair. Returns an empty string when the payload is null (identical
 * content).
 */
function formatUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
): string {
  const payload = computeLineDiff(before, after);
  if (!payload) return '';

  const lines: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  for (const hunk of payload.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) {
      lines.push(`${line.kind}${line.text}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Apply edits sequentially. Each edit replaces the FIRST (and only validated)
 * occurrence of `old` with `new`. Returns the modified content.
 */
function applyEdits(
  content: string,
  edits: Array<{ old: string; new: string }>,
): string {
  let result = content;
  for (const edit of edits) {
    const idx = result.indexOf(edit.old);
    if (idx === -1) {
      // Should not happen after validation, but guard defensively.
      throw new Error(
        `patch_apply engine: edit old-string not found at apply time (validation may have passed a stale snapshot).`,
      );
    }
    result = result.slice(0, idx) + edit.new + result.slice(idx + edit.old.length);
  }
  return result;
}

/** Generate a stable temp-file name in the same directory as the target. */
function tempPath(targetPath: string): string {
  const suffix = randomBytes(8).toString('hex');
  return join(dirname(targetPath), `.patch-tmp-${suffix}`);
}

// ---------------------------------------------------------------------------
// Exported engine
// ---------------------------------------------------------------------------

/**
 * Apply a validated set of file changes, optionally as a dry run.
 *
 * Pre-condition: `fileContents` was produced by {@link validatePatchChanges}
 * for the same `changes` array.
 *
 * @param changes      - Validated file changes.
 * @param fileContents - Current file contents keyed by RESOLVED path.
 * @param resolveBase  - Used to form relative paths in diff headers.
 * @param dryRun       - When true, compute diffs but do not write.
 */
export async function applyPatch(
  changes: PatchFileChange[],
  fileContents: Map<string, string>,
  resolveBase: string,
  dryRun: boolean,
): Promise<PatchApplyResult> {
  // Phase 1: compute new content and diffs for every file.
  const planned: Array<{
    resolvedPath: string;
    originalContent: string;
    newContent: string;
    diffBlock: string;
    /** True when the file did not exist before the patch (originalContent is ''). */
    isNewFile: boolean;
  }> = [];

  for (const change of changes) {
    // Derive the resolved path using the same logic as the validator:
    // path.resolve(resolveBase, changePath) handles both absolute and relative
    // paths without suffix-collision ambiguity (e.g. "dir/foo.ts" vs "foo.ts").
    const resolvedPath = isAbsolute(change.path)
      ? change.path
      : resolve(resolveBase, change.path);

    const originalContent = fileContents.get(resolvedPath) ?? '';
    // A file is "new" when the validator stored an empty string because the
    // file didn't exist on disk. Use has() to distinguish missing key (new
    // file) from an existing empty file (the validator always sets the key).
    const isNewFile = !fileContents.has(resolvedPath);

    let newContent: string;
    if (change.content !== undefined) {
      newContent = change.content;
    } else if (change.edits !== undefined) {
      newContent = applyEdits(originalContent, change.edits);
    } else {
      // Should not happen post-validation, but guard.
      throw new Error(`patch_apply engine: change for ${change.path} has neither content nor edits.`);
    }

    const diffBlock = formatUnifiedDiff(change.path, originalContent, newContent);

    planned.push({ resolvedPath, originalContent, newContent, diffBlock, isNewFile });
  }

  // Build combined diff string.
  const combinedDiff = planned.map((p) => p.diffBlock).filter(Boolean).join('\n');

  // Compute result metadata (before/after hashes).
  const filesChanged = planned.map((p) => ({
    path: p.resolvedPath,
    before_hash: `sha256:${sha256Hex(p.originalContent)}`,
    after_hash: `sha256:${sha256Hex(p.newContent)}`,
  }));

  // Dry-run: return without touching the filesystem.
  if (dryRun) {
    return {
      status: 'dry_run',
      diff: combinedDiff,
      files_changed: filesChanged,
      errors: [],
    };
  }

  // Phase 2: atomic apply via temp files.
  // Write each new content to a temp file (same directory — ensures same mount
  // point for an atomic rename). Collect temp paths for rollback.
  const tempFiles: Array<{ tempPath: string; targetPath: string; originalMode: number | undefined }> = [];
  const writeErrors: ValidationError[] = [];

  for (const plan of planned) {
    const tmp = tempPath(plan.resolvedPath);
    try {
      // Preserve original file permissions for existing files. Capture the
      // mode BEFORE writing the temp so the original is still on disk.
      let originalMode: number | undefined;
      if (!plan.isNewFile) {
        try {
          const s = await stat(plan.resolvedPath);
          originalMode = s.mode;
        } catch {
          // If we can't stat (e.g. race condition), proceed without chmod.
        }
      }
      // Ensure the parent directory exists (for new files).
      await mkdir(dirname(plan.resolvedPath), { recursive: true });
      await writeFile(tmp, plan.newContent, 'utf-8');
      // Restore original permissions on the temp file before rename so the
      // final file inherits the correct mode, not the process umask.
      if (originalMode !== undefined) {
        await chmod(tmp, originalMode);
      }
      tempFiles.push({ tempPath: tmp, targetPath: plan.resolvedPath, originalMode });
    } catch (err) {
      writeErrors.push({
        path: plan.resolvedPath,
        error: 'temp_write_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (writeErrors.length > 0) {
    // Clean up any temp files already written.
    for (const tf of tempFiles) {
      try {
        await unlink(tf.tempPath);
      } catch {
        // Best-effort cleanup.
      }
    }
    return {
      status: 'partial_failure',
      diff: combinedDiff,
      files_changed: filesChanged,
      errors: writeErrors,
    };
  }

  // Commit point: rename all temp files to their targets atomically.
  const renameErrors: ValidationError[] = [];
  const completedRenames: Array<{
    targetPath: string;
    originalContent: string;
    isNewFile: boolean;
  }> = [];

  for (let i = 0; i < tempFiles.length; i++) {
    const tf = tempFiles[i]!;
    try {
      await rename(tf.tempPath, tf.targetPath);
      completedRenames.push({
        targetPath: tf.targetPath,
        originalContent: planned[i]!.originalContent,
        isNewFile: planned[i]!.isNewFile,
      });
    } catch (err) {
      renameErrors.push({
        path: tf.targetPath,
        error: 'rename_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (renameErrors.length > 0) {
    // Partial failure: roll back successfully-renamed files.
    // For files that didn't exist before the patch, unlink the newly created
    // file (there is no original content to restore). For existing files,
    // overwrite with the original content.
    for (const completed of completedRenames) {
      try {
        if (completed.isNewFile) {
          await unlink(completed.targetPath);
        } else {
          await writeFile(completed.targetPath, completed.originalContent, 'utf-8');
        }
      } catch {
        // Best-effort rollback — log but continue.
      }
    }
    // Also clean up remaining temp files.
    for (const tf of tempFiles) {
      try {
        await unlink(tf.tempPath);
      } catch {
        // Best-effort cleanup.
      }
    }
    return {
      status: 'partial_failure',
      diff: combinedDiff,
      files_changed: filesChanged,
      errors: renameErrors,
    };
  }

  return {
    status: 'applied',
    diff: combinedDiff,
    files_changed: filesChanged,
    errors: [],
  };
}
