/**
 * Background-mode execution path for the Agent tool.
 *
 * Extracted from `subagent-executor.ts` `execute()`: the `mode: 'background'`
 * branch that registers the freshly-forked (not-yet-run) handle with the
 * `BackgroundAgentRegistry` and returns a synthetic "running" pointer
 * immediately, without ever awaiting `runToResult`.
 *
 * Pure-ish: receives the forked handle, the registry, and the resolved dispatch
 * fields as explicit parameters; returns the `ToolResult` to hand back to the
 * parent. No dependency on the executor instance.
 *
 * @module agent/tools/subagent/background-branch
 */

import { BackgroundJobCapError, type BackgroundAgentRegistry, type BackgroundJob } from '../../background-registry.js';
import type { SubagentManager } from '../../subagent.js';
import { debugLog } from '../../../utils/debug.js';
import type { ToolResult } from '../types.js';
import { teardownBackgroundWorktree } from '../handlers/worktree-managed.background.js';
import { errorMessage } from '../../../utils/errors.js';

type ForkedHandle = Awaited<ReturnType<SubagentManager['forkSubagent']>>;

export interface RunBackgroundBranchArgs {
  handle: ForkedHandle;
  /** May be undefined — an unwired registry yields the "not available" error. */
  registry: BackgroundAgentRegistry | undefined;
  prompt: string;
  /** Child model for the registry record; falls back to 'sonnet' when unset. */
  model: string | undefined;
  /** Optional: `IAgentSession.sessionId` is `string | undefined`; forwarded as-is into the registry record (preserves the pre-extraction contract). */
  parentSessionId: string | undefined;
  /**
   * Wave-manifest settlement callback — fired when the background job settles
   * with an `isError` boolean so the manifest unit transitions to
   * 'done'/'failed'. Captured at dispatch time so it is immune to
   * `notifyWaveEnd()` clearing `currentWaveId` before the job finishes (#1083).
   *
   * Kept separate from `budgetRelease` because the two callbacks have different
   * types: wave-manifest needs `isError`, budget-release is `() => void`. Wiring
   * them through one closure that captures both is the ordering-fragile pattern
   * Item 1 fixes — `budgetRelease` must reach the registry via
   * `register({ onSettled })`, not via the `registry.on('settled')` event which
   * fires after registration and is therefore subject to a race.
   */
  onSettled?: (isError: boolean) => void;
  /**
   * Delegation-budget release callback. Passed directly to
   * `registry.register({ onSettled: budgetRelease })` so the registry invokes
   * it in `markTerminal()` after cleanup — guaranteeing the slot is held until
   * the job actually settles regardless of when the registry fires its
   * 'settled' event. Distinct from `onSettled` (wave-manifest) because the
   * registry's `RegisterArgs.onSettled` is `() => void`.
   */
  budgetRelease?: () => void;
  /**
   * Optional post-terminal cleanup. Forwarded to the registry so markTerminal()
   * runs it after handle.teardown(). Used by isolation:"worktree" to unlock +
   * tear down the child's worktree.
   */
  onCleanup?: () => Promise<void>;
  /** Worktree lock to release when registration fails before onCleanup owns it. */
  isolationTeardown?: { repoRoot: string; worktreePath: string };
}

/**
 * Run the background-mode branch. Returns the `ToolResult` the parent's SDK
 * tool-use loop expects before its next assistant turn.
 *
 * External constraint: the parent SDK tool-use loop expects a ToolResult per
 * ToolCall *before the next assistant turn begins*. Background mode honors that
 * contract by returning immediately with a structured pointer. The handle keeps
 * running detached; the parent's AbortGraph still owns its lifetime (parent
 * abort cascades down), and the registry's terminal-state callback captures the
 * eventual outcome for explicit `join`.
 *
 * We deliberately do NOT wire the call.signal -> handle.cancel bridge here.
 * That bridge ties the child's lifetime to the parent tool-call's signal, which
 * is exactly wrong for fire-and-forget: the tool-call signal aborts at
 * end-of-turn, and a background job is supposed to outlive the turn that
 * spawned it. Cascade on parent-session abort still works because forkSubagent
 * installs the SubagentManager root abort wiring independently.
 */
