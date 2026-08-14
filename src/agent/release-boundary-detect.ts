/**
 * Release-boundary detector — a two-tier PreToolUse hook.
 *
 * Migrates the detection half of the `release-boundary-gate` gate-skill into
 * deterministic harness code (Wave 1 slice 2 of the friction-substrate /
 * gate-migration program — `.afk/plans/friction-substrate-and-gate-migration.md`;
 * sibling of `safe-destruct-detect.ts`). It watches `bash` commands for the two
 * boundary classes the skill defines and routes each to one of two tiers:
 *
 *   BLOCK — returns `decision: 'block'` with a human-readable reason and
 *     `injectContext` guidance. Reserved for externally-irreversible publish
 *     and deploy operations: once a package is published to a registry, a
 *     container image pushed, a GitHub release cut, or infra applied, the
 *     external state change cannot be undone by the agent.
 *
 *   OBSERVE — returns `decision: 'approve'` (never blocks). Used for sync
 *     boundary operations (`git push --mirror`, `--tags`) that are closer to
 *     the "often exactly what was asked for" boundary — blocking these would
 *     generate false-positive friction for legitimate release workflows.
 *
 * # Precedence rule
 *
 * When a single compound command matches patterns from both tiers, BLOCK wins.
 * Same rationale as `safe-destruct-detect.ts`: a command containing even one
 * externally-irreversible sub-operation must not slip through because it is
 * mixed with a recoverable one.
 *
 * # How the approve catch-record is emitted (OBSERVE tier)
 *
 * A PreToolUse handler can only `block` or pass; passing (`{}`) is not witnessed
 * with a reason. To emit a filterable catch-record while letting the command
 * run, OBSERVE patterns return `decision: 'approve'` with a structured reason:
 *   - behaviorally identical to unset — `isBlocking()` (`hook-registry.ts`)
 *     checks only `block` / `continue:false`, so the command proceeds;
 *   - recorded by `dispatchPreToolUse` as a `hook_decision` event carrying
 *     the `reason`, which is the Wave-4 substrate signal;
 *   - IGNORED by the mechanical friction detectors.
 *
 * Registered unconditionally on ALL surfaces (including headless/autonomous,
 * where an unattended publish/deploy is most consequential and least observed).
 *
 * @module agent/release-boundary-detect
 */

import type { HookContext, HookDecision } from './hooks.js';
import {
  RELEASE_BOUNDARY_PATTERNS,
  type ReleaseBoundaryPattern,
} from './release-boundary-patterns.js';

/**
 * Stable prefix on OBSERVE reason strings. Exported so telemetry, tests, and
 * `afk trace show` can isolate release-boundary observations by prefix.
 */
export const RELEASE_BOUNDARY_DETECT_REASON_PREFIX =
  'release-boundary observe-only: sync-boundary command';

/**
 * Context injected into the `isError` tool_result when a BLOCK-tier pattern
 * fires. Delivered via `HookBlockedError.injectContext` → `dispatcher.ts`
 * block-path content (PR #1088). The agent sees this after the terse
 * `blockReason` — it explains the hook's purpose and what to do next.
 */
export const RELEASE_BOUNDARY_BLOCK_INJECT_CONTEXT =
  'This command was blocked by the release-boundary hook because it crosses ' +
  'an externally-irreversible publish or deploy boundary. Once a package is ' +
  'published, a container pushed, a release cut, or infrastructure applied, ' +
  'the external state change cannot be undone by the agent. Verify that all ' +
  'living artifacts (changelog, version, generated docs, lock files) are ' +
  'up-to-date before proceeding, and ask the operator to confirm publication.';

/**
 * Return the ids of every release-boundary pattern the command matches (empty
 * when none). Pure and stateless — no global-flag regexes, so `.test()` is safe
 * to call repeatedly. Exported for tests.
 */
export function detectReleaseBoundaryCommands(command: string): string[] {
  if (!command) return [];
  const hits: string[] = [];
  for (const { id, re } of RELEASE_BOUNDARY_PATTERNS) {
    if (re.test(command)) hits.push(id);
  }
  return hits;
}

/** Look up a pattern by id. */
function getPattern(id: string): ReleaseBoundaryPattern | undefined {
  return RELEASE_BOUNDARY_PATTERNS.find((p) => p.id === id);
}

/**
 * Create the two-tier release-boundary PreToolUse hook.
 *
 * Stateless (no dedup): every boundary-crossing attempt is a distinct data
 * point — a session that publishes twice is exactly the signal the shadow
 * window wants to surface, so occurrences are not collapsed.
 */
export function createReleaseBoundaryDetect(): (context: HookContext) => HookDecision {
  return function releaseBoundaryDetect(context: HookContext): HookDecision {
    if (context.event !== 'PreToolUse') return {};
    if (context.toolName !== 'bash') return {};

    const input = context.input as Record<string, unknown> | undefined;
    const command = typeof input?.['command'] === 'string' ? input['command'] : '';
    if (!command) return {};

    const matched = detectReleaseBoundaryCommands(command);
    if (matched.length === 0) return {};

    // Precedence: if ANY matched pattern is BLOCK-tier, the entire command is
    // blocked. A compound command containing even one externally-irreversible
    // sub-operation must not pass through because it is mixed with an
    // observable one.
    for (const id of matched) {
      const pattern = getPattern(id);
      if (pattern?.tier === 'block') {
        return {
          decision: 'block',
          reason: pattern.blockReason,
          injectContext: RELEASE_BOUNDARY_BLOCK_INJECT_CONTEXT,
        };
      }
    }

    // All matched patterns are OBSERVE-tier: record the attempt, allow through.
    return {
      decision: 'approve',
      reason: `${RELEASE_BOUNDARY_DETECT_REASON_PREFIX} [${matched.join(', ')}]`,
    };
  };
}
