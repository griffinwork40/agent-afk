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
import { writeFile, rename, mkdir, unlink } from 'fs/promises';
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
  }> = [];

  for (const change of changes) {
    // Derive the resolved path. fileContents is keyed by resolved path, so we
    // need to find the matching key. The validator stored entries by resolved
    // path; changes.path may be relative. We reconstruct the resolved path the
    // same way the validator did: normalise via the resolveBase.
    const resolvedPath = (() => {
      // fileContents keys ARE the resolved paths set by the validator.
      // Find the key matching this change's path.
      for (const key of fileContents.keys()) {
        if (key === change.path || key.endsWith(`/${change.path}`)) return key;
      }
      // Fallback: reconstruct from resolveBase (same logic as validator).
      return isAbsolute(change.path)
        ? change.path
        : resolve(resolveBase, change.path);
    })();

    const originalContent = fileContents.get(resolvedPath) ?? '';

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

    planned.push({ resolvedPath, originalContent, newContent, diffBlock });
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
  const tempFiles: Array<{ tempPath: string; targetPath: string }> = [];
  const writeErrors: ValidationError[] = [];

  for (const plan of planned) {
    const tmp = tempPath(plan.resolvedPath);
    try {
      // Ensure the parent directory exists (for new files).
      await mkdir(dirname(plan.resolvedPath), { recursive: true });
      await writeFile(tmp, plan.newContent, 'utf-8');
      tempFiles.push({ tempPath: tmp, targetPath: plan.resolvedPath });
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
  const completedRenames: Array<{ targetPath: string; originalContent: string }> = [];

  for (let i = 0; i < tempFiles.length; i++) {
    const tf = tempFiles[i]!;
    try {
      await rename(tf.tempPath, tf.targetPath);
      completedRenames.push({
        targetPath: tf.targetPath,
        originalContent: planned[i]!.originalContent,
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
    for (const completed of completedRenames) {
      try {
        await writeFile(completed.targetPath, completed.originalContent, 'utf-8');
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
