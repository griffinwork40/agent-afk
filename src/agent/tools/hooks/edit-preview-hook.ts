/**
 * Edit-preview hook: computes a diff preview at PreToolUse time for
 * edit_file calls and communicates it to the tool lane via a callback ref.
 *
 * Non-blocking. Returns {} (passthrough) always — this is display-only.
 * No I/O. Skips subagents (parentSessionId set) — they have no overlay.
 *
 * @module agent/tools/hooks/edit-preview-hook
 */

import { computeLineDiff } from '../../../utils/diff.js';
import type { HookContext, HookDecision, HookHandler } from '../../hooks.js';
import type { DiffPayload } from '../../../utils/diff.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EditPreviewHookOptions {
  /**
   * Mutable ref populated by the StreamRenderer when it arms. The hook
   * calls `ref.current(toolUseId, diff)` to deliver the preview to the
   * tool lane without importing any CLI-layer module.
   *
   * Remains a no-op `() => {}` until the StreamRenderer arms it each turn.
   * On non-interactive surfaces (daemon, Telegram) it is never armed.
   */
  addPreviewDiffRef: { current: (toolUseId: string, diff: DiffPayload) => void };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `PreToolUse` hook that computes a pre-execution diff for
 * `edit_file` calls and delivers it to the tool lane via the supplied ref.
 *
 * @param opts - {@link EditPreviewHookOptions}
 * @returns A {@link HookHandler} to register on the `PreToolUse` event.
 */
export function createEditPreviewHook(opts: EditPreviewHookOptions): HookHandler {
  return (context: HookContext): HookDecision => {
    // Guard: only PreToolUse
    if (context.event !== 'PreToolUse') return {};
    // Guard: only edit_file
    if (context.toolName !== 'edit_file') return {};
    // Guard: subagents have no overlay — skip silently
    if (context.parentSessionId !== undefined) return {};
    // Guard: need a toolUseId to key the lane entry
    if (!context.toolUseId) return {};

    const input = context.input as Record<string, unknown> | undefined;
    if (!input) return {};
    const oldStr = typeof input['old_string'] === 'string' ? input['old_string'] : undefined;
    const newStr = typeof input['new_string'] === 'string' ? input['new_string'] : undefined;
    if (oldStr === undefined || newStr === undefined) return {};
    // No-op edit: mirrors computeLineDiff null-on-identical behavior
    if (oldStr === newStr) return {};

    const diff = computeLineDiff(oldStr, newStr);
    if (diff === null) return {};

    opts.addPreviewDiffRef.current(context.toolUseId, diff);
    return {};
  };
}
