/**
 * Atomic patch-apply engine for the patch_apply tool.
 *
 * Applies a validated set of file changes atomically using temp-file + rename.
 * Supports dry-run mode (returns diff without touching the filesystem) and
 * best-effort rollback on partial failure.
 *
 * @module agent/tools/handlers/patch-apply-engine
 */

import { randomBytes } from 'crypto';
import { writeFile, rename, mkdir, unlink, chmod, stat } from 'fs/promises';
import { dirname, join, isAbsolute, resolve } from 'path';
import { computeLineDiff } from '../../../utils/diff.js';
import type { DiffPayload, DiffHunk } from '../../../utils/diff.js';
import { sha256Hex } from './patch-validate.js';
import type { PatchFileChange, ValidationError } from './patch-validate.js';
import { errorMessage } from '../../../utils/errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of applying (or dry-running) a patch. */
export interface PatchApplyResult {
  status: 'applied' | 'dry_run' | 'validation_failed' | 'partial_failure';
  /** Unified diff of all changes (empty string if no changes). */
  diff: string;
  /**
   * Structured diff payload merging all per-file diffs. Consumed by the
   * handler to populate `ToolResult.render.diff` for TUI rendering.
   * Undefined when no files changed.
   */
  structuredDiff?: DiffPayload;
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

/**
 * Compute a unified-diff string AND the structured {@link DiffPayload} for a
 * single file pair. Returns `{ text: '', payload: null }` when the content is
 * identical.
 */
function computeFileDiff(
  filePath: string,
  before: string,
  after: string,
): { text: string; payload: DiffPayload | null } {
  const payload = computeLineDiff(before, after);
  if (!payload) return { text: '', payload: null };

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

  return { text: lines.join('\n') + '\n', payload };
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
// Internal planned-change type
// ---------------------------------------------------------------------------

interface PlannedChange {
  resolvedPath: string;
  originalContent: string;
  newContent: string;
  diffBlock: string;
  diffPayload: DiffPayload | null;
  filePath: string;
  /** True when the file did not exist before the patch (null sentinel in fileContents). */
  isNewFile: boolean;
}

// ---------------------------------------------------------------------------
// Phase 1: plan (compute content + diffs, no I/O)
// ---------------------------------------------------------------------------

/**
 * Invariant: `fileContents` must be the map produced by validatePatchChanges
 * for the same `changes` array -- null values signal new files, strings signal
 * existing content (including empty string for an existing empty file).
 *
 * Contract: throws if a change has neither `content` nor `edits` (guarded
 * defensively; should not occur after successful validation).
 */
function planPatchChanges(
  changes: PatchFileChange[],
  fileContents: Map<string, string | null>,
  resolveBase: string | undefined,
): {
  planned: PlannedChange[];
  combinedDiff: string;
  structuredDiff: DiffPayload | undefined;
  filesChanged: Array<{ path: string; before_hash: string; after_hash: string }>;
} {
  const planned: PlannedChange[] = [];

  for (const change of changes) {
    // Derive the resolved path using the same logic as the validator:
    // path.resolve(resolveBase, changePath) handles both absolute and relative
    // paths without suffix-collision ambiguity (e.g. "dir/foo.ts" vs "foo.ts").
    const resolvedPath = isAbsolute(change.path)
      ? change.path
      : resolve(resolveBase ?? process.cwd(), change.path);

    // null sentinel = new file (did not exist before the patch).
    // '' = existing empty file. Both come from the validator.
    const storedContent = fileContents.get(resolvedPath);
    const isNewFile = storedContent === null;
    const originalContent = storedContent ?? '';

    let newContent: string;
    if (change.content !== undefined) {
      newContent = change.content;
    } else if (change.edits !== undefined) {
      newContent = applyEdits(originalContent, change.edits);
    } else {
      // Should not happen post-validation, but guard.
      throw new Error(`patch_apply engine: change for ${change.path} has neither content nor edits.`);
    }

    const fileDiff = computeFileDiff(change.path, originalContent, newContent);
    planned.push({
      resolvedPath,
      originalContent,
      newContent,
      diffBlock: fileDiff.text,
      diffPayload: fileDiff.payload,
      filePath: change.path,
      isNewFile,
    });
  }

  const combinedDiff = planned.map((p) => p.diffBlock).filter(Boolean).join('\n');

  // Merge per-file structured diffs into a single DiffPayload.
  // Stamp each hunk with its source filePath so the TUI can render
  // file-boundary headers when hunks from different files are adjacent.
  const mergedHunks: DiffHunk[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const p of planned) {
    if (!p.diffPayload) continue;
    for (const hunk of p.diffPayload.hunks) {
      mergedHunks.push({ ...hunk, filePath: p.filePath });
    }
    totalAdded += p.diffPayload.addedLines;
    totalRemoved += p.diffPayload.removedLines;
  }
  const structuredDiff: DiffPayload | undefined =
    mergedHunks.length > 0
      ? { hunks: mergedHunks, addedLines: totalAdded, removedLines: totalRemoved }
      : undefined;

  const filesChanged = planned.map((p) => ({
    path: p.resolvedPath,
    before_hash: `sha256:${sha256Hex(p.originalContent)}`,
    after_hash: `sha256:${sha256Hex(p.newContent)}`,
  }));

  return { planned, combinedDiff, structuredDiff, filesChanged };
}

// ---------------------------------------------------------------------------
// Phase 2a: write temp files
// ---------------------------------------------------------------------------

/**
 * Write each planned change to a temp file in the same directory as the
 * target (guaranteeing same mount point for an atomic rename). Preserves
 * original file permissions for existing files via stat + chmod on the temp.
 *
 * Returns `tempFiles` (one entry per successful write) and `writeErrors`
 * (validation errors for any failed write). When `writeErrors` is non-empty
 * the caller must unlink all returned `tempFiles` before returning.
 */
async function writeTempFiles(
  planned: PlannedChange[], guard?: (path: string) => Promise<void>,
): Promise<{
  tempFiles: Array<{ tempPath: string; targetPath: string; originalMode: number | undefined }>;
  writeErrors: ValidationError[];
}> {
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
      await guard?.(plan.resolvedPath);
      await mkdir(dirname(plan.resolvedPath), { recursive: true });
      await guard?.(plan.resolvedPath);
      await writeFile(tmp, plan.newContent, { encoding: 'utf-8', flag: 'wx' });
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
        detail: errorMessage(err),
      });
    }
  }

  return { tempFiles, writeErrors };
}

