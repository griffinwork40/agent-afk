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
import type { ToolCall, ToolResult } from './types.js';
import { resolveMaxNestingDepth } from './nesting.js';
import { resolveNamedAgent } from './subagent-executor.execute-once.gates.js';
import { deriveOrigin, actorFromDepth, type TraceOrigin, type TraceActor } from '../session/session-identity.js';
import { buildChildConfigWithoutNesting, completeChildConfigNesting, type BuildChildConfigArgs } from './subagent/child-config.js';
import { backgroundTarget } from './subagent/background-delivery.js';
import { runForegroundWithPromotion, type PromotionTrigger } from './subagent/foreground-promotion.js';
import type { StreamCutProbe } from '../subagent/stream-cut-retry.js';
import { addForegroundNotices } from './subagent-executor.notices.js';
import { classifyDispatchIntent, checkReadOnlyDispatchIntent } from './subagent-executor.dispatch-intent.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { buildAgentMaxDepthRefusal } from './skill-depth-message.js';
import { buildBudgetRefusalMessage, type SpawnReceipt } from './delegation-budget.js';
import { evaluateDispatchUsageForModel, type DispatchUsageResult } from './usage-notice.js';
import type { TraceSink } from '../trace/index.js';
import { WaveManifestTracker } from './subagent-executor.wave-manifest.js';
import type { SubagentExecutorContext } from './subagent-executor/types.js';
import { SubagentExecutor } from './subagent-executor.js';
import { prependSetupNotice } from '../worktree/worktree-setup.js';
import { prependNeedsInputHeader } from './subagent/foreground-handoff.js';
import { parseDispatchInput, wireDispatchChain, annotateChainResult, markChainPromoted } from './subagent/continuation-dispatch.js';
import { runContinuation, type ContinuationPlan } from './subagent/continuation-run.js';
import {
  setupIsolationWorktree,
  forkAndCheckCancel,
  resolveChildPrompt,
  runBackgroundDispatch,
  checkNestedScope,
  checkAndRunRemoteDispatch,
} from './subagent-executor.execute-once.helpers.js';
import { resolveChildInheritedReadRoots } from './subagent-executor.execute-once.read-scope.js';

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

/**
 * Evaluate usage and build a refusal when the subscription is over limit.
 * Returns the notice string for healthy dispatches, or a ToolResult refusal
 * that the caller returns immediately to block the dispatch.
 */
async function usageGate(
  model: unknown,
  traceWriter: TraceSink | undefined,
  budgetReceipt: SpawnReceipt | undefined,
): Promise<{ notice: string | undefined; refusal?: ToolResult }> {
  const { notice, blocked }: DispatchUsageResult = await evaluateDispatchUsageForModel(model, traceWriter);
  if (!blocked) return { notice };
  budgetReceipt?.rollback();
  return {
    notice,
    refusal: {
      content: `Subagent dispatch refused: usage limit exceeded. ${notice ?? 'The subscription quota is exhausted.'}` +
        `\n\nReduce parallel dispatches, wait for the quota window to reset, or switch to a non-Claude model.`,
      isError: true,
    },
  };
}

