/**
 * `executeOnce` — single-attempt dispatch body for the `agent` tool.
 * Split out of `subagent-executor.ts` (file-size ceiling, #3481).
 *
 * All state this function needs is passed explicitly via {@link ExecuteOnceArgs}
 * so it is testable without a full `SubagentExecutor` instance.
 *
 * @module agent/tools/subagent-executor.execute-once
 */

import { SubagentManager, SUBAGENT_BACKGROUND_TIMEOUT_MS } from '../subagent.js';
import { computeInheritedReadRoots } from '../subagent-read-scope.js';
import type { ToolCall, ToolResult } from './types.js';
import { resolveMaxNestingDepth } from './nesting.js';
import type { RegisteredAgent } from '../agents/index.js';
import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';
import { deriveOrigin, actorFromDepth, type TraceOrigin, type TraceActor } from '../session/session-identity.js';
import { parseAgentInput, type AgentInput } from './subagent/input-parse.js';
import { emitTelemetry, truncate } from './subagent/failure-payload.js';
import { buildChildConfig, type BuildChildConfigArgs } from './subagent/child-config.js';
import { runBackgroundBranch } from './subagent/background-branch.js';
import { backgroundTarget } from './subagent/background-delivery.js';
import { runForegroundWithPromotion, type PromotionTrigger } from './subagent/foreground-promotion.js';
import { createIsolatedWorktree } from './handlers/worktree-managed.js';
import { lockWorktreeForBackground, teardownBackgroundWorktree } from './handlers/worktree-managed.background.js';
import type { StreamCutProbe } from '../subagent/stream-cut-retry.js';
import { debugLog } from '../../utils/debug.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { appendImageBlocks } from '../content/image-blocks.js';
import { addForegroundNotices, withCatalogNotice } from './subagent-executor.notices.js';
import { resolveSubagentAttachments } from './subagent/attachment-resolve.js';
import { inboundAttachmentRegistry } from '../content/attachment-registry.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { buildAgentMaxDepthRefusal } from './skill-depth-message.js';
import { buildBudgetRefusalMessage, type SpawnReceipt } from './delegation-budget.js';
import { evaluateDispatchUsageForModel } from './usage-notice.js';
import { updateWaveUnit } from '../manifest/write.js';
import { WaveManifestTracker } from './subagent-executor.wave-manifest.js';
import { errorMessage } from '../../utils/errors.js';
import type { SubagentExecutorContext } from './subagent-executor/types.js';
import { SubagentExecutor } from './subagent-executor.js';

export interface ExecuteOnceArgs {
  ctx: SubagentExecutorContext;
  currentCwd: string | undefined;
  /** Mutable counter — incremented in place for isolation slugs. */
  isolationCounterRef: { value: number };
  waveTracker: WaveManifestTracker;
  promotionTriggers: Map<string, PromotionTrigger>;
  activeForegroundHandles: Map<string, { cancel: () => Promise<void> }>;
  cancelGeneration: number;
  inheritedChildConfigArgs: () => Partial<BuildChildConfigArgs>;
  updateCurrentWaveUnit: (
    callId: string,
    status: 'running' | 'done' | 'failed',
    error?: string,
    cwd?: string,
  ) => void;
}

