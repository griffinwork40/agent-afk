/**
 * Named helpers extracted from `executeOnce` to satisfy the 200-line function
 * ceiling (#3481).  Every helper takes explicit parameters — no closures over
 * enclosing locals — so each is independently testable.
 *
 * @module agent/tools/subagent-executor.execute-once.helpers
 */

import { SubagentManager } from '../subagent.js';
import type { AgentInput } from './subagent/input-parse.js';
import { createIsolatedWorktree } from './handlers/worktree-managed.js';
import {
  lockWorktreeForBackground,
  teardownBackgroundWorktree,
} from './handlers/worktree-managed.background.js';
import type { StreamCutProbe } from '../subagent/stream-cut-retry.js';
import { debugLog } from '../../utils/debug.js';
import { appendImageBlocks } from '../content/image-blocks.js';
import { resolveSubagentAttachments } from './subagent/attachment-resolve.js';
import { inboundAttachmentRegistry, type InboundAttachmentReader } from '../content/attachment-registry.js';
import { emitTelemetry, truncate } from './subagent/failure-payload.js';
import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';
import { errorMessage } from '../../utils/errors.js';
import type { SpawnReceipt } from './delegation-budget.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { RegisteredAgent } from '../agents/index.js';
import type { SubagentExecutorContext } from './subagent-executor/types.js';
import type { TraceOrigin, TraceActor } from '../session/session-identity.js';
import type { AgentConfig } from '../types/config-types.js';
import type { ToolResult } from './types.js';
import { runBackgroundBranch } from './subagent/background-branch.js';
import { backgroundTarget } from './subagent/background-delivery.js';
import { withCatalogNotice } from './subagent-executor.notices.js';
import { updateWaveUnit } from '../manifest/write.js';
import type { TraceSink } from '../trace/index.js';

// ---------------------------------------------------------------------------
// Isolation-worktree setup
// ---------------------------------------------------------------------------

export interface IsolationWorktreeResult {
  /** Paths needed to tear down the worktree on completion. */
  teardown: { repoRoot: string; worktreePath: string };
}

export interface SetupIsolationWorktreeArgs {
  parsed: AgentInput;
  currentCwd: string | undefined;
  isolationCounterRef: { value: number };
  childConfig: AgentConfig;
  childWriteCapable: boolean;
  probe: StreamCutProbe | undefined;
  budgetReceipt: SpawnReceipt | undefined;
}

/**
 * Creates an isolated worktree for `isolation:"worktree"` dispatches and
 * mutates `childConfig.cwd` to point at it.  Returns the teardown descriptor
 * on success, `{ skipped: true }` when the agent is read-only, or
 * `{ error }` that the caller should return immediately.
 */
