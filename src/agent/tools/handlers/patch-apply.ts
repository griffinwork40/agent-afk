/**
 * patch_apply tool handler.
 *
 * Validates and atomically applies structured multi-file changes with
 * content-hash verification and dry-run preview support.
 *
 * Flow:
 *   1. Parse and validate input shape.
 *   2. Run validatePatchChanges() — collect ALL errors before failing.
 *   3. If valid, run applyPatch() with the dry_run flag.
 *   4. Return structured JSON result.
 *
 * @module agent/tools/handlers/patch-apply
 */

import { resolve } from 'path';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { validatePatchChanges, type PatchFileChange } from './patch-validate.js';
import { applyPatch } from './patch-apply-engine.js';

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/**
 * Parse and coerce the raw tool input into a typed PatchApplyInput.
 * Throws a descriptive Error on any structural problem.
 */
function parsePatchApplyInput(input: unknown): {
  changes: PatchFileChange[];
  dry_run: boolean;
} {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Input must be an object.');
  }

  const raw = input as Record<string, unknown>;

  // --- changes ---
  if (!Array.isArray(raw['changes'])) {
    throw new Error('Input must have a "changes" field of type array.');
  }

  const changes: PatchFileChange[] = [];
  for (let i = 0; i < raw['changes'].length; i++) {
    const item = raw['changes'][i];
    if (typeof item !== 'object' || item === null) {
      throw new Error(`changes[${i}] must be an object.`);
    }
    const rawItem = item as Record<string, unknown>;

    if (typeof rawItem['path'] !== 'string' || rawItem['path'].trim() === '') {
      throw new Error(`changes[${i}].path must be a non-empty string.`);
    }

    const change: PatchFileChange = { path: rawItem['path'] };

    if (rawItem['expected_hash'] !== undefined) {
      if (typeof rawItem['expected_hash'] !== 'string') {
        throw new Error(`changes[${i}].expected_hash must be a string.`);
      }
      change.expected_hash = rawItem['expected_hash'];
    }

    if (rawItem['content'] !== undefined) {
      if (typeof rawItem['content'] !== 'string') {
        throw new Error(`changes[${i}].content must be a string.`);
      }
      change.content = rawItem['content'];
    }

    if (rawItem['edits'] !== undefined) {
      if (!Array.isArray(rawItem['edits'])) {
        throw new Error(`changes[${i}].edits must be an array.`);
      }
      const edits: Array<{ old: string; new: string }> = [];
      for (let j = 0; j < rawItem['edits'].length; j++) {
        const edit = rawItem['edits'][j];
        if (typeof edit !== 'object' || edit === null) {
          throw new Error(`changes[${i}].edits[${j}] must be an object.`);
        }
        const rawEdit = edit as Record<string, unknown>;
        if (typeof rawEdit['old'] !== 'string') {
          throw new Error(`changes[${i}].edits[${j}].old must be a string.`);
        }
        if (typeof rawEdit['new'] !== 'string') {
          throw new Error(`changes[${i}].edits[${j}].new must be a string.`);
        }
        edits.push({ old: rawEdit['old'], new: rawEdit['new'] });
      }
      change.edits = edits;
    }

    changes.push(change);
  }

  // --- dry_run ---
  let dry_run = false;
  if (raw['dry_run'] !== undefined) {
    if (typeof raw['dry_run'] !== 'boolean') {
      throw new Error('dry_run must be a boolean.');
    }
    dry_run = raw['dry_run'];
  }

  return { changes, dry_run };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Create a `patch_apply` handler closed over a session-specific base path.
 * Mirrors the factory pattern from `createEditFileHandler`.
 */
export function createPatchApplyHandler(cwd?: string): ToolHandler {
  return async (
    input: unknown,
    _signal: AbortSignal,
    context?: ToolHandlerContext,
  ) => {
    // Determine the resolve base: context takes priority, then factory cwd,
    // then process.cwd() as last resort.
    const resolveBase =
      context?.resolveBase ?? context?.cwd ?? cwd ?? resolve(process.cwd());

    // Parse input.
    let parsed: ReturnType<typeof parsePatchApplyInput>;
    try {
      parsed = parsePatchApplyInput(input);
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }

    const { changes, dry_run } = parsed;

    if (changes.length === 0) {
      return {
        content: JSON.stringify(
          {
            status: 'applied',
            diff: '',
            files_changed: [],
            errors: [],
          },
          null,
          2,
        ),
        isError: false,
      };
    }

    // Validate.
    const validation = await validatePatchChanges(changes, resolveBase, context);

    if (!validation.valid) {
      const result = {
        status: 'validation_failed' as const,
        diff: '',
        files_changed: [],
        errors: validation.errors,
      };
      return {
        content: JSON.stringify(result, null, 2),
        isError: true,
      };
    }

    // Apply (or dry-run).
    const applyResult = await applyPatch(
      changes,
      validation.fileContents,
      resolveBase,
      dry_run,
    );

    const isError =
      applyResult.status === 'validation_failed' ||
      applyResult.status === 'partial_failure';

    return {
      content: JSON.stringify(
        {
          status: applyResult.status,
          diff: applyResult.diff,
          files_changed: applyResult.files_changed,
          errors: applyResult.errors,
        },
        null,
        2,
      ),
      isError,
    };
  };
}

/** Bare `patch_apply` handler with no session cwd. */
export const patchApplyHandler: ToolHandler = createPatchApplyHandler();
