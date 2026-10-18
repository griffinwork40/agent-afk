/**
 * Named helpers for the foreground run and default-tier model fallback inside
 * `executeOnce`. Extracted to keep `executeOnce` under the 200-line function
 * ceiling. Every input is an explicit parameter — no closures over the
 * caller's locals — so these helpers are independently testable.
 *
 * @module agent/tools/subagent-executor.execute-once.fallback
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { ChildModelSource } from '../subagent/resolve-child-model.js';
import { attemptModelFallback } from '../subagent/model-fallback.js';
import { runForegroundWithPromotion, type PromotionTrigger } from './subagent/foreground-promotion.js';
import { backgroundTarget } from './subagent/background-delivery.js';
import type { ToolResult } from './types.js';
import type { AgentConfig } from '../types/config-types.js';
import type { SubagentExecutorContext } from './subagent-executor/types.js';
import type { RegisteredAgent } from '../agents/index.js';
import type { SubagentManager } from '../subagent.js';
import type { TraceOrigin, TraceActor } from '../session/session-identity.js';
import type { ToolCall } from './types.js';
import type { ChildParentSession } from './subagent/child-config.js';

// ---------------------------------------------------------------------------
// Shared args shape for both helpers.
// ---------------------------------------------------------------------------

interface ForegroundRunSharedArgs {
  ctx: SubagentExecutorContext;
  call: ToolCall;
  childConfig: AgentConfig;
  childManager: SubagentManager | undefined;
  childParentSession: ChildParentSession | undefined;
  namedAgent: RegisteredAgent | undefined;
  prompt: string | ContentBlockParam[];
  backgroundPrompt: string;
  idPrefix: string | undefined;
  depth: number;
  identity: { origin?: TraceOrigin; actor?: TraceActor };
  promotionTriggers: Map<string, PromotionTrigger>;
  activeForegroundHandles: Map<string, { cancel: () => Promise<void> }>;
  isolationTeardown: { repoRoot: string; worktreePath: string } | undefined;
}

// ---------------------------------------------------------------------------
// runForegroundWithFallback
// ---------------------------------------------------------------------------

export interface RunForegroundWithFallbackArgs extends ForegroundRunSharedArgs {
  handle: Awaited<ReturnType<SubagentManager['forkSubagent']>>;
  childModelSource: ChildModelSource;
  budgetRelease: (() => void) | undefined;
}

/**
 * Run the primary foreground promotion then, if it fails with a default-tier
 * model rejection, retry once on the parent model.
 *
 * Contract:
 *   1. Runs `runForegroundWithPromotion` on `handle` and releases
 *      `budgetRelease` when promotion did not consume it.
 *   2. On error + eligible-source, delegates to `runFallbackForeground` which
 *      forks a fresh handle on the parent model and re-runs.
 *   3. Returns the final ToolResult (primary or fallback).
 */
export async function runForegroundWithFallback(
  args: RunForegroundWithFallbackArgs,
): Promise<ToolResult> {
  const {
    handle, ctx, call, childConfig, childManager, childParentSession,
    namedAgent, prompt, backgroundPrompt, idPrefix, depth, identity,
    promotionTriggers, activeForegroundHandles, isolationTeardown,
    childModelSource, budgetRelease,
  } = args;

  const promotionTookBudget = { value: false };
  const result = await runForegroundWithPromotion({
    handle,
    signal: call.signal,
    prompt,
    backgroundPrompt,
    idPrefix,
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

  if (result.isError !== true) return result;

  return runFallbackForeground({
    firstResult: result,
    failedModel: childConfig.model,
    childModelSource,
    ctx,
    call,
    childConfig,
    childManager,
    childParentSession,
    namedAgent,
    prompt,
    backgroundPrompt,
    idPrefix,
    depth,
    identity,
    promotionTriggers,
    activeForegroundHandles,
    isolationTeardown,
  });
}

// ---------------------------------------------------------------------------
// runFallbackForeground
// ---------------------------------------------------------------------------

export interface RunFallbackForegroundArgs extends ForegroundRunSharedArgs {
  firstResult: ToolResult;
  failedModel: string;
  childModelSource: ChildModelSource;
}

/**
 * Attempt a model fallback for a failed foreground `agent` tool dispatch.
 *
 * Forks a new handle on `fallbackModel`, runs `runForegroundWithPromotion`,
 * and tears down the fallback handle in a finally. Returns the original
 * `firstResult` unchanged when the fallback is not eligible (wrong source
 * tier, non-model error, same model, no parent model).
 */
export async function runFallbackForeground(args: RunFallbackForegroundArgs): Promise<ToolResult> {
  const {
    firstResult, failedModel, childModelSource, ctx, call, childConfig,
    childManager, childParentSession, namedAgent, prompt, backgroundPrompt,
    idPrefix, depth, identity, promotionTriggers, activeForegroundHandles,
    isolationTeardown,
  } = args;

  return attemptModelFallback({
    firstResult,
    failedModel,
    source: childModelSource,
    parentModel: ctx.parentModel,
    traceWriter: ctx.traceWriter,
    rerun: async (fallbackModel) => {
      const fallbackConfig = { ...childConfig, model: fallbackModel };
      const fallbackHandle = await ctx.subagentManager.forkSubagent({
        parent: ctx.parentSession,
        config: fallbackConfig,
        idPrefix: idPrefix ?? 'agent-fallback',
        parentId: call.id,
        agentType: namedAgent?.name ?? 'agent-fallback',
      });
      if (childParentSession !== undefined) {
        childParentSession.sessionId = fallbackHandle.id;
        childParentSession.messageJournal = fallbackHandle.session?.messageJournal;
      }
      try {
        return await runForegroundWithPromotion({
          handle: fallbackHandle,
          signal: call.signal,
          prompt,
          backgroundPrompt,
          idPrefix,
          model: fallbackModel,
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
        });
      } finally {
        await fallbackHandle.teardown().catch(() => undefined);
      }
    },
  });
}