export async function setupIsolationWorktree(
  args: SetupIsolationWorktreeArgs,
): Promise<IsolationWorktreeResult | { skipped: true } | { error: ToolResult }> {
  const {
    parsed,
    currentCwd,
    isolationCounterRef,
    childConfig,
    childWriteCapable,
    budgetReceipt,
  } = args;

  if (!childWriteCapable) {
    debugLog(
      `[isolation] skipped worktree for read-only ${parsed.agent_type ?? 'generic'}`,
    );
    return { skipped: true };
  }

  const anchorCwd = currentCwd ?? process.cwd();
  try {
    const iso = await createIsolatedWorktree({
      cwd: anchorCwd,
      slugHint: `iso-${parsed.id_prefix}-${++isolationCounterRef.value}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    });
    childConfig.cwd = iso.path;
    const teardown = { repoRoot: iso.repoRoot, worktreePath: iso.path };
    if (parsed.mode === 'background') {
      await lockWorktreeForBackground(iso.repoRoot, iso.path);
    }
    return { teardown };
  } catch (err) {
    const message = errorMessage(err);
    budgetReceipt?.rollback();
    return {
      error: {
        content:
          `Failed to create isolated worktree for the subagent: ${message}. ` +
          `isolation:"worktree" requires the dispatching session to run inside a git repository.`,
        isError: true,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Fork + cancel-between-retry check
// ---------------------------------------------------------------------------

export interface ForkAndCheckCancelArgs {
  ctx: SubagentExecutorContext;
  parsed: AgentInput;
  childConfig: AgentConfig;
  namedAgent: RegisteredAgent | undefined;
  /** From buildChildConfig — the allowlist scoped to this child. */
  nestedAgentAllowlist: string[] | undefined;
  isolationTeardown: { repoRoot: string; worktreePath: string } | undefined;
  /** Getter, not a snapshot: must be read after the forkSubagent await. */
  getCancelGeneration: () => number;
  retryCancelGeneration: number | undefined;
  budgetReceipt: SpawnReceipt | undefined;
  childManager: { teardownAll: () => Promise<void> } | undefined;
  identity: { origin?: TraceOrigin; actor?: TraceActor };
  depth: number;
  updateCurrentWaveUnit: (
    callId: string,
    status: 'running' | 'done' | 'failed',
    error?: string,
    cwd?: string,
  ) => void;
  callId: string;
}

export type ForkResult =
  | { handle: Awaited<ReturnType<SubagentManager['forkSubagent']>>; cancelled: false }
  | { cancelled: true; result: ToolResult }
  | { forkError: true; result: ToolResult };

/**
 * Forks the subagent and immediately checks whether a cancel-between-retry
 * signal arrived while the fork was in flight.  Returns the live handle, a
 * cancellation sentinel, or a fork-error sentinel.
 */
export async function forkAndCheckCancel(
  args: ForkAndCheckCancelArgs,
): Promise<ForkResult> {
  const {
    ctx,
    parsed,
    childConfig,
    namedAgent,
    nestedAgentAllowlist,
    isolationTeardown,
    getCancelGeneration,
    retryCancelGeneration,
    budgetReceipt,
    childManager,
    identity,
    depth,
    updateCurrentWaveUnit,
    callId,
  } = args;

  let handle: Awaited<ReturnType<SubagentManager['forkSubagent']>>;
  try {
    handle = await ctx.subagentManager.forkSubagent({
      parent: ctx.parentSession,
      parentId: callId,
      config: childConfig,
      idPrefix: parsed.id_prefix,
      agentType:
        namedAgent !== undefined
          ? namedAgent.name
          : parsed.id_prefix && parsed.id_prefix !== 'agent-tool'
          ? stripEscapeSequences(parsed.id_prefix)
              .replace(/[\r\n]+/g, ' ')
              .trim() || 'agent'
          : stripEscapeSequences(parsed.prompt)
              .replace(/[\r\n]+/g, ' ')
              .slice(0, 40)
              .trim() || 'agent',
      ...(namedAgent !== undefined ? { resolvedAgentType: namedAgent.name } : {}),
      promptHead: stripEscapeSequences(parsed.prompt)
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 80)
        .trim(),
      denyElicitations: true,
      progressEvents: parsed.progress_events,
      ...(nestedAgentAllowlist !== undefined ? { nestedAgentAllowlist } : {}),
    });
  } catch (err) {
    const message = errorMessage(err);
    budgetReceipt?.rollback();
    updateCurrentWaveUnit(callId, 'failed', message);
    void emitTelemetry({
      ...identity,
      event: 'subagent.failed',
      subagent_id: 'unknown',
      id_prefix: parsed.id_prefix,
      parent_session_id: ctx.parentSession.sessionId,
      status: 'failed',
      error_message: truncate(message),
      depth,
    });
    if (isolationTeardown && parsed.mode === 'background') {
      await teardownBackgroundWorktree(isolationTeardown).catch((e: unknown) =>
        debugLog(
          `[isolation] background worktree teardown failed after fork error: ${String(e)}`,
        ),
      );
    }
    return { forkError: true, result: { content: `Failed to fork subagent: ${message}`, isError: true } };
  }

  // Check for cancel that arrived while fork was in flight.
  if (retryCancelGeneration !== undefined && getCancelGeneration() !== retryCancelGeneration) {
    await childManager?.teardownAll();
    await handle.cancel();
    budgetReceipt?.rollback();
    if (isolationTeardown && parsed.mode === 'background') {
      await teardownBackgroundWorktree(isolationTeardown).catch((e: unknown) =>
        debugLog(
          `[isolation] background worktree teardown failed after cancel: ${String(e)}`,
        ),
      );
    }
    return { cancelled: true, result: { content: 'Agent tool call aborted', isError: true } };
  }

  return { handle, cancelled: false };
}

// ---------------------------------------------------------------------------
// Foreground prompt / attachment resolution
// ---------------------------------------------------------------------------

export interface ResolveChildPromptArgs {
  parsed: AgentInput;
  childScopeInputs: {
    parentReadRoots: string[] | undefined;
    parentCwd: string | undefined;
  };
  currentCwd: string | undefined;
  sessionId: string | undefined;
  attachmentRegistry?: InboundAttachmentReader;
}

export type ResolveChildPromptResult =
  | { prompt: string | ContentBlockParam[]; error?: never }
  | { error: ToolResult; prompt?: never };

/**
 * Resolves the foreground child prompt, expanding any declared attachment
 * paths into inline image blocks.  Returns the resolved prompt or a
 * `ToolResult` error the caller should return immediately.
 */
export async function resolveChildPrompt(
  args: ResolveChildPromptArgs,
): Promise<ResolveChildPromptResult> {
  const { parsed, childScopeInputs, currentCwd, sessionId, attachmentRegistry } = args;

  if (parsed.attachments === undefined) {
    return { prompt: parsed.prompt };
  }

  try {
    const attachments = await resolveSubagentAttachments({
      paths: parsed.attachments,
      resolveBase:
        childScopeInputs.parentCwd ?? currentCwd ?? childScopeInputs.parentReadRoots?.[0],
      readRoots: childScopeInputs.parentReadRoots,
      sessionId,
      registry: attachmentRegistry ?? inboundAttachmentRegistry,
    });
    const blocks: ContentBlockParam[] = [{ type: 'text', text: parsed.prompt }];
    appendImageBlocks(blocks, attachments);
    return { prompt: blocks };
  } catch (err) {
    return {
      error: {
        content: `Agent tool attachment resolution failed: ${errorMessage(err)}`,
        isError: true,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Background dispatch
// ---------------------------------------------------------------------------

export interface RunBackgroundDispatchArgs {
  handle: Awaited<ReturnType<SubagentManager['forkSubagent']>>;
  ctx: SubagentExecutorContext;
  parsed: AgentInput;
  childConfig: AgentConfig;
  waveId: string | undefined;
  callId: string;
  budgetRelease: (() => void) | undefined;
  isolationTeardown: { repoRoot: string; worktreePath: string } | undefined;
  traceWriter: TraceSink | undefined;
}

/**
 * Dispatches the subagent in background mode and returns the immediate
 * ToolResult.  Wires the wave-unit settlement callback and the optional
 * background-worktree teardown.
 */
export function runBackgroundDispatch(args: RunBackgroundDispatchArgs): Promise<ToolResult> {
  const {
    handle, ctx, parsed, childConfig,
    waveId, callId, budgetRelease, isolationTeardown, traceWriter,
  } = args;

  return withCatalogNotice(
    runBackgroundBranch({
      handle,
      ...backgroundTarget(ctx),
      prompt: parsed.prompt,
      model: childConfig.model,
      parentSessionId: ctx.parentSession.sessionId,
      onSettled: waveId !== undefined
        ? (isError) => { updateWaveUnit(waveId, callId, isError ? 'failed' : 'done'); }
        : undefined,
      budgetRelease,
      onCleanup: isolationTeardown
        ? async () => {
            const result = await teardownBackgroundWorktree(isolationTeardown);
            debugLog(`background worktree teardown: ${JSON.stringify(result)}`);
          }
        : undefined,
      isolationTeardown,
    }),
    childConfig.model,
    traceWriter,
  );
}

// ---------------------------------------------------------------------------
// Nested-dispatch scope gate
// ---------------------------------------------------------------------------

/**
 * Returns a `ToolResult` refusal when `requestedType` is outside the
 * `nestedScope` allowlist, or `undefined` when the dispatch is permitted.
 */
export function checkNestedScope(
  nestedScope: readonly string[],
  requestedType: string | undefined,
): ToolResult | undefined {
  if (requestedType !== undefined && nestedScope.includes(requestedType)) {
    return undefined; // permitted
  }
  return {
    content:
      nestedScope.length === 0
        ? 'This agent is not permitted to dispatch any nested agents ' +
          '(its definition granted the dispatch tool but named zero allowed ' +
          'types, e.g. `Agent()`). Complete the task with your own tools.'
        : `This agent may only dispatch the following agent type(s): ${nestedScope.join(', ')}. ` +
          (requestedType === undefined
            ? 'A bare dispatch with no agent_type is not permitted here — ' +
              'set agent_type to one of the allowed types, or complete the task with your own tools.'
            : `agent_type "${requestedType}" is out of scope.`),
    isError: true,
  };
}
