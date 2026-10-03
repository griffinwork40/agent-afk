/**
 * Pre-fork budget admission gate for the `agent` tool executor.
 *
 * Consolidates two orthogonal budget checks that fire synchronously before any
 * await — ensuring TOCTOU-safety for concurrent parallel `agent` calls in the
 * same tool batch:
 *
 *  1. **Delegation budget** (`DelegationBudget`): per-agent child cap, tree-wide
 *     concurrent/total caps. Unchanged from the prior inline block.
 *  2. **Continuation budget** (`ContinuationBudget`): coordinator-controlled
 *     aggregate round ceiling across a multi-continuation chain. Only fires when
 *     the dispatch supplies a `continuation_chain_id` AND the executor context
 *     carries a `ContinuationBudget`. Both conditions must be true — a dispatch
 *     without a chain id is never charged against the continuation budget, and a
 *     context without a budget is never checked.
 *
 * Invariants:
 *  - Both checks are synchronous and atomic (no await between admission and the
 *    counter increment). A concurrent `agent` call in the same round cannot
 *    slip through between check and record.
 *  - The combined {@link BudgetHandle} returned on admission exposes `rollback()`
 *    and `release()` callbacks that operate BOTH budgets atomically — callers need
 *    only one handle for all budget lifecycle management.
 *  - No permissions are expanded: a continuation child receives exactly the same
 *    grants as a fresh child for the same coordinator. The chain id is not
 *    forwarded into the child's config.
 *  - Fail-closed on either budget: returning a `refusal` ToolResult without
 *    charging any counters.
 *
 * @module agent/tools/subagent/budget-gate
 */

import type { ToolResult } from '../types.js';
import type { SpawnReceipt } from '../delegation-budget.js';
import { buildBudgetRefusalMessage, buildContinuationRefusalMessage } from '../delegation-budget.js';
import { appendRoutingDecision } from '../../routing-telemetry.js';
import type { AgentInput } from './input-parse.js';
import type { SubagentExecutorContext } from '../subagent-executor/types.js';
import type { TraceOrigin, TraceActor } from '../../session/session-identity.js';

/**
 * Combined budget handle returned by {@link checkBudgetGates} on admission.
 *
 * Mirrors the shape of `SpawnReceipt` so callers can use the same two-callback
 * contract regardless of whether a continuation budget is also in play.
 * Internally coordinates BOTH the delegation receipt and the continuation
 * allocation — callers need one handle, not two.
 */
export interface BudgetHandle {
  /**
   * Release the delegation slot (decrements `concurrent`). If a continuation
   * allocation was made, releases it with `actualRoundsUsed` so unspent rounds
   * return to the pool. Call when the fork succeeds and the child finishes.
   * Idempotent.
   */
  release: (actualRoundsUsed?: number) => void;
  /**
   * Roll back ALL counters — both delegation and continuation budgets —
   * as if the dispatch never happened. Call when the fork fails BEFORE the
   * child ran. Idempotent.
   */
  rollback: () => void;
  /**
   * The raw `SpawnReceipt.release` function (for backward compat with the
   * `budgetRelease` threading into `runForegroundWithPromotion`). `undefined`
   * when no delegation budget is configured.
   */
  spawnRelease: (() => void) | undefined;
}

export interface BudgetGateResult {
  /** Non-null when at least one budget refused the dispatch. No receipts are charged. */
  refusal: ToolResult | null;
  /** Non-null when admitted — combines delegation + continuation lifecycle. */
  handle: BudgetHandle | null;
}

/**
 * Run both budget admission checks atomically before any fork.
 *
 * Delegation budget is checked first (unconditional). Continuation budget is
 * checked second, only when `parsed.continuation_chain_id` is set AND
 * `ctx.continuationBudget` is present.
 *
 * On any refusal: returns `{ refusal: ToolResult, handle: null }`. No counters
 * are charged.
 *
 * On admission: returns `{ refusal: null, handle }` where `handle.rollback()`
 * undoes everything and `handle.release()` releases normally.
 */
export function checkBudgetGates(
  ctx: SubagentExecutorContext,
  parsed: Pick<AgentInput, 'agent_type' | 'continuation_chain_id' | 'max_tool_use_iterations'>,
  identity: { origin?: TraceOrigin; actor?: TraceActor },
  depth: number,
): BudgetGateResult {
  // ── Delegation budget ──────────────────────────────────────────────────────
  let receipt: SpawnReceipt | undefined;
  if (ctx.delegationBudget) {
    const check = ctx.delegationBudget.canSpawn(ctx.parentSession.sessionId ?? '');
    if (!check.allowed) {
      void appendRoutingDecision({
        ...identity,
        event: 'delegation.skipped',
        parent_session_id: ctx.parentSession.sessionId,
        reason: check.reason ?? 'budget',
        depth,
        ...(parsed.agent_type !== undefined ? { requested_name: parsed.agent_type } : {}),
      }).catch(() => {});
      return { refusal: { content: buildBudgetRefusalMessage(check), isError: true }, handle: null };
    }
    receipt = ctx.delegationBudget.recordSpawn(ctx.parentSession.sessionId ?? '');
  }

  // ── Continuation budget ────────────────────────────────────────────────────
  let continuationGranted = 0;
  let continuationReleased = false;
  let continuationRollback: (() => void) | undefined;
  if (parsed.continuation_chain_id !== undefined && ctx.continuationBudget !== undefined) {
    const requestedRounds = parsed.max_tool_use_iterations ?? 0;
    if (requestedRounds <= 0) {
      receipt?.rollback();
      return {
        refusal: {
          content:
            'Continuation dispatch requires an explicit max_tool_use_iterations so the ' +
            'chain budget can account for it. Supply a positive round cap or dispatch ' +
            'without continuation_chain_id.',
          isError: true,
        },
        handle: null,
      };
    }
    const check = ctx.continuationBudget.canContinue(requestedRounds);
    if (!check.allowed) {
      receipt?.rollback();
      return { refusal: { content: buildContinuationRefusalMessage(check), isError: true }, handle: null };
    }
    const alloc = ctx.continuationBudget.allocate(requestedRounds);
    if (alloc === null) {
      receipt?.rollback();
      return {
        refusal: {
          content:
            'Continuation budget allocation failed (concurrent exhaustion). ' +
            'Retry after existing continuations complete or escalate to the coordinator.',
          isError: true,
        },
        handle: null,
      };
    }
    continuationGranted = alloc.grantedRounds;
    continuationRollback = () => { if (!continuationReleased) { continuationReleased = true; alloc.release(0); } };
    const continuationRelease = (used: number) => { if (!continuationReleased) { continuationReleased = true; alloc.release(used); } };
    const spawnRelease = receipt?.release;
    let handleReleased = false;
    return {
      refusal: null,
      handle: {
        release: (actualRoundsUsed?: number) => { if (handleReleased) return; handleReleased = true; receipt?.release(); continuationRelease(actualRoundsUsed ?? continuationGranted); },
        rollback: () => { if (handleReleased) return; handleReleased = true; receipt?.rollback(); continuationRollback?.(); },
        spawnRelease,
      },
    };
  }

  // No continuation budget involved — wrap receipt-only.
  const spawnRelease = receipt?.release;
  let handleReleased = false;
  return {
    refusal: null,
    handle: {
      release: () => { if (handleReleased) return; handleReleased = true; receipt?.release(); },
      rollback: () => { if (handleReleased) return; handleReleased = true; receipt?.rollback(); },
      spawnRelease,
    },
  };
}
