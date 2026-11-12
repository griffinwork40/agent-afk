/**
 * Safe-destruct detector — a two-tier PreToolUse hook.
 *
 * Migrates the detection half of the `safe-destruct` gate-skill into
 * deterministic harness code (Wave 1 of the friction-substrate / gate-migration
 * program — `.afk/plans/friction-substrate-and-gate-migration.md`). It watches
 * `bash` commands for a curated set of catastrophic / irreversible operations
 * and routes each matched pattern to one of two tiers:
 *
 *   OBSERVE — returns `decision: 'approve'` (never blocks). High-volume routine
 *     operations or recoverable ones where a hard block would generate 326-class
 *     friction (see `safe-destruct-patterns.ts` for the calibration invariant).
 *
 *   BLOCK — returns `decision: 'block'` with a human-readable reason string.
 *     Reserved for unrecoverable or externally-irreversible operations that are
 *     never inner-loop for a well-behaved agent.
 *
 * # Precedence rule
 *
 * When a single compound command matches patterns from both tiers, BLOCK wins.
 * The precedence is deliberate and explicit — a command that contains even one
 * unrecoverable sub-operation must not slip through because it is mixed with a
 * recoverable one.
 *
 * # Why observe exists at all (the interpreter-eval lesson)
 *
 * This whole program exists because an over-firing PreToolUse *hard block* (the
 * interpreter-eval guard) generated 18 nights of self-inflicted friction. The
 * plan's de-risking rule is "injectContext-first, shadow-window before
 * enforcing". BLOCK-tier patterns use `injectContext` (PR #1088) to explain
 * *why* the command was blocked and *what to do instead*, so the agent receives
 * actionable guidance — not a bare refusal. OBSERVE-tier patterns record
 * attempts without blocking, building the shadow-window dataset. A later slice
 * uses real-world frequency per pattern to re-calibrate tiers.
 *
 * # How the approve catch-record is emitted
 *
 * A PreToolUse handler can only `block` or pass; passing (`{}`) is not witnessed
 * with a reason. To emit a filterable catch-record while letting the command run,
 * OBSERVE patterns return `decision: 'approve'` with a structured reason:
 *   - behaviorally identical to unset — `isBlocking()` checks only `block` /
 *     `continue:false`, so the command proceeds and other PreToolUse gates still
 *     run;
 *   - recorded by `dispatchPreToolUse` as a `hook_decision` event carrying the
 *     `reason`, which is the Wave-4 substrate signal;
 *   - IGNORED by friction detectors (they count `block` outcomes / error
 *     `failureClass`es), so observations never masquerade as new friction.
 *
 * Registered unconditionally on ALL surfaces (including headless/autonomous,
 * where destructive actions are most dangerous and least observed) — OBSERVE
 * patterns are safe everywhere; BLOCK patterns fire before irreversible damage.
 *
 * @module agent/safe-destruct-detect
 */

import type { HookContext, HookDecision } from './hooks.js';
import { analyzeCommand } from './command-classifier.js';
import { isWorktreeCwd } from './manifest/worktree.js';

/**
 * Stable prefix on OBSERVE reason strings. Exported so telemetry, tests, and
 * `afk trace show` can isolate safe-destruct observations by prefix.
 *
 * BLOCK reasons are pattern-specific (see `safe-destruct-patterns.ts`) and do
 * not share this prefix — they are the agent's only feedback and must be
 * self-contained.
 */
export const SAFE_DESTRUCT_DETECT_REASON_PREFIX =
  'safe-destruct observe-only: destructive-command attempt';

/**
 * Context injected into the `isError` tool_result when a BLOCK-tier pattern
 * fires. Delivered via `HookBlockedError.injectContext` → `dispatcher.ts`
 * block-path content (PR #1088). The agent sees this after the terse
 * `blockReason` — it explains the hook's purpose and what to do next.
 */
export const SAFE_DESTRUCT_BLOCK_INJECT_CONTEXT =
  'This command was blocked by the safe-destruct hook because it matches an ' +
  'irrecoverable or externally-irreversible operation pattern. The block ' +
  'cannot be self-bypassed. First, use the safer alternative named in the ' +
  'block reason above. The block covers this command only: keep running ' +
  'other non-destructive commands yourself, but do not reach the same ' +
  'destructive effect another way. Only if the destructive action is ' +
  'genuinely required, stop and ask the operator to run it manually.';

