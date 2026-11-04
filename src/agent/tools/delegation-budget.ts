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
import { resolveDelegationProfile } from '../../config/delegation-profiles.js';

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

// ─── Individual-or-profile resolution ───────────────────────────────────────

/**
 * Resolve one budget field from an individual env var or a profile fallback.
 *
 * Invariant: if `raw` is set (non-undefined), the profile MUST NOT win for
 * this field — even when `raw` is invalid. An invalid-but-set individual var
 * means "no cap", not "fall through to profile". Only consult the profile when
 * `raw === undefined` (the var was never set).
 *
 * Emits a `console.warn` when `raw` is set but fails to parse as a positive
 * integer, so operators see a clear signal rather than silent no-cap behaviour.
 */
function resolveIndividualOrProfile(
  raw: string | undefined,
  ceiling: number,
  profileValue: number | undefined,
  name: string,
): number | undefined {
  if (raw !== undefined) {
    // Individual var explicitly set — profile must not win, even if invalid.
    const resolved = resolvePositiveInt(raw, ceiling);
    if (resolved === undefined) {
      console.warn(
        `[delegation-budget] ${name}=${JSON.stringify(raw)} is not a valid positive integer` +
        ` — no cap applied for this field (profile value, if any, is NOT used).`,
      );
    }
    return resolved;
  }
  // Unset — profile is the fallback.
  return profileValue !== undefined
    ? resolvePositiveInt(String(profileValue), ceiling)
    : undefined;
}

/**
 * Resolve delegation budget config from environment variables.
 *
 * Returns `undefined` when no budget env vars are set (the common case —
 * budget tracking is opt-in). The caller at wire-executors.ts creates a
 * `DelegationBudget` only when this returns a non-undefined config.
 */
export function resolveDelegationBudgetConfig(): DelegationBudgetConfig | undefined {
  // Consult the delegation profile as a source of fallback defaults only.
  const profile = resolveDelegationProfile(env.AFK_DELEGATION_PROFILE);

  // Individual env vars always override the profile — even when invalid.
  // An invalid-but-set var resolves to undefined (no cap), not to the profile.
  const effectiveChildren = resolveIndividualOrProfile(
    env.AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT,
    CEILING_CONCURRENT_CHILDREN_PER_AGENT,
    profile?.maxConcurrentChildrenPerAgent,
    'AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT',
  );
  const effectiveConcurrent = resolveIndividualOrProfile(
    env.AFK_MAX_CONCURRENT_AGENTS,
    CEILING_CONCURRENT_AGENTS,
    profile?.maxConcurrentAgents,
    'AFK_MAX_CONCURRENT_AGENTS',
  );
  const effectiveTotal = resolveIndividualOrProfile(
    env.AFK_MAX_TOTAL_AGENTS,
    CEILING_TOTAL_AGENTS,
    profile?.maxTotalAgents,
    'AFK_MAX_TOTAL_AGENTS',
  );

  if (
    effectiveChildren === undefined &&
    effectiveConcurrent === undefined &&
    effectiveTotal === undefined
  ) {
    return undefined;
  }
  return {
    ...(effectiveChildren !== undefined ? { maxConcurrentChildrenPerAgent: effectiveChildren } : {}),
    ...(effectiveConcurrent !== undefined ? { maxConcurrentAgents: effectiveConcurrent } : {}),
    ...(effectiveTotal !== undefined ? { maxTotalAgents: effectiveTotal } : {}),
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