export async function runBackgroundBranch(args: RunBackgroundBranchArgs): Promise<ToolResult> {
  const { handle, registry, prompt, model, parentSessionId, onSettled, budgetRelease, onCleanup, isolationTeardown } = args;
  if (!registry) {
    // Tear down the orphaned handle so the fork isn't leaked.
    // teardown() is the safe no-op when the handle hasn't started.
    await handle.teardown().catch((e: unknown) =>
      debugLog('subagent-executor: handle teardown failed: ' + (errorMessage(e))),
    );
    // Unlock + tear down the isolated worktree — no registry means no
    // markTerminal and no onCleanup, so this is the only cleanup path.
    if (isolationTeardown) {
      await teardownBackgroundWorktree(isolationTeardown).catch((e: unknown) =>
        debugLog(`[isolation] background worktree teardown failed (no registry): ${String(e)}`));
    }
    budgetRelease?.();
    onSettled?.(true);
    return {
      content:
        'Background mode is not available in this session — no BackgroundAgentRegistry is wired. ' +
        'Re-issue the call with mode="foreground" or run inside `afk interactive`.',
      isError: true,
    };
  }
  let job: ReturnType<typeof registry.register>;
  try {
    // Item 1 fix: wire budgetRelease through register({ onSettled: budgetRelease })
    // so the registry's markTerminal() invokes it AFTER cleanup, regardless of
    // when the 'settled' event fires. Wiring through the event listener would
    // create a TOCTOU window: if the registry fires 'settled' before the listener
    // is attached (possible when the job settles synchronously), the slot leaks.
    job = registry.register({
      handle,
      prompt,
      model: model ?? 'sonnet',
      provenance: 'model',
      parentSessionId,
      onCleanup,
      ...(budgetRelease !== undefined ? { onSettled: budgetRelease } : {}),
    });
  } catch (e) {
    if (e instanceof BackgroundJobCapError) {
      // Cap exceeded — tear down the orphaned handle so the fork isn't leaked.
      await handle.teardown().catch((te: unknown) =>
        debugLog('subagent-executor: handle teardown failed after cap error: ' + (errorMessage(te))),
      );
      // Unlock + tear down the isolated worktree — cap rejection means no
      // registry entry, so markTerminal/onCleanup will never fire.
      if (isolationTeardown) {
        await teardownBackgroundWorktree(isolationTeardown).catch((te: unknown) =>
          debugLog(`[isolation] background worktree teardown failed (cap error): ${String(te)}`));
      }
      budgetRelease?.();
      onSettled?.(true);
      return {
        content: e.message,
        isError: true,
      };
    }
    // Any other registration failure: clean up the orphaned handle + worktree
    // before rethrowing. Without this, a locked worktree leaks permanently.
    await handle.teardown().catch((te: unknown) =>
      debugLog('subagent-executor: handle teardown failed after register error: ' + (errorMessage(te))),
    );
    if (isolationTeardown) {
      await teardownBackgroundWorktree(isolationTeardown).catch((te: unknown) =>
        debugLog(`[isolation] background worktree teardown failed (register error): ${String(te)}`));
    }
    budgetRelease?.();
    onSettled?.(true);
    throw e;
  }
  // Wire manifest settlement (#1083): when the background job finishes,
  // fire the captured onSettled callback so the wave manifest transitions
  // from 'running' to 'done'/'failed'. The waveId is captured at the call
  // site (subagent-executor.ts) before notifyWaveEnd() can clear it.
  // NOTE: budgetRelease is NOT included here — it is wired through
  // register({ onSettled: budgetRelease }) above (Item 1 fix). This event
  // listener is solely for the wave-manifest settlement concern, which needs
  // the isError boolean unavailable from the registry's () => void slot.
  if (onSettled) {
    const settledJobId = job.jobId;
    const handler = (settled: BackgroundJob): void => {
      if (settled.jobId !== settledJobId) return;
      registry.off('settled', handler);
      onSettled(settled.status === 'failed' || settled.status === 'cancelled');
    };
    registry.on('settled', handler);
  }

  const payload = {
    status: 'running' as const,
    jobId: job.jobId,
    subagentId: job.subagentId,
    label: job.label,
    message:
      `Background subagent started (jobId=${job.jobId}). ` +
      `It is running detached; its result will be delivered into this context ` +
      `automatically with the next user message once it finishes. ` +
      `/bgsub:join ${job.jobId} remains available for manual replay.`,
  };
  return { content: JSON.stringify(payload) };
}
