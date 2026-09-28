/**
 * Sandbox materializer for the what-if prediction engine.
 *
 * Each arm (baseline, candidate) gets its own isolated root directory
 * created via mkdtemp under os.tmpdir(). The two roots are siblings only
 * of each other inside the system temp dir, which contains no
 * whatif-identifying structure an episode can recognise. Walking up from
 * either arm's home never reaches a directory that lists the other arm
 * (without hitting os.tmpdir() or the filesystem root).
 *
 * This replaces the previous layout (`<runDir>/sandboxes/<id>/`) where both
 * arm dirs were siblings under one shared parent, allowing `$AFK_HOME/../..`
 * enumeration to expose the other arm (issue #2466 / #2454).
 *
 * Contract:
 *   - Both sandboxes are built identically from the real home/cwd.
 *   - Only the candidate is mutated (via applyChanges).
 *   - cleanup() removes both per-arm roots and any git worktrees.
 *   - No writes ever escape to the real AFK_HOME or project cwd.
 *   - Arm labels ('baseline'/'candidate') never appear in filesystem paths.
 *
 * @module whatif/sandbox
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { relative } from 'node:path';

import type {
  Environment,
  LaunchSettings,
  ChangeSpec,
} from './types.js';
import { applyChanges, specTouchesProject, homePathsToCopyFor } from './operators/index.js';
import { buildSandboxHome, materializeSymlinks, sandboxedAfkEnvKeys } from './sandbox.home.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaterializeOptions {
  realHome: string;
  realCwd: string;
  runDir: string;
  spec: ChangeSpec;
  baseLaunch: LaunchSettings;
}

export interface SandboxResult {
  baseline: Environment;
  candidate: Environment;
  /** Per-arm mkdtemp roots under os.tmpdir(); recorded in sandboxes.json when keepSandboxes is set. */
  roots: { baseline: string; candidate: string };
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Git worktree helpers
// ---------------------------------------------------------------------------

