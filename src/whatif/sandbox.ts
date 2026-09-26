/**
 * Sandbox materializer for the what-if prediction engine.
 *
 * Builds two isolated environments (baseline, candidate) under
 * `<runDir>/sandboxes/{baseline,candidate}/`. The candidate home
 * then has the ChangeSpec applied via operator registry.
 *
 * Contract:
 *   - Both sandboxes are built identically from the real home/cwd.
 *   - Only the candidate is mutated (via applyChanges).
 *   - cleanup() removes all temporary directories and git worktrees.
 *   - No writes ever escape to the real AFK_HOME or project cwd.
 *
 * @module whatif/sandbox
 */

import {
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';

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
// Sandbox layout per label
// ---------------------------------------------------------------------------

interface SandboxPaths {
  home: string;
  project: string; // git worktree dir (only used when specTouchesProject)
}

function sandboxPaths(runDir: string, label: 'baseline' | 'candidate'): SandboxPaths {
  return {
    home: join(runDir, 'sandboxes', label, 'home'),
    project: join(runDir, 'sandboxes', label, 'project'),
  };
}

// ---------------------------------------------------------------------------
// Main: materializeSandboxes
// ---------------------------------------------------------------------------

/**
 * Build baseline and candidate sandboxes.
 *
 * Baseline and candidate homes are constructed identically; then the
 * ChangeSpec is applied to candidate only. Project worktrees (HEAD,
 * detached) are created for both envs if the spec touches the project.
 * cleanup() tears everything down.
 */
export async function materializeSandboxes(
  opts: MaterializeOptions,
): Promise<SandboxResult> {
  const { realHome, realCwd, runDir, spec, baseLaunch } = opts;
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

  const sandboxesRoot = join(runDir, 'sandboxes');
  mkdirSync(sandboxesRoot, { recursive: true });

  // Build both homes identically
  const baselinePaths = sandboxPaths(runDir, 'baseline');
  const candidatePaths = sandboxPaths(runDir, 'candidate');

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

  // Cleanup function
  async function cleanup(): Promise<void> {
    // Remove git worktrees first
    if (gitRoot) {
      for (const wt of worktreePaths) {
        removeWorktree(gitRoot, wt);
      }
    }
    // Remove the entire sandboxes directory (only under runDir)
    if (existsSync(sandboxesRoot)) {
      const resolved = resolve(sandboxesRoot);
      const resolvedRunDir = resolve(runDir);
      if (!resolved.startsWith(resolvedRunDir + '/') && resolved !== resolvedRunDir) {
        throw new Error(
          `[whatif] cleanup: sandboxes path "${resolved}" is not inside runDir "${runDir}". ` +
            `Refusing to delete.`,
        );
      }
      rmSync(sandboxesRoot, { recursive: true, force: true });
    }
  }

  return { baseline, candidate, cleanup };
}
