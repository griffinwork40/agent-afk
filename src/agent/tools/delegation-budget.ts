/**
 * Tree-wide delegation budget for subagent spawning.
 *
 * Tracks three orthogonal limits across a single session tree:
 *   1. **maxConcurrentChildrenPerAgent** — how many children a single agent may have running concurrently.
 *   2. **maxConcurrentAgents** — tree-wide ceiling on simultaneously-live agents.
 *   3. **maxTotalAgents** — tree-wide lifetime ceiling on total agents spawned.
 *
 * A single `DelegationBudget` instance is created at the root session
 * (wire-executors.ts) and threaded by REFERENCE through every executor
 * context and child-config propagation path. Children never copy it —
 * every depth in the tree shares the same counters.
 *
 * Invariant: `concurrent` never exceeds `total`. `recordSpawn` increments
 * both atomically; the {@link SpawnReceipt} it returns has two callbacks:
 * `release()` decrements `concurrent` and `concurrentChildrenByAgent` (normal completion),
 * and `rollback()` undoes all three counters (fork failure before child ran).
 * Both are idempotent — double-calls are safe.
 *
 * @module agent/tools/delegation-budget
 */

import { env } from '../../config/env.js';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface DelegationBudgetConfig {
  /** Max children a single agent (identified by sessionId) may have running concurrently. */
  maxConcurrentChildrenPerAgent?: number;
  /** Max agents running simultaneously across the entire tree. */
  maxConcurrentAgents?: number;
  /** Max agents ever spawned across the entire tree (lifetime). */
  maxTotalAgents?: number;
}

/**
 * Upper bounds accepted from environment variables. Prevents a typo
 * (`4000` for `40`) from creating an unbounded swarm.
 */
const CEILING_CONCURRENT_CHILDREN_PER_AGENT = 20;
const CEILING_CONCURRENT_AGENTS = 64;
const CEILING_TOTAL_AGENTS = 200;

// ─── Refusal reasons ────────────────────────────────────────────────────────

export type BudgetRefusalReason =
  | 'max_concurrent_children_per_agent'
  | 'max_concurrent_agents'
  | 'max_total_agents';

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: BudgetRefusalReason;
  detail?: string;
}

// ─── Environment resolution ─────────────────────────────────────────────────

function resolvePositiveInt(
  raw: string | undefined,
  ceiling: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return Math.min(n, ceiling);
}

/**
 * Resolve delegation budget config from environment variables.
 *
 * Returns `undefined` when no budget env vars are set (the common case —
 * budget tracking is opt-in). The caller at wire-executors.ts creates a
 * `DelegationBudget` only when this returns a non-undefined config.
 */
export function resolveDelegationBudgetConfig(): DelegationBudgetConfig | undefined {
  const maxChildren = resolvePositiveInt(
    env.AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT,
    CEILING_CONCURRENT_CHILDREN_PER_AGENT,
  );
  const maxConcurrent = resolvePositiveInt(
    env.AFK_MAX_CONCURRENT_AGENTS,
    CEILING_CONCURRENT_AGENTS,
  );
  const maxTotal = resolvePositiveInt(
    env.AFK_MAX_TOTAL_AGENTS,
    CEILING_TOTAL_AGENTS,
  );
  if (maxChildren === undefined && maxConcurrent === undefined && maxTotal === undefined) {
    return undefined;
  }
  return {
    ...(maxChildren !== undefined ? { maxConcurrentChildrenPerAgent: maxChildren } : {}),
    ...(maxConcurrent !== undefined ? { maxConcurrentAgents: maxConcurrent } : {}),
    ...(maxTotal !== undefined ? { maxTotalAgents: maxTotal } : {}),
  };
}

// ─── Budget tracker ─────────────────────────────────────────────────────────

export interface DelegationBudgetSnapshot {
  concurrent: number;
  total: number;
  config: DelegationBudgetConfig;
}