/** Returns the root of the git repo containing `dir`, or null if none. */
function findGitRoot(dir: string): string | null {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/** Add a detached git worktree at `path`, pointing at HEAD. */
function addWorktree(repoRoot: string, path: string): void {
  execSync(`git worktree add --detach "${path}" HEAD`, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Remove a git worktree (forced). */
function removeWorktree(repoRoot: string, path: string): void {
  try {
    execSync(`git worktree remove --force "${path}"`, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Best-effort; rmSync below is the backstop
  }
}

// ---------------------------------------------------------------------------
// Deep-clone LaunchSettings
// ---------------------------------------------------------------------------

function cloneLaunch(s: LaunchSettings, unset: string[]): LaunchSettings {
  const merged = [...new Set([...(s.unset ?? []), ...unset])];
  return {
    ...(s.model !== undefined ? { model: s.model } : {}),
    ...(s.effort !== undefined ? { effort: s.effort } : {}),
    env: { ...s.env },
    ...(merged.length > 0 ? { unset: merged } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-arm sandbox layout
// ---------------------------------------------------------------------------

interface SandboxPaths {
  /** Opaque root directory created by mkdtemp (inside os.tmpdir()). */
  root: string;
  /** AFK home directory for this arm: <root>/home */
  home: string;
  /** Git worktree directory for this arm (used only when specTouchesProject): <root>/project */
  project: string;
}

/**
 * Allocate a fresh, isolated sandbox root under os.tmpdir().
 *
 * Using mkdtemp gives each arm a private top-level directory.  The prefix
 * `afk-` is short and carries no arm-label or whatif-identifying suffix;
 * the random suffix from mkdtemp is the only discriminator.  An episode
 * inside one arm that walks $AFK_HOME/../.. will arrive at os.tmpdir(),
 * which contains many unrelated entries — there is no sibling structure
 * that reveals the other arm.
 */
function allocateSandboxPaths(): SandboxPaths {
  const root = mkdtempSync(join(tmpdir(), 'afk-'));
  return {
    root,
    home: join(root, 'home'),
    project: join(root, 'project'),
  };
}

// ---------------------------------------------------------------------------
// Safety guard for cleanup
// ---------------------------------------------------------------------------

const resolvedTmpdir = resolve(tmpdir());

/**
 * Assert that `dir` is a direct child of os.tmpdir() (one level deep,
 * no traversal tricks).  Throws if not — cleanup refuses to delete
 * paths that don't satisfy this invariant.
 */
function assertUnderTmpdir(dir: string, label: string): void {
  const resolved = resolve(dir);
  if (!resolved.startsWith(resolvedTmpdir + '/') && resolved !== resolvedTmpdir) {
    throw new Error(
      `[whatif] cleanup: ${label} path "${resolved}" is not inside os.tmpdir() ` +
        `"${resolvedTmpdir}". Refusing to delete.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main: materializeSandboxes
// ---------------------------------------------------------------------------

/**
 * Build baseline and candidate sandboxes, each in its own isolated root.
 *
 * Baseline and candidate homes are constructed identically; then the
 * ChangeSpec is applied to candidate only.  Project worktrees (HEAD,
 * detached) are created for both envs when the spec touches the project.
 * cleanup() tears both roots down.
 */
export async function materializeSandboxes(
  opts: MaterializeOptions,
): Promise<SandboxResult> {
  const { realHome, realCwd, runDir: _runDir, spec, baseLaunch } = opts;
  const touchesProject = specTouchesProject(spec);
  const symPaths = homePathsToCopyFor(spec);

  // Determine git root when we need project worktrees
  let gitRoot: string | null = null;
  let relFromRoot = '';
  if (touchesProject) {
    gitRoot = findGitRoot(realCwd);
    if (!gitRoot) {
      throw new Error(
        `[whatif] sandbox: specTouchesProject is true but "${realCwd}" ` +
          `is not inside a git repository. A git repo is required to create ` +
          `isolated project worktrees for changes that touch project files.`,
      );
    }
    // When realCwd is a subdirectory of the git root, preserve the subdir.
    // Resolve both paths before computing relative to handle macOS /tmp→/private/tmp symlinks.
    const resolvedGitRoot = resolve(gitRoot);
    const resolvedRealCwd = resolve(realCwd);
    const rel = relative(resolvedGitRoot, resolvedRealCwd);
    relFromRoot = rel.startsWith('..') ? '' : rel; // e.g. "packages/foo"
  }

  // Each arm gets its own isolated root under os.tmpdir() (issue #2466).
  // The roots are NOT siblings of each other under any whatif-owned parent.
  const baselinePaths = allocateSandboxPaths();
  const candidatePaths = allocateSandboxPaths();

  mkdirSync(baselinePaths.home, { recursive: true });
  mkdirSync(candidatePaths.home, { recursive: true });

  buildSandboxHome(realHome, baselinePaths.home);
  buildSandboxHome(realHome, candidatePaths.home);

  // Materialize symlinks for paths the spec will write
  materializeSymlinks(candidatePaths.home, symPaths);

  // Project worktrees (symmetric: both envs get a fresh HEAD worktree)
  const worktreePaths: string[] = [];
  let baselineCwd = realCwd;
  let candidateCwd = realCwd;

  if (touchesProject && gitRoot) {
    addWorktree(gitRoot, baselinePaths.project);
    addWorktree(gitRoot, candidatePaths.project);
    worktreePaths.push(baselinePaths.project, candidatePaths.project);

    // Resolve worktree paths to handle macOS /tmp → /private/tmp symlinks consistently
    const resolvedBaselineProject = resolve(baselinePaths.project);
    const resolvedCandidateProject = resolve(candidatePaths.project);
    baselineCwd = relFromRoot
      ? resolve(resolvedBaselineProject, relFromRoot)
      : resolvedBaselineProject;
    candidateCwd = relFromRoot
      ? resolve(resolvedCandidateProject, relFromRoot)
      : resolvedCandidateProject;
  }

  const afkEnvKeys = sandboxedAfkEnvKeys(realHome);

  // Construct environments (resolve home paths for consistency with macOS /tmp symlinks)
  const baseline: Environment = {
    label: 'baseline',
    home: resolve(baselinePaths.home),
    cwd: baselineCwd,
    launch: cloneLaunch(baseLaunch, afkEnvKeys),
  };

  const candidate: Environment = {
    label: 'candidate',
    home: resolve(candidatePaths.home),
    cwd: candidateCwd,
    launch: cloneLaunch(baseLaunch, afkEnvKeys),
  };

  // Apply spec to candidate only
  await applyChanges(spec, candidate, { realHome, realCwd });

  // Cleanup function — removes both isolated roots
  async function cleanup(): Promise<void> {
    // Remove git worktrees first
    if (gitRoot) {
      for (const wt of worktreePaths) {
        removeWorktree(gitRoot, wt);
      }
    }
    // Remove each arm's root directory (guarded: must be inside os.tmpdir())
    for (const { root, label } of [
      { root: baselinePaths.root, label: 'baseline root' },
      { root: candidatePaths.root, label: 'candidate root' },
    ]) {
      if (existsSync(root)) {
        assertUnderTmpdir(root, label);
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  return {
    baseline,
    candidate,
    roots: { baseline: baselinePaths.root, candidate: candidatePaths.root },
    cleanup,
  };
}
