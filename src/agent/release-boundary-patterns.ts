/**
 * Curated publish / deploy / sync boundary command pattern table for the
 * release-boundary PreToolUse hook.
 *
 * Pulled into its own module to mirror `safe-destruct-patterns.ts` after the
 * two-tier (OBSERVE / BLOCK) upgrade.
 *
 * @module agent/release-boundary-patterns
 */

/**
 * Tier assignment for a release-boundary pattern.
 *
 * - `'block'` — hook returns `decision: 'block'` with a human-readable reason
 *   and `injectContext` guidance. Reserved for externally-irreversible publish
 *   and deploy operations whose external state change cannot be undone.
 * - `'observe'` — hook records the attempt but always returns `decision:
 *   'approve'`. Used for sync-boundary operations that are often exactly what
 *   was asked for and whose effects are closer to recoverable.
 */
export type ReleaseBoundaryTier = 'observe' | 'block';

export type ReleaseBoundaryPattern =
  | { readonly id: string; readonly re: RegExp; readonly tier: 'observe' }
  | { readonly id: string; readonly re: RegExp; readonly tier: 'block'; readonly blockReason: string };

// Invariant: Tier calibration.
//
// 383 shadow-window firings across all traces since the hook shipped (PR #524,
// v5.33.0). Publishing to an external registry or deploying infrastructure is
// externally irreversible — once the artifact is consumed by downstream users,
// it cannot be retracted by the agent. These are BLOCK-tier.
//
// Sync-boundary operations (git push --mirror, --tags) are closer to the
// "often exactly what the user asked for" boundary. A block here would be a
// false positive for legitimate release workflows. These stay OBSERVE.
//
// Calibration bias: high-signal only — commands that cross a real release,
// deploy, or visibility boundary. Routine pre-boundary steps (`npm version`,
// `git tag`, `git push` without `--mirror`/`--tags`) are deliberately NOT
// flagged. Each regex avoids nested quantifiers (no ReDoS); `[^|&;\n]*` bounds
// a match to a single command segment.
//
// Pattern ids are stable public identifiers used by telemetry, tests, and the
// trace substrate. Changing an id breaks deduplication across trace history.
export const RELEASE_BOUNDARY_PATTERNS: readonly ReleaseBoundaryPattern[] = [
  // --- package-registry publish (BLOCK) --------------------------------------
  // Once published, the version is consumed by dependents and cannot be
  // retracted (npm unpublish has a 72h window; other registries have none).
  {
    id: 'npm-publish',
    re: /\bnpm\s+publish\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [npm-publish] — publishes a package to the npm registry, externally irreversible once consumed by dependents; verify changelog, version, and generated docs are current before publishing.',
  },
  {
    id: 'pnpm-publish',
    re: /\bpnpm\s+publish\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [pnpm-publish] — publishes a package to the npm registry, externally irreversible once consumed by dependents; verify changelog, version, and generated docs are current before publishing.',
  },
  {
    id: 'yarn-publish',
    re: /\byarn\s+(?:npm\s+)?publish\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [yarn-publish] — publishes a package to the npm registry, externally irreversible once consumed by dependents; verify changelog, version, and generated docs are current before publishing.',
  },
  {
    id: 'cargo-publish',
    re: /\bcargo\s+publish\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [cargo-publish] — publishes a crate to crates.io, externally irreversible (crates.io does not allow un-publishing); verify Cargo.toml version and changelog.',
  },
  {
    id: 'pypi-twine-upload',
    re: /\btwine\s+upload\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [pypi-twine-upload] — uploads a package to PyPI, externally irreversible once consumed; verify setup.py/pyproject.toml version and changelog.',
  },
  {
    id: 'poetry-publish',
    re: /\bpoetry\s+publish\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [poetry-publish] — publishes a package to PyPI, externally irreversible once consumed; verify pyproject.toml version and changelog.',
  },
  {
    id: 'gem-push',
    re: /\bgem\s+push\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [gem-push] — pushes a gem to RubyGems, externally irreversible once consumed; verify gemspec version and changelog.',
  },

  // --- container registry (BLOCK) --------------------------------------------
  {
    id: 'docker-push',
    re: /\bdocker\s+(?:image\s+)?push\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [docker-push] — pushes a container image to a registry, externally irreversible once pulled by consumers; verify image tag and contents.',
  },

  // --- release cut (BLOCK) ---------------------------------------------------
  {
    id: 'gh-release-create',
    re: /\bgh\s+release\s+create\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [gh-release-create] — creates a GitHub release, externally visible and triggering downstream workflows; verify release notes and tag.',
  },

  // --- infra deploy (BLOCK) --------------------------------------------------
  {
    id: 'terraform-apply',
    re: /\bterraform\s+apply\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [terraform-apply] — applies infrastructure changes to live systems, externally irreversible (new apply creates different resources); run "terraform plan" to preview first.',
  },
  {
    id: 'kubectl-apply',
    re: /\bkubectl\s+apply\b/i,
    tier: 'block',
    blockReason:
      'release-boundary: blocked [kubectl-apply] — applies resources to a live Kubernetes cluster, externally irreversible for stateful workloads; verify manifests and target namespace.',
  },

  // --- sync / visibility boundary (OBSERVE) ----------------------------------
  // These are often exactly what the user asked for in a release workflow.
  // Blocking would be a false positive by construction.
  { id: 'git-push-mirror', re: /\bgit\s+push\b[^|&;\n]*--mirror\b/i, tier: 'observe' },
  { id: 'git-push-tags', re: /\bgit\s+push\b[^|&;\n]*--(?:tags|follow-tags)\b/i, tier: 'observe' },
];
