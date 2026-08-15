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
 * Return true when the command carries a dry-run flag that renders its publish
 * or deploy operation a no-op simulation. Dry-run variants should not be
 * blocked — they are safe pre-flight checks.
 *
 * Covered flags:
 *   `--dry-run`          — npm, pnpm, cargo, and most CLIs
 *   `-refresh-only`      — terraform apply -refresh-only (read-only plan pass)
 */
function isDryRun(command: string): boolean {
  return /--dry-run\b/i.test(command) || /-refresh-only\b/i.test(command);
}

/**
 * Strip single-quoted string literals from a shell command before pattern
 * matching. Single-quoted segments in POSIX shell are always literal — no
 * variable expansion, no command substitution, and crucially, no execution.
 * A publish keyword inside `'...'` is harmless (e.g. `rg 'npm publish'`).
 *
 * Also strips trailing `# comment` segments.
 */
function stripQuotedLiterals(command: string): string {
  // Remove single-quoted segments (non-greedy, no nesting in POSIX sh).
  let stripped = command.replace(/'[^']*'/g, '');
  // Remove shell-comment tails.
  stripped = stripped.replace(/#[^\n]*/g, '');
  return stripped;
}

/**
 * Return the ids of every release-boundary pattern the command matches (empty
 * when none). Pure and stateless — no global-flag regexes, so `.test()` is safe
 * to call repeatedly. Exported for tests.
 */
export function detectReleaseBoundaryCommands(command: string): string[] {
  if (!command) return [];
  const stripped = stripQuotedLiterals(command);
  const hits: string[] = [];
  for (const { id, re } of RELEASE_BOUNDARY_PATTERNS) {
    if (re.test(stripped)) hits.push(id);
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

    // Dry-run exemption: commands like `npm publish --dry-run`,
    // `cargo --locked publish --dry-run`, or `terraform apply -refresh-only`
    // are simulation passes — they never mutate external state. Demote any
    // BLOCK-tier match to OBSERVE-tier behavior so the agent can still run
    // these pre-flight checks without friction. The matched ids are still
    // returned so the observe record captures what would have been blocked.
    if (isDryRun(command)) {
      return {
        decision: 'approve',
        reason: `${RELEASE_BOUNDARY_DETECT_REASON_PREFIX} [${matched.join(', ')}] (dry-run: not blocked)`,
      };
    }

    // Precedence: if ANY matched pattern is BLOCK-tier, the entire command is
    // blocked. A compound command containing even one externally-irreversible
    // sub-operation must not pass through because it is mixed with an
    // observable one.
    //
    // Invariant: when multiple BLOCK patterns match in one compound command,
    // the first BLOCK in RELEASE_BOUNDARY_PATTERNS table order wins. Only that
    // pattern's blockReason is reported. This is deliberate: the pattern table
    // is ordered by severity (package-registry → container → release-cut →
    // infra), so the first hit is the highest-priority signal and the most
    // actionable reason for the agent.
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
