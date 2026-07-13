/**
 * Release-boundary detector — an **observe-only** PreToolUse hook.
 *
 * Migrates the detection half of the `release-boundary-gate` gate-skill into
 * deterministic harness code (Wave 1 slice 2 of the friction-substrate /
 * gate-migration program — `.afk/plans/friction-substrate-and-gate-migration.md`;
 * sibling of `safe-destruct-detect.ts`). It watches `bash` commands for the two
 * boundary classes the skill defines and, on a match, emits a witnessed
 * catch-record — **without blocking the command**:
 *   - **publish / deploy boundary** — pushing a package to a registry (npm, PyPI,
 *     crates.io, RubyGems), a container image to a registry, cutting a GitHub
 *     release, or deploying infra (`terraform apply`, `kubectl apply`);
 *   - **sync boundary** — mirroring or pushing across a visibility boundary
 *     (`git push --mirror`, release-tag pushes).
 *
 * # Why observe-only (the interpreter-eval lesson)
 *
 * This whole program exists because an over-firing PreToolUse *hard block* (the
 * interpreter-eval guard) generated 18 nights of self-inflicted friction. The
 * plan's de-risking rule is "shadow-window before enforcing". PreToolUse cannot
 * `injectContext` — the harness honors that field only for `SubagentStop` /
 * `UserPromptSubmit` (see `hooks.ts`) — and a hard block would repeat the exact
 * mistake, at higher cost here: a release/deploy is often exactly what the user
 * asked for, so blocking it would be a false positive by construction. So this
 * slice changes ZERO behavior: it only records that a boundary-crossing command
 * was attempted. The records are the shadow window; a later slice uses their
 * real-world frequency per pattern to calibrate which (if any) warrant the
 * skill's real value — a pre-boundary living-artifact check, not a block.
 *
 * # How the catch-record is emitted (the `approve` outcome)
 *
 * A PreToolUse handler can only `block` or pass; passing (`{}`) is not witnessed
 * with a reason. To emit a filterable catch-record while letting the command
 * run, this hook returns the otherwise-unused `decision: 'approve'` outcome with
 * a structured `reason`. `approve`:
 *   - is behaviorally identical to unset — `isBlocking()` (`hook-registry.ts`)
 *     checks only `block` / `continue:false`, so the command proceeds and the
 *     other PreToolUse gates (safe-destruct, afk-mode, bash-restriction, ...)
 *     still run;
 *   - is recorded by `dispatchPreToolUse` as a `hook_decision` event carrying
 *     the `reason` (`subagent-hooks.ts`), which is the Wave-4 substrate signal;
 *   - is IGNORED by the mechanical friction detectors (they count `block`
 *     outcomes / error `failureClass`es — see `improve/scan/detectors`), so
 *     these observations never masquerade as new friction.
 * Only `safe-destruct-detect` also returns `approve`; the distinct `reason`
 * prefix keeps release-boundary observations cleanly separable in the trace.
 *
 * Registered unconditionally on ALL surfaces (including headless/autonomous,
 * where an unattended publish/deploy is most consequential and least observed)
 * precisely because it never blocks — it is safe everywhere.
 *
 * @module agent/release-boundary-detect
 */

import type { HookContext, HookDecision } from './hooks.js';

/**
 * Stable prefix on the emitted `reason`. Exported so the telemetry substrate,
 * tests, and `afk trace show` can match release-boundary observations by prefix.
 */
export const RELEASE_BOUNDARY_DETECT_REASON_PREFIX =
  'release-boundary observe-only: publish/deploy/sync-boundary command';

/**
 * Curated publish / deploy / sync boundary command patterns.
 *
 * Calibration bias: high-signal only — commands that cross a real release,
 * deploy, or visibility boundary, where the skill's living-artifact contract
 * (changelogs, generated docs, lock files, version manifests) is structurally
 * at risk. Routine pre-boundary steps (`npm version`, `git tag`, `git push`
 * without `--mirror`/`--tags`) are deliberately NOT flagged. Each regex avoids
 * nested quantifiers so the scan is linear (no ReDoS); `[^|&;\n]*` bounds a
 * match to a single command segment.
 *
 * Reused by the future block/nudge slice — keep it the single source of truth.
 */
const RELEASE_BOUNDARY_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  // --- package-registry publish ----------------------------------------------
  { id: 'npm-publish', re: /\bnpm\s+publish\b/i },
  { id: 'pnpm-publish', re: /\bpnpm\s+publish\b/i },
  // yarn classic (`yarn publish`) and berry (`yarn npm publish`).
  { id: 'yarn-publish', re: /\byarn\s+(?:npm\s+)?publish\b/i },
  { id: 'cargo-publish', re: /\bcargo\s+publish\b/i },
  { id: 'pypi-twine-upload', re: /\btwine\s+upload\b/i },
  { id: 'poetry-publish', re: /\bpoetry\s+publish\b/i },
  { id: 'gem-push', re: /\bgem\s+push\b/i },

  // --- container registry -----------------------------------------------------
  { id: 'docker-push', re: /\bdocker\s+(?:image\s+)?push\b/i },

  // --- release cut ------------------------------------------------------------
  { id: 'gh-release-create', re: /\bgh\s+release\s+create\b/i },

  // --- infra deploy -----------------------------------------------------------
  { id: 'terraform-apply', re: /\bterraform\s+apply\b/i },
  { id: 'kubectl-apply', re: /\bkubectl\s+apply\b/i },

  // --- sync / visibility boundary --------------------------------------------
  // A full mirror push copies every ref across a boundary.
  { id: 'git-push-mirror', re: /\bgit\s+push\b[^|&;\n]*--mirror\b/i },
  // Pushing release tags is the canonical cut-a-release sync signal.
  { id: 'git-push-tags', re: /\bgit\s+push\b[^|&;\n]*--(?:tags|follow-tags)\b/i },
];

/**
 * Return the ids of every release-boundary pattern the command matches (empty
 * when none). Pure and stateless — no global-flag regexes, so `.test()` is safe
 * to call repeatedly. Exported for the block/nudge slice and for tests.
 */
export function detectReleaseBoundaryCommands(command: string): string[] {
  if (!command) return [];
  const hits: string[] = [];
  for (const { id, re } of RELEASE_BOUNDARY_PATTERNS) {
    if (re.test(command)) hits.push(id);
  }
  return hits;
}

/**
 * Create the observe-only release-boundary PreToolUse hook.
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

    // approve == allow (never blocks; see module header) but carries a reason
    // that lands as a `hook_decision` catch-record for the reasoning-failure
    // substrate.
    return {
      decision: 'approve',
      reason: `${RELEASE_BOUNDARY_DETECT_REASON_PREFIX} [${matched.join(', ')}]`,
    };
  };
}
