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

import { BackgroundJobCapError, type BackgroundAgentRegistry } from '../../background-registry.js';
import type { SubagentManager } from '../../subagent.js';
import { debugLog } from '../../../utils/debug.js';
import type { ToolResult } from '../types.js';

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
  const { handle, registry, prompt, model, parentSessionId } = args;
  if (!registry) {
    // Tear down the orphaned handle so the fork isn't leaked.
    // teardown() is the safe no-op when the handle hasn't started.
    await handle.teardown().catch((e: unknown) =>
      debugLog('subagent-executor: handle teardown failed: ' + (e instanceof Error ? e.message : String(e))),
    );
    return {
      content:
        'Background mode is not available in this session — no BackgroundAgentRegistry is wired. ' +
        'Re-issue the call with mode="foreground" or run inside `afk interactive`.',
      isError: true,
    };
  }
  let job: ReturnType<typeof registry.register>;
  try {
    job = registry.register({
      handle,
      prompt,
      model: model ?? 'sonnet',
      parentSessionId,
    });
  } catch (e) {
    if (e instanceof BackgroundJobCapError) {
      // Cap exceeded — tear down the orphaned handle so the fork isn't leaked.
      await handle.teardown().catch((te: unknown) =>
        debugLog('subagent-executor: handle teardown failed after cap error: ' + (te instanceof Error ? te.message : String(te))),
      );
      return {
        content: e.message,
        isError: true,
      };
    }
    throw e;
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
