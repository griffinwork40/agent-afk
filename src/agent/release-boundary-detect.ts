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
import { maskHookCommandData } from './hook-command-data.js';
import { analyzeCommand } from './command-classifier.js';
import type { RiskCategory } from './risk-classifier.js';

/** The risk category emitted on every release-boundary gate verdict. */
const RELEASE_BOUNDARY_RISK_CATEGORY: RiskCategory = 'release-boundary';

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
 * Return the ids of every release-boundary pattern the command matches (empty
 * when none). Pure and stateless — no global-flag regexes, so `.test()` is safe
 * to call repeatedly. Exported for tests.
 */
export function detectReleaseBoundaryCommands(command: string): string[] {
  return analyzeCommand(command).releaseBoundary.map(({ id }) => id);
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

    const patterns = analyzeCommand(command).releaseBoundary;
    const matched = patterns.map(({ id }) => id);
    if (patterns.length === 0) return {};

    // Dry-run exemption: commands like `npm publish --dry-run`,
    // `cargo --locked publish --dry-run`, or `terraform apply -refresh-only`
    // are simulation passes — they never mutate external state. Demote any
    // BLOCK-tier match to OBSERVE-tier behavior so the agent can still run
    // these pre-flight checks without friction. The matched ids are still
    // returned so the observe record captures what would have been blocked.
    // isDryRun is applied after masking to avoid matching --dry-run inside a
    // quoted -m value (e.g. `git commit -m "--dry-run"`). For compound lines
    // where words() rejects the separator and the fallback returns raw text,
    // we test each semicolon/pipe-delimited segment independently so that
    // `git commit -m "--dry-run"; npm publish` is not incorrectly exempted.
    // Dry-run exemption logic: split the command on shell separators and test
    // each segment independently. A segment that does NOT match any release
    // boundary pattern (e.g. `echo done`) is harmless regardless of dry-run
    // flags — it must not veto the exemption. Only segments that themselves
    // match a release-boundary pattern are required to carry a dry-run flag.
    // This means `npm publish --dry-run && echo done` is correctly exempted
    // (the `echo done` segment is non-release, so it is skipped), while
    // `git commit -m "--dry-run"; npm publish` is still blocked (the
    // `npm publish` segment matches and has no --dry-run flag).
    const segments = command.split(/(?:;|\|\|?|&&)/)
      .map((s) => maskHookCommandData(s.trim()));
    if (segments.every((s) => !detectReleaseBoundaryCommands(s).length || isDryRun(s))) {
      return {
        decision: 'approve',
        reason: `${RELEASE_BOUNDARY_DETECT_REASON_PREFIX} [${matched.join(', ')}] (dry-run: not blocked)`,
        riskCategory: RELEASE_BOUNDARY_RISK_CATEGORY,
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
    for (const pattern of patterns) {
      if (pattern.tier === 'block') {
        return {
          decision: 'block',
          reason: pattern.blockReason,
          injectContext: RELEASE_BOUNDARY_BLOCK_INJECT_CONTEXT,
          riskCategory: RELEASE_BOUNDARY_RISK_CATEGORY,
        };
      }
    }

    // All matched patterns are OBSERVE-tier: record the attempt, allow through.
    return {
      decision: 'approve',
      reason: `${RELEASE_BOUNDARY_DETECT_REASON_PREFIX} [${matched.join(', ')}]`,
      riskCategory: RELEASE_BOUNDARY_RISK_CATEGORY,
    };
  };
}
