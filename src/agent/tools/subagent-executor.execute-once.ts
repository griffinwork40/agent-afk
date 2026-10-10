/**
 * `executeOnce` — single-attempt dispatch body for the `agent` tool.
 * Split out of `subagent-executor.ts` (file-size ceiling, #3481).
 *
 * All state this function needs is passed explicitly via {@link ExecuteOnceArgs}
 * so it is testable without a full `SubagentExecutor` instance.
 *
 * @module agent/tools/subagent-executor.execute-once
 */

import { SUBAGENT_BACKGROUND_TIMEOUT_MS } from '../subagent.js';
import { computeInheritedReadRoots } from '../subagent-read-scope.js';
import type { ToolCall, ToolResult } from './types.js';
import { resolveMaxNestingDepth } from './nesting.js';
import type { RegisteredAgent } from '../agents/index.js';
import { deriveOrigin, actorFromDepth, type TraceOrigin, type TraceActor } from '../session/session-identity.js';
import { parseAgentInput, type AgentInput } from './subagent/input-parse.js';
import { buildChildConfig, type BuildChildConfigArgs } from './subagent/child-config.js';
import { backgroundTarget } from './subagent/background-delivery.js';
import { runForegroundWithPromotion, type PromotionTrigger } from './subagent/foreground-promotion.js';
import type { StreamCutProbe } from '../subagent/stream-cut-retry.js';
import { addForegroundNotices } from './subagent-executor.notices.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { buildAgentMaxDepthRefusal } from './skill-depth-message.js';
import { buildBudgetRefusalMessage, type SpawnReceipt } from './delegation-budget.js';
import { evaluateDispatchUsageForModel } from './usage-notice.js';
import { WaveManifestTracker } from './subagent-executor.wave-manifest.js';
import { errorMessage } from '../../utils/errors.js';
import type { SubagentExecutorContext } from './subagent-executor/types.js';
import { SubagentExecutor } from './subagent-executor.js';
import {
  setupIsolationWorktree,
  forkAndCheckCancel,
  resolveChildPrompt,
  runBackgroundDispatch,
  checkNestedScope,
} from './subagent-executor.execute-once.helpers.js';

export interface ExecuteOnceArgs {
  ctx: SubagentExecutorContext;
  currentCwd: string | undefined;
  /** Mutable counter — incremented in place for isolation slugs. */
  isolationCounterRef: { value: number };
  waveTracker: WaveManifestTracker;
  promotionTriggers: Map<string, PromotionTrigger>;
  activeForegroundHandles: Map<string, { cancel: () => Promise<void> }>;
  /** Read LIVE after each await: a cancel during forkSubagent bumps it (#3481). */
  getCancelGeneration: () => number;
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
    promotionTriggers, activeForegroundHandles, getCancelGeneration,
    inheritedChildConfigArgs, updateCurrentWaveUnit,
  } = args;

  if (call.signal.aborted) {
    return { content: 'Agent tool call aborted', isError: true };
  }

  let parsed: AgentInput;
  try {
    parsed = parseAgentInput(call.input);
  } catch (err) {
    return { content: `Agent tool input validation failed: ${errorMessage(err)}`, isError: true };
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
    const refusal = checkNestedScope(nestedScope, parsed.agent_type);
    if (refusal !== undefined) return refusal;
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
    const isoResult = await setupIsolationWorktree({
      parsed, currentCwd, isolationCounterRef, childConfig,
      childWriteCapable, probe, budgetReceipt,
    });
    if ('error' in isoResult) { budgetReceipt = undefined; return isoResult.error; }
    if (!('skipped' in isoResult)) { isolationTeardown = isoResult.teardown; }
  }

  if (parsed.mode === 'background' && childConfig.timeoutMs === undefined) {
    childConfig.timeoutMs = SUBAGENT_BACKGROUND_TIMEOUT_MS;
  }

  // Fork subagent + cancel-between-retry check.
  const forkResult = await forkAndCheckCancel({
    ctx, parsed, childConfig, namedAgent,
    nestedAgentAllowlist: nestedAgentAllowlist as string[] | undefined,
    isolationTeardown, getCancelGeneration, retryCancelGeneration,
    budgetReceipt, childManager, identity, depth,
    updateCurrentWaveUnit, callId: call.id,
  });
  if ('forkError' in forkResult) { budgetReceipt = undefined; return forkResult.result; }
  if (forkResult.cancelled) { budgetReceipt = undefined; return forkResult.result; }
  const { handle } = forkResult;

  if (childParentSession !== undefined) {
    childParentSession.sessionId = handle.id;
    childParentSession.messageJournal = handle.session?.messageJournal;
  }
  updateCurrentWaveUnit(call.id, 'running', undefined, isolationTeardown !== undefined ? childConfig.cwd : undefined);

  if (parsed.mode === 'background') {
    return runBackgroundDispatch({
      handle, ctx, parsed, childConfig,
      waveId: waveTracker.waveId,
      callId: call.id,
      budgetRelease: budgetReceipt?.release,
      isolationTeardown,
      traceWriter: ctx.traceWriter,
    });
  }

  // Foreground: resolve prompt (expand attachments if any).
  const promptResult = await resolveChildPrompt({
    parsed, childScopeInputs, currentCwd,
    sessionId: ctx.parentSession.sessionId,
    attachmentRegistry: ctx.inboundAttachmentRegistry,
  });
  if ('error' in promptResult) {
    budgetReceipt?.release();
    budgetReceipt = undefined;
    await handle.teardown().catch(() => undefined);
    return promptResult.error!;
  }

  const budgetRelease = budgetReceipt?.release;
  const promotionTookBudget = { value: false };
  const result = await runForegroundWithPromotion({
    handle,
    signal: call.signal,
    prompt: promptResult.prompt,
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
