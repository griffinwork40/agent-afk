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
 * enforcing". PreToolUse cannot `injectContext` — the harness honors that field
 * only for `SubagentStop` / `UserPromptSubmit` (see `hooks.ts`) — so the OBSERVE
 * tier records attempts without blocking, building the shadow-window dataset. A
 * later slice uses real-world frequency per pattern to re-calibrate tiers.
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
import { DESTRUCTIVE_PATTERNS } from './safe-destruct-patterns.js';

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
 * Return the ids of every destructive pattern the command matches.
 * Returns an empty array when none match.
 *
 * Pure and stateless — no global-flag regexes, safe to call repeatedly.
 * Exported for tests and for a future block/nudge slice.
 */
export function detectDestructiveCommands(command: string): string[] {
  if (!command) return [];
  const hits: string[] = [];
  for (const { id, re } of DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) hits.push(id);
  }
  return hits;
}

/**
 * Create the two-tier safe-destruct PreToolUse hook.
 *
 * Stateless (no dedup): every destructive attempt is a distinct data point —
 * an agent looping on `rm -rf x` is the signal the shadow window wants to see.
 */
export function createSafeDestructDetect(): (context: HookContext) => HookDecision {
  return function safeDestructDetect(context: HookContext): HookDecision {
    if (context.event !== 'PreToolUse') return {};
    if (context.toolName !== 'bash') return {};

    const input = context.input as Record<string, unknown> | undefined;
    const command = typeof input?.['command'] === 'string' ? input['command'] : '';
    if (!command) return {};

    const matchedIds = detectDestructiveCommands(command);
    if (matchedIds.length === 0) return {};

    // Precedence: if ANY matched pattern is BLOCK-tier, the entire command is
    // blocked. A compound command containing even one unrecoverable sub-operation
    // must not pass through because it is mixed with a recoverable one.
    //
    // Invariant: when multiple BLOCK patterns match in one compound command, the
    // first BLOCK in DESTRUCTIVE_PATTERNS table order wins. Only that pattern's
    // blockReason is reported. This is deliberate: the pattern table is ordered
    // by importance (most dangerous operations first), so the first hit is the
    // highest-priority signal and the most actionable reason for the agent.
    const patternMap = new Map(DESTRUCTIVE_PATTERNS.map((p) => [p.id, p]));
    for (const id of matchedIds) {
      const pattern = patternMap.get(id);
      if (pattern?.tier === 'block') {
        return {
          decision: 'block',
          reason: pattern.blockReason,
        };
      }
    }

    // All matched patterns are OBSERVE-tier: record the attempt, allow through.
    return {
      decision: 'approve',
      reason: `${SAFE_DESTRUCT_DETECT_REASON_PREFIX} [${matchedIds.join(', ')}]`,
    };
  };
}