// ---------------------------------------------------------------------------
// Phase 2b: rename temp files to targets, roll back on partial failure
// ---------------------------------------------------------------------------

/**
 * Rename each temp file to its target path. If any rename fails, rolls back
 * all completed renames (unlink for new files, overwrite for existing ones)
 * and cleans up remaining temp files.
 *
 * Contract: `planned[i]` must correspond to `tempFiles[i]` -- same ordering
 * as returned by {@link writeTempFiles}.
 *
 * Returns `renameErrors` (empty on full success).
 */
async function renameAndRollback(
  tempFiles: Array<{ tempPath: string; targetPath: string; originalMode: number | undefined }>,
  planned: PlannedChange[],
  guard?: (path: string) => Promise<void>,
): Promise<{ renameErrors: ValidationError[] }> {
  const renameErrors: ValidationError[] = [];
  const completedRenames: Array<{
    targetPath: string;
    originalContent: string;
    isNewFile: boolean;
  }> = [];

  for (let i = 0; i < tempFiles.length; i++) {
    const tf = tempFiles[i]!;
    try {
      await guard?.(tf.targetPath);
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
        detail: errorMessage(err),
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
        // Best-effort rollback -- log but continue.
      }
    }
    // Also clean up remaining temp files.
    // ENOENT expected for temp paths already renamed; catch {} is intentional.
    for (const tf of tempFiles) {
      try {
        await unlink(tf.tempPath);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  return { renameErrors };
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
  fileContents: Map<string, string | null>,
  resolveBase: string | undefined,
  dryRun: boolean,
  guard?: (path: string) => Promise<void>,
): Promise<PatchApplyResult> {
  const { planned, combinedDiff, structuredDiff, filesChanged } =
    planPatchChanges(changes, fileContents, resolveBase);

  // Dry-run: return without touching the filesystem.
  if (dryRun) {
    return {
      status: 'dry_run',
      diff: combinedDiff,
      structuredDiff,
      files_changed: filesChanged,
      errors: [],
    };
  }

  // Phase 2a: write temp files (same directory => same mount point => atomic rename).
  const { tempFiles, writeErrors } = await writeTempFiles(planned, guard);

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

  // Validate ALL destinations before the first commit, then each destination
  // again immediately before rename. Keep one transaction/rollback boundary.
  try {
    for (const plan of planned) await guard?.(plan.resolvedPath);
  } catch (err) {
    for (const tf of tempFiles) {
      try { await unlink(tf.tempPath); } catch { /* best-effort cleanup */ }
    }
    return { status: 'validation_failed', diff: combinedDiff, files_changed: [],
      errors: [{ path: '', error: 'destination_changed', detail: errorMessage(err) }] };
  }
  // Phase 2b: commit point -- rename all temp files to their targets.
  const { renameErrors } = await renameAndRollback(tempFiles, planned, guard);

  if (renameErrors.length > 0) {
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
    structuredDiff,
    files_changed: filesChanged,
    errors: [],
  };
}