/**
 * Ids of patterns whose block is conditional on the session cwd being inside
 * a linked afk worktree. When the cwd is absent or not inside `.afk-worktrees/`,
 * these patterns are downgraded from BLOCK to OBSERVE so that the same command
 * in a normal root checkout is not blocked.
 *
 * Invariant: must stay in sync with the pattern ids in DESTRUCTIVE_PATTERNS.
 * Only patterns whose hazard is specific to shared git state across worktrees
 * belong here; unconditionally dangerous patterns must NOT be added.
 */
export const WORKTREE_SCOPED_BLOCK_IDS: ReadonlySet<string> = new Set(['git-stash-mutating']);

/**
 * Return the ids of every destructive pattern the command matches.
 * Returns an empty array when none match.
 *
 * Pure and stateless — no global-flag regexes, safe to call repeatedly.
 * Exported for tests and for a future block/nudge slice.
 */
export function detectDestructiveCommands(command: string): string[] {
  return analyzeCommand(command).destructive.map(({ id }) => id);
}

/**
 * Create the two-tier safe-destruct PreToolUse hook.
 *
 * Accepts an optional `sessionCwd` so that worktree-scoped BLOCK patterns
 * (see {@link WORKTREE_SCOPED_BLOCK_IDS}) are enforced only when the session is
 * running inside a linked afk worktree (`.afk-worktrees/<slug>/`). When
 * `sessionCwd` is absent or points to a non-worktree path, those patterns are
 * downgraded to OBSERVE so normal root-session use is not blocked.
 *
 * The hook also reads `context.cwd` (per-call worktree override set by the
 * dispatcher) and prefers that over `sessionCwd` when both are present, so a
 * forked subagent whose per-call cwd was explicitly set to a worktree path is
 * correctly guarded even if `sessionCwd` was not threaded.
 *
 * Stateless (no dedup): every destructive attempt is a distinct data point —
 * an agent looping on `rm -rf x` is the signal the shadow window wants to see.
 */
export function createSafeDestructDetect(sessionCwd?: string): (context: HookContext) => HookDecision {
  return function safeDestructDetect(context: HookContext): HookDecision {
    if (context.event !== 'PreToolUse') return {};
    if (context.toolName !== 'bash') return {};

    const input = context.input as Record<string, unknown> | undefined;
    const command = typeof input?.['command'] === 'string' ? input['command'] : '';
    if (!command) return {};

    // Resolve effective cwd: prefer the per-call override (set by the dispatcher
    // for forked children) over the factory-time sessionCwd.
    const effectiveCwd =
      (context as { cwd?: string }).cwd ?? sessionCwd;
    const inWorktree = effectiveCwd !== undefined && isWorktreeCwd(effectiveCwd);

    const matched = analyzeCommand(command).destructive;
    const matchedIds = matched.map(({ id }) => id);
    if (matched.length === 0) return {};

    // Precedence: if ANY matched pattern is BLOCK-tier, the entire command is
    // blocked. A compound command containing even one unrecoverable sub-operation
    // must not pass through because it is mixed with a recoverable one.
    //
    // Invariant: when multiple BLOCK patterns match in one compound command, the
    // first BLOCK in DESTRUCTIVE_PATTERNS table order wins. Only that pattern's
    // blockReason is reported. This is deliberate: the pattern table is ordered
    // by importance (most dangerous operations first), so the first hit is the
    // highest-priority signal and the most actionable reason for the agent.
    //
    // Worktree-scoped patterns: BLOCK_IDS in WORKTREE_SCOPED_BLOCK_IDS are
    // treated as OBSERVE when the session is not inside a linked worktree.
    for (const pattern of matched) {
      const { id } = pattern;
      if (pattern.tier === 'block') {
        // Downgrade to OBSERVE when the pattern is worktree-scoped and we are
        // not inside a linked worktree — fall through to the OBSERVE branch.
        if (WORKTREE_SCOPED_BLOCK_IDS.has(id) && !inWorktree) continue;
        return {
          decision: 'block',
          reason: pattern.blockReason,
          injectContext: SAFE_DESTRUCT_BLOCK_INJECT_CONTEXT,
        };
      }
    }

    // All matched patterns are OBSERVE-tier (or worktree-scoped BLOCK downgraded
    // to OBSERVE because we are not in a worktree): record the attempt, allow through.
    return {
      decision: 'approve',
      reason: `${SAFE_DESTRUCT_DETECT_REASON_PREFIX} [${matchedIds.join(', ')}]`,
    };
  };
}