export async function executeOnce(
  call: ToolCall,
  args: ExecuteOnceArgs,
  probe?: StreamCutProbe,
  retryCancelGeneration?: number,
  plan?: ContinuationPlan,
): Promise<ToolResult> {
  const {
    ctx, currentCwd, isolationCounterRef, waveTracker,
    promotionTriggers, activeForegroundHandles, getCancelGeneration,
    inheritedChildConfigArgs, updateCurrentWaveUnit,
  } = args;

  if (call.signal.aborted) {
    return { content: 'Agent tool call aborted', isError: true };
  }

  const parsedOrError = parseDispatchInput(call.input);
  if ('error' in parsedOrError) return parsedOrError.error;
  const { parsed } = parsedOrError;
  if (parsed.continuation_chain_id !== undefined && plan === undefined) return runContinuation(call, parsed, ctx, (c, p) => executeOnce(c, args, undefined, retryCancelGeneration, p)); // D8: admit + seed, then this path; no probe => never stream-cut re-dispatched

  const named = resolveNamedAgent(ctx, parsed.agent_type); // a miss fails fast with the available list
  if ('error' in named) return named.error;
  const { namedAgent } = named;

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
  { const r = await checkAndRunRemoteDispatch(parsed, call.signal, budgetReceipt, call.id, updateCurrentWaveUnit); if (r !== undefined) return r; }

  // Resolve child read-scope from the parent manager. See resolveChildInheritedReadRoots
  // in the helpers module for the full collapse-caveat documentation (#4438, #4472).
  const { childScopeInputs, childInheritedReadRoots } = resolveChildInheritedReadRoots(
    ctx.subagentManager.getReadScopeInputs?.bind(ctx.subagentManager),
  );

  // Phase 1: build base config (model, tools, budgets, credential) without
  // nesting wiring. Nesting is deferred until after isolation setup so depth-2+
  // forks inherit the worktree cwd, not the pre-isolation parent cwd (#4374).
  const childConfigArgs: BuildChildConfigArgs = {
    parsed, namedAgent, depth, maxDepth, currentCwd,
    ...(childInheritedReadRoots !== undefined ? { childInheritedReadRoots } : {}),
    signal: call.signal, defaultConfig: ctx.defaultConfig, defaultSubagentModel: ctx.defaultSubagentModel,
    ...inheritedChildConfigArgs(), createChildExecutor: (childCtx) => new SubagentExecutor(childCtx),
  };
  const preNesting = buildChildConfigWithoutNesting(childConfigArgs);
  const { childConfig, childWriteCapable, childSideEffectFree } = preNesting;

  // Usage gate runs AFTER child model is resolved so the gate checks the child
  // model (not the parent). This lets an explicitly-requested non-Claude child
  // dispatch even when the Claude parent quota is exhausted. (#4475)
  const { notice: usageNotice, refusal: usageRefusal } = await usageGate(childConfig.model, ctx.traceWriter, budgetReceipt);
  if (usageRefusal !== undefined) return usageRefusal;

  if (probe !== undefined) probe.sideEffectFree = childSideEffectFree;

  // Pre-dispatch implementation-intent gate (#3754): rejects implementation briefs sent to read-only named agents.
  { const r = checkReadOnlyDispatchIntent(childWriteCapable, namedAgent, parsed.prompt, classifyDispatchIntent); if (r !== undefined) { budgetReceipt?.rollback(); return r; } }

  // isolation:"worktree" — may mutate childConfig.cwd to the worktree path.
  let isolationTeardown: { repoRoot: string; worktreePath: string } | undefined;
  let setupNotice: string | undefined; // #3601: failed repo-declared setup, surfaced to the parent too
  if (parsed.isolation === 'worktree') {
    const isoResult = await setupIsolationWorktree({
      parsed, currentCwd, isolationCounterRef, childConfig,
      childWriteCapable, probe, budgetReceipt, signal: call.signal,
    });
    if ('error' in isoResult) { budgetReceipt = undefined; return isoResult.error; }
    if (!('skipped' in isoResult)) { isolationTeardown = isoResult.teardown; setupNotice = isoResult.setupNotice; }
  }

  // Phase 2: wire depth-2+ nesting with the RESOLVED cwd. For worktree-
  // isolated dispatches this is the worktree path (set by setupIsolationWorktree
  // above); for explicit-cwd dispatches it is parsed.cwd; otherwise the
  // executor's own cwd. (#4374)
  const nestingCwd = isolationTeardown !== undefined ? (childConfig.cwd ?? currentCwd) : (parsed.cwd ?? currentCwd);
  const { childParentSession, childManager, nestedAgentAllowlist, modelFallback } = completeChildConfigNesting(
    childConfigArgs, preNesting, nestingCwd,
  );

  if (parsed.mode === 'background' && childConfig.timeoutMs === undefined) {
    childConfig.timeoutMs = SUBAGENT_BACKGROUND_TIMEOUT_MS;
  }

  // Fork subagent + cancel-between-retry check.
  const forkResult = await forkAndCheckCancel({
    ctx, parsed, childConfig, namedAgent,
    nestedAgentAllowlist: nestedAgentAllowlist as string[] | undefined,
    isolationTeardown, getCancelGeneration, retryCancelGeneration,
    budgetReceipt, childManager, identity, depth,
    updateCurrentWaveUnit, callId: call.id, modelFallback, continuation: plan?.fork,
  });
  if ('forkError' in forkResult) { budgetReceipt = undefined; return forkResult.result; }
  if (forkResult.cancelled) { budgetReceipt = undefined; return forkResult.result; }
  const { handle } = forkResult;

  if (childParentSession !== undefined) {
    childParentSession.sessionId = handle.id;
    childParentSession.messageJournal = handle.session?.messageJournal;
  }
  updateCurrentWaveUnit(call.id, 'running', undefined, isolationTeardown !== undefined ? childConfig.cwd : undefined);
  const chain = wireDispatchChain({ ctx, parsed, handle, childConfig, currentCwd, writeCapable: childWriteCapable, plan }); // D2 mint (or reuse the continued chain) + D9 terminal hooks

  if (parsed.mode === 'background') {
    return prependSetupNotice(setupNotice, await runBackgroundDispatch({
      handle, ctx, parsed, childConfig,
      waveId: waveTracker.waveId,
      callId: call.id,
      budgetRelease: budgetReceipt?.release,
      isolationTeardown,
      traceWriter: ctx.traceWriter,
    }));
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
    onPromoted: () => markChainPromoted(handle),
  });
  if (!promotionTookBudget.value) budgetRelease?.();
  annotateChainResult(result, chain, plan !== undefined, handle); // D6: chain metadata + line on capped/continuation results (structured only on a promotion payload)
  prependNeedsInputHeader(result); // F-C1: must run AFTER annotateChainResult stamps result.continuation
  addForegroundNotices(result, childConfig.model, parsed.attachments !== undefined, namedAgent?.name, parsed.prompt, childWriteCapable, usageNotice, ctx.traceWriter);
  prependSetupNotice(setupNotice, result);
  if (result.isError === true) {
    updateCurrentWaveUnit(call.id, 'failed', typeof result.content === 'string' ? result.content.slice(0, 500) : undefined);
  } else {
    updateCurrentWaveUnit(call.id, 'done');
  }
  return result;
}