/** Return type of {@link DelegationBudget.recordSpawn}. */
export interface SpawnReceipt {
  /**
   * Decrements `concurrent` and `concurrentChildrenByAgent`. Call when the
   * child finishes normally — `total` intentionally persists so the lifetime
   * cap (`maxTotalAgents`) remains accurate.
   * Idempotent: double-calls are safe.
   */
  release: () => void;
  /**
   * Undoes ALL three counters (`concurrent`, `total`, `concurrentChildrenByAgent`).
   * Call when a fork attempt fails BEFORE the child ever ran — i.e. when
   * `forkSubagent` throws or the handle is cancelled before any work started.
   * Without rollback, a fork failure permanently consumes budget slots,
   * eventually exhausting `maxTotalAgents` or `maxConcurrentChildrenPerAgent`.
   * Idempotent: double-calls are safe.
   */
  rollback: () => void;
}

export class DelegationBudget {
  private concurrent = 0;
  private total = 0;
  private readonly concurrentChildrenByAgent = new Map<string, number>();

  constructor(private readonly config: DelegationBudgetConfig) {}

  /**
   * Check whether a new agent spawn is allowed given current budget state.
   *
   * Pure query — does not mutate counters. Call before `recordSpawn`.
   */
  canSpawn(parentId: string): BudgetCheckResult {
    const { maxConcurrentChildrenPerAgent, maxConcurrentAgents, maxTotalAgents } = this.config;

    if (maxConcurrentChildrenPerAgent !== undefined) {
      const children = this.concurrentChildrenByAgent.get(parentId) ?? 0;
      if (children >= maxConcurrentChildrenPerAgent) {
        return {
          allowed: false,
          reason: 'max_concurrent_children_per_agent',
          detail:
            `This agent has ${children} children running ` +
            `(max ${maxConcurrentChildrenPerAgent}).`,
        };
      }
    }

    if (maxConcurrentAgents !== undefined && this.concurrent >= maxConcurrentAgents) {
      return {
        allowed: false,
        reason: 'max_concurrent_agents',
        detail:
          `${this.concurrent} agents already running ` +
          `(max ${maxConcurrentAgents}).`,
      };
    }

    if (maxTotalAgents !== undefined && this.total >= maxTotalAgents) {
      return {
        allowed: false,
        reason: 'max_total_agents',
        detail:
          `${this.total} agents already spawned this session ` +
          `(max ${maxTotalAgents}).`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a new agent spawn. Returns a {@link SpawnReceipt} with two
   * idempotent callbacks:
   *
   * - `release()` — decrements `concurrent` and `concurrentChildrenByAgent`.
   *   Use when the child finishes normally. `total` is intentionally kept so
   *   the lifetime cap (`maxTotalAgents`) remains accurate.
   * - `rollback()` — undoes ALL three counters. Use when the fork fails before
   *   the child ever ran (e.g. `forkSubagent` throws, handle cancelled pre-run).
   *   Without rollback, a fork failure permanently consumes budget.
   *
   * Contract: call BEFORE the fork (pre-TOCTOU) and then either `release()` on
   * success or `rollback()` on fork failure. Never call both.
   */
  recordSpawn(parentId: string): SpawnReceipt {
    this.concurrent++;
    this.total++;
    this.concurrentChildrenByAgent.set(
      parentId,
      (this.concurrentChildrenByAgent.get(parentId) ?? 0) + 1,
    );

    let released = false;
    let rolledBack = false;

    const release = (): void => {
      if (!released && !rolledBack) {
        released = true;
        this.concurrent = Math.max(0, this.concurrent - 1);
        const prev = this.concurrentChildrenByAgent.get(parentId) ?? 0;
        const next = prev - 1;
        if (next <= 0) {
          this.concurrentChildrenByAgent.delete(parentId);
        } else {
          this.concurrentChildrenByAgent.set(parentId, next);
        }
      }
    };

    const rollback = (): void => {
      if (!released && !rolledBack) {
        rolledBack = true;
        this.concurrent = Math.max(0, this.concurrent - 1);
        this.total = Math.max(0, this.total - 1);
        const prev = this.concurrentChildrenByAgent.get(parentId) ?? 0;
        const next = prev - 1;
        if (next <= 0) {
          this.concurrentChildrenByAgent.delete(parentId);
        } else {
          this.concurrentChildrenByAgent.set(parentId, next);
        }
      }
    };

    return { release, rollback };
  }

  /** Read-only snapshot for telemetry / diagnostics. */
  snapshot(): DelegationBudgetSnapshot {
    return {
      concurrent: this.concurrent,
      total: this.total,
      config: { ...this.config },
    };
  }
}

// ─── Continuation budget ─────────────────────────────────────────────────────

/**
 * Coordinator-controlled continuation budget for multi-phase subagent chains.
 *
 * Purpose: when a subagent hits its tool-round cap before finishing, a
 * coordinator may dispatch a continuation child to resume. Without a shared
 * budget, repeated continuations can silently exceed the work the coordinator
 * intended — the parent's own tool rounds do NOT measure children's work.
 *
 * Responsibilities:
 *  1. **Aggregate round allowance**: a single total ceiling on rounds across
 *     ALL continuation children in a chain (not per-child).
 *  2. **Continuation count limit**: a ceiling on how many continuation
 *     dispatches are allowed (distinct from the round ceiling).
 *  3. **Atomic concurrent allocation**: for DAG/parallel continuations,
 *     `allocate()` reserves rounds before a child is forked so two concurrent
 *     forks can't both over-spend the remaining budget.
 *
 * Invariants:
 *  - Fail-closed on unsupported paths: when `allocate` is called with more
 *    rounds than remain, it returns `null` rather than allowing the dispatch.
 *  - Idempotent release: `release()` from a given allocation handle is safe to
 *    call twice; the second call is a no-op.
 *  - This tracks GRANTED rounds, not actual consumption — a child that uses
 *    fewer rounds than allocated should call `release(allocated - actualUsed)`
 *    to return the unspent allowance for subsequent continuations.
 *
 * Conservative defaults (documented, not magic numbers):
 *  - `maxChainRounds`: 200 (4× the 50-round default per child, covering ~4 full
 *    continuation children before the coordinator must escalate or stop)
 *  - `maxContinuations`: 3 (an empirical bound — repeating continuation more
 *    than 3 times without coordinator-level progress strongly indicates a
 *    decomposition problem, not a round-budget problem)
 *
 * @module agent/tools/delegation-budget (ContinuationBudget section)
 */
export interface ContinuationBudgetConfig {
  /** Total rounds available across ALL continuation children in the chain. */
  maxChainRounds: number;
  /** Maximum number of continuation dispatches allowed (independent of rounds). */
  maxContinuations: number;
}

/** Conservative, documented defaults for {@link ContinuationBudgetConfig}. */
export const CONTINUATION_BUDGET_DEFAULTS: ContinuationBudgetConfig = {
  maxChainRounds: 200,
  maxContinuations: 3,
};

export interface ContinuationAllocation {
  /** The number of rounds granted by this allocation. */
  grantedRounds: number;
  /**
   * Return unspent rounds to the budget. Call with `actualRoundsUsed` after
   * the continuation child finishes. If the child used fewer rounds than
   * granted, the delta is returned to the pool for subsequent continuations.
   * Idempotent: double-release is a no-op. Returns the amount released.
   */
  release(actualRoundsUsed: number): number;
}

export type ContinuationRefusalReason =
  | 'max_chain_rounds_exhausted'
  | 'max_continuations_reached'
  | 'requested_rounds_exceed_remaining';

export interface ContinuationCheckResult {
  allowed: boolean;
  reason?: ContinuationRefusalReason;
  detail?: string;
}

export class ContinuationBudget {
  private roundsGranted = 0;
  private continuationsDispatched = 0;
  private readonly config: ContinuationBudgetConfig;

  constructor(config: Partial<ContinuationBudgetConfig> = {}) {
    this.config = { ...CONTINUATION_BUDGET_DEFAULTS, ...config };
  }

  get remainingRounds(): number {
    return Math.max(0, this.config.maxChainRounds - this.roundsGranted);
  }

  get remainingContinuations(): number {
    return Math.max(0, this.config.maxContinuations - this.continuationsDispatched);
  }

  /**
   * Check whether a continuation dispatch is allowed.
   *
   * Pure query — does not mutate counters. Call before `allocate`.
   */
  canContinue(requestedRounds: number): ContinuationCheckResult {
    if (this.continuationsDispatched >= this.config.maxContinuations) {
      return {
        allowed: false,
        reason: 'max_continuations_reached',
        detail:
          `${this.continuationsDispatched} continuations already dispatched ` +
          `(max ${this.config.maxContinuations}).`,
      };
    }
    if (this.roundsGranted >= this.config.maxChainRounds) {
      return {
        allowed: false,
        reason: 'max_chain_rounds_exhausted',
        detail:
          `All ${this.config.maxChainRounds} chain rounds have been allocated.`,
      };
    }
    if (requestedRounds > this.remainingRounds) {
      return {
        allowed: false,
        reason: 'requested_rounds_exceed_remaining',
        detail:
          `Requested ${requestedRounds} rounds but only ${this.remainingRounds} remain ` +
          `of ${this.config.maxChainRounds} total chain rounds.`,
      };
    }
    return { allowed: true };
  }

  /**
   * Atomically allocate `requestedRounds` for a continuation child.
   *
   * Returns a {@link ContinuationAllocation} on success, or `null` when the
   * budget check fails (fail-closed). Call `canContinue` first if you need
   * the refusal reason; `allocate` discards it for callers that only branch
   * on null/non-null.
   *
   * Contract: call BEFORE forking the continuation child. On fork failure,
   * call `allocation.release(0)` to return the full granted amount.
   */
  allocate(requestedRounds: number): ContinuationAllocation | null {
    const check = this.canContinue(requestedRounds);
    if (!check.allowed) return null;

    this.roundsGranted += requestedRounds;
    this.continuationsDispatched += 1;
    let released = false;

    return {
      grantedRounds: requestedRounds,
      release: (actualRoundsUsed: number): number => {
        if (released) return 0;
        released = true;
        const unspent = Math.max(0, requestedRounds - actualRoundsUsed);
        this.roundsGranted = Math.max(0, this.roundsGranted - unspent);
        return unspent;
      },
    };
  }

  /** Read-only snapshot for telemetry / diagnostics. */
  snapshot(): { roundsGranted: number; continuationsDispatched: number; config: ContinuationBudgetConfig } {
    return {
      roundsGranted: this.roundsGranted,
      continuationsDispatched: this.continuationsDispatched,
      config: { ...this.config },
    };
  }
}

/**
 * Build a human-readable refusal message for a continuation budget check
 * failure. Style mirrors {@link buildBudgetRefusalMessage}.
 */
export function buildContinuationRefusalMessage(check: ContinuationCheckResult): string {
  if (check.allowed) return '';
  switch (check.reason) {
    case 'max_chain_rounds_exhausted':
      return (
        `Continuation budget exhausted: ${check.detail} ` +
        'Decompose the remaining work into a new coordinator-level task instead.'
      );
    case 'max_continuations_reached':
      return (
        `Continuation budget exhausted: ${check.detail} ` +
        'Further continuation indicates a decomposition problem — escalate to the coordinator.'
      );
    case 'requested_rounds_exceed_remaining':
      return (
        `Continuation budget insufficient: ${check.detail} ` +
        'Reduce the requested rounds or escalate to the coordinator.'
      );
    default:
      return 'Continuation budget exhausted. Escalate to the coordinator.';
  }
}

// ─── Refusal message builder ────────────────────────────────────────────────

/**
 * Build a human-readable refusal message for the model when a budget
 * limit prevents a dispatch. Mirrors the style of
 * `buildAgentMaxDepthRefusal` in `skill-depth-message.ts`.
 */
export function buildBudgetRefusalMessage(check: BudgetCheckResult): string {
  if (check.allowed) return '';
  const hint =
    'Work inline instead of delegating, or wait for a running child to finish.';
  switch (check.reason) {
    case 'max_concurrent_children_per_agent':
      return `Delegation budget exceeded: ${check.detail} ` +
        'Wait for a running child of this agent to finish, or work inline.';
    case 'max_concurrent_agents':
      return `Delegation budget exceeded: ${check.detail} ${hint}`;
    case 'max_total_agents':
      return `Delegation budget exceeded: ${check.detail} ${hint}`;
    default:
      return `Delegation budget exceeded. ${hint}`;
  }
}