export async function executeOnce(
  call: ToolCall,
  args: ExecuteOnceArgs,
  probe?: StreamCutProbe,
  retryCancelGeneration?: number,
): Promise<ToolResult> {
  const {
    ctx, currentCwd, isolationCounterRef, waveTracker,
    promotionTriggers, activeForegroundHandles, cancelGeneration,
    inheritedChildConfigArgs, updateCurrentWaveUnit,
  } = args;

  if (call.signal.aborted) {
    return { content: 'Agent tool call aborted', isError: true };
  }

  let parsed: AgentInput;
  try {
    parsed = parseAgentInput(call.input);
  } catch (err) {
    const message = errorMessage(err);
    return { content: `Agent tool input validation failed: ${message}`, isError: true };
  }

  // Named-agent resolution. A miss fails fast with the available list.
  let namedAgent: RegisteredAgent | undefined;
  if (parsed.agent_type !== undefined) {
    namedAgent = ctx.agentRegistry?.get(parsed.agent_type);
    if (namedAgent === undefined) {
      const available = [...(ctx.agentRegistry?.keys() ?? [])].sort().join(', ');
      return {
        content:
          `Agent type "${parsed.agent_type}" not found. ` +
          `Available agent types: ${available.length > 0 ? available : '(none)'}`,
        isError: true,
      };
    }
  }

  // Nested-dispatch scope gate.
  const nestedScope = ctx.nestedAgentAllowlist;
  if (nestedScope !== undefined) {
    const requested = parsed.agent_type;
    if (requested === undefined || !nestedScope.includes(requested)) {
      return {
        content:
          nestedScope.length === 0
            ? 'This agent is not permitted to dispatch any nested agents ' +
              '(its definition granted the dispatch tool but named zero allowed ' +
              'types, e.g. `Agent()`). Complete the task with your own tools.'
            : `This agent may only dispatch the following agent type(s): ${nestedScope.join(', ')}. ` +
              (requested === undefined
                ? 'A bare dispatch with no agent_type is not permitted here — ' +
                  'set agent_type to one of the allowed types, or complete the task with your own tools.'
                : `agent_type "${requested}" is out of scope.`),
        isError: true,
      };
    }
  }

  // Invariant: `ctx.depth` is required — top-level callers pass explicit `0`.
  const depth = ctx.depth;
  const maxDepth = ctx.maxDepth ?? resolveMaxNestingDepth();

  const identity: { origin?: TraceOrigin; actor?: TraceActor } =
    ctx.surface !== undefined
      ? { origin: deriveOrigin(ctx.surface), actor: actorFromDepth(depth) }
      : {};

  if (depth >= maxDepth) {
    void appendRoutingDecision({
      ...identity,
      event: 'delegation.skipped',
      parent_session_id: ctx.parentSession.sessionId,
      reason: 'max_depth',
      depth,
      ...(parsed.agent_type !== undefined ? { requested_name: parsed.agent_type } : {}),
    }).catch(() => {});
    return { content: buildAgentMaxDepthRefusal(depth, maxDepth), isError: true };
  }

  // Delegation budget.
  let budgetReceipt: SpawnReceipt | undefined;
  if (ctx.delegationBudget) {
    const check = ctx.delegationBudget.canSpawn(ctx.parentSession.sessionId ?? '');
    if (!check.allowed) {
      void appendRoutingDecision({ ...identity, event: 'delegation.skipped', parent_session_id: ctx.parentSession.sessionId, reason: check.reason ?? 'budget', depth, ...(parsed.agent_type !== undefined ? { requested_name: parsed.agent_type } : {}) }).catch(() => {});
      return { content: buildBudgetRefusalMessage(check), isError: true };
    }
    budgetReceipt = ctx.delegationBudget.recordSpawn(ctx.parentSession.sessionId ?? '');
  }

  const usageNotice = await evaluateDispatchUsageForModel(ctx.parentModel, ctx.traceWriter);

  const childScopeInputs = ctx.subagentManager.getReadScopeInputs?.() ?? {
    parentReadRoots: undefined,
    parentCwd: undefined,
  };
  const childInheritedReadRoots = computeInheritedReadRoots({
    parentReadRoots: childScopeInputs.parentReadRoots,
    parentCwd: childScopeInputs.parentCwd,
    childCwd: parsed.cwd ?? currentCwd,
  });

  const { childConfig, childParentSession, childManager, childWriteCapable, childSideEffectFree, nestedAgentAllowlist } = buildChildConfig({
    parsed,
    namedAgent,
    depth,
    maxDepth,
    currentCwd,
    ...(childInheritedReadRoots !== undefined ? { childInheritedReadRoots } : {}),
    signal: call.signal,
    defaultConfig: ctx.defaultConfig,
    ...(ctx.resolveApiKeyForModel !== undefined ? { resolveApiKeyForModel: ctx.resolveApiKeyForModel } : {}),
    defaultSubagentModel: ctx.defaultSubagentModel,
    ...(ctx.childProviderFactory !== undefined ? { childProviderFactory: ctx.childProviderFactory } : {}),
    ...(ctx.childSkillExecutorFactory !== undefined ? { childSkillExecutorFactory: ctx.childSkillExecutorFactory } : {}),
    ...inheritedChildConfigArgs(),
    createChildExecutor: (childCtx) => new SubagentExecutor(childCtx),
  });

  if (probe !== undefined) probe.sideEffectFree = childSideEffectFree;

  // isolation:"worktree"
  let isolationTeardown: { repoRoot: string; worktreePath: string } | undefined;
  if (parsed.isolation === 'worktree') {
    if (!childWriteCapable) {
      debugLog(`[isolation] skipped worktree for read-only ${parsed.agent_type ?? 'generic'}`);
    } else {
      const anchorCwd = currentCwd ?? process.cwd();
      try {
        const iso = await createIsolatedWorktree({
          cwd: anchorCwd,
          slugHint: `iso-${parsed.id_prefix}-${++isolationCounterRef.value}-${Math.random().toString(36).slice(2, 8)}`,
        });
        childConfig.cwd = iso.path;
        isolationTeardown = { repoRoot: iso.repoRoot, worktreePath: iso.path };
        if (parsed.mode === 'background') await lockWorktreeForBackground(iso.repoRoot, iso.path);
      } catch (err) {
        const message = errorMessage(err);
        budgetReceipt?.rollback();
        budgetReceipt = undefined;
        return {
          content:
            `Failed to create isolated worktree for the subagent: ${message}. ` +
            `isolation:"worktree" requires the dispatching session to run inside a git repository.`,
          isError: true,
        };
      }
    }
  }

  if (parsed.mode === 'background' && childConfig.timeoutMs === undefined) {
    childConfig.timeoutMs = SUBAGENT_BACKGROUND_TIMEOUT_MS;
  }

  let handle: Awaited<ReturnType<SubagentManager['forkSubagent']>>;
  try {
    handle = await ctx.subagentManager.forkSubagent({
      parent: ctx.parentSession,
      parentId: call.id,
      config: childConfig,
      idPrefix: parsed.id_prefix,
      agentType: namedAgent !== undefined
        ? namedAgent.name
        : (parsed.id_prefix && parsed.id_prefix !== 'agent-tool')
          ? stripEscapeSequences(parsed.id_prefix).replace(/[\r\n]+/g, ' ').trim() || 'agent'
          : stripEscapeSequences(parsed.prompt).replace(/[\r\n]+/g, ' ').slice(0, 40).trim() || 'agent',
      ...(namedAgent !== undefined ? { resolvedAgentType: namedAgent.name } : {}),
      promptHead: stripEscapeSequences(parsed.prompt).replace(/[\r\n]+/g, ' ').slice(0, 80).trim(),
      denyElicitations: true, progressEvents: parsed.progress_events, ...(nestedAgentAllowlist !== undefined ? { nestedAgentAllowlist } : {}),
    });
    if (childParentSession !== undefined) {
      childParentSession.sessionId = handle.id; childParentSession.messageJournal = handle.session?.messageJournal;
    }
    updateCurrentWaveUnit(call.id, 'running', undefined, isolationTeardown !== undefined ? childConfig.cwd : undefined);
    if (retryCancelGeneration !== undefined && cancelGeneration !== retryCancelGeneration) {
      await childManager?.teardownAll();
      await handle.cancel();
      budgetReceipt?.rollback();
      budgetReceipt = undefined;
      if (isolationTeardown && parsed.mode === 'background') {
        await teardownBackgroundWorktree(isolationTeardown).catch((e: unknown) =>
          debugLog(`[isolation] background worktree teardown failed after cancel: ${String(e)}`));
      }
      return { content: 'Agent tool call aborted', isError: true };
    }
  } catch (err) {
    const message = errorMessage(err);
    budgetReceipt?.rollback();
    budgetReceipt = undefined;
    updateCurrentWaveUnit(call.id, 'failed', message);
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
        debugLog(`[isolation] background worktree teardown failed after fork error: ${String(e)}`));
    }
    return { content: `Failed to fork subagent: ${message}`, isError: true };
  }

  if (parsed.mode === 'background') {
    const capturedWaveId = waveTracker.waveId;
    const capturedCallId = call.id;
    return withCatalogNotice(runBackgroundBranch({
      handle,
      ...backgroundTarget(ctx),
      prompt: parsed.prompt,
      model: childConfig.model,
      parentSessionId: ctx.parentSession.sessionId,
      onSettled: capturedWaveId !== undefined
        ? (isError) => { updateWaveUnit(capturedWaveId, capturedCallId, isError ? 'failed' : 'done'); }
        : undefined,
      budgetRelease: budgetReceipt?.release,
      onCleanup: isolationTeardown
        ? async () => {
            const result = await teardownBackgroundWorktree(isolationTeardown);
            debugLog(`background worktree teardown: ${JSON.stringify(result)}`);
          } : undefined,
      isolationTeardown,
    }), childConfig.model, ctx.traceWriter);
  }

  let childPrompt: string | ContentBlockParam[] = parsed.prompt;
  if (parsed.attachments !== undefined) {
    let attachments;
    try {
      attachments = await resolveSubagentAttachments({
        paths: parsed.attachments,
        resolveBase: childScopeInputs.parentCwd ?? currentCwd ?? childScopeInputs.parentReadRoots?.[0],
        readRoots: childScopeInputs.parentReadRoots,
        sessionId: ctx.parentSession.sessionId,
        registry: ctx.inboundAttachmentRegistry ?? inboundAttachmentRegistry,
      });
    } catch (err) {
      budgetReceipt?.release();
      budgetReceipt = undefined;
      await handle.teardown().catch(() => undefined);
      return { content: `Agent tool attachment resolution failed: ${errorMessage(err)}`, isError: true };
    }
    const blocks: ContentBlockParam[] = [{ type: 'text', text: parsed.prompt }];
    appendImageBlocks(blocks, attachments);
    childPrompt = blocks;
  }

  const budgetRelease = budgetReceipt?.release;
  const promotionTookBudget = { value: false };
  const result = await runForegroundWithPromotion({
    handle,
    signal: call.signal,
    prompt: childPrompt,
    backgroundPrompt: parsed.prompt,
    idPrefix: parsed.id_prefix,
    model: childConfig.model,
    ...(ctx.parentModel !== undefined ? { parentModel: ctx.parentModel } : {}),
    childManager,
    identity,
    ...(ctx.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
    depth,
    parentSessionId: ctx.parentSession.sessionId,
    ...backgroundTarget(ctx),
    promotionTriggers,
    activeForegroundHandles,
    ...(isolationTeardown !== undefined ? { isolationTeardown } : {}),
    ...(budgetRelease !== undefined ? { budgetRelease, promotionTookBudget } : {}),
  });
  if (!promotionTookBudget.value) budgetRelease?.();
  addForegroundNotices(result, childConfig.model, parsed.attachments !== undefined, namedAgent?.name, parsed.prompt, childWriteCapable, usageNotice, ctx.traceWriter);
  if (result.isError === true) {
    updateCurrentWaveUnit(call.id, 'failed', typeof result.content === 'string' ? result.content.slice(0, 500) : undefined);
  } else {
    updateCurrentWaveUnit(call.id, 'done');
  }
  return result;
}
