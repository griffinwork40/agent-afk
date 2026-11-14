/**
 * Builds the human-readable note returned with a successful `create` action.
 *
 * A fresh worktree does NOT share the main checkout's node_modules, so a
 * naive build/test fails opaquely. With no repo-declared setup (#3601) the
 * note is an install hint derived from the just-created tree's lockfile
 * (at `baseRef`, not main). A declared setup replaces it with the setup
 * outcome, naming the exact failed command when it did not succeed.
 *
 * @module agent/tools/handlers/worktree.create-note
 */

import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { describeWorktreeSetupFailure } from '../../worktree/worktree-setup.js';
import type { ManagedWorktreeInfo } from './worktree-managed.js';

/**
 * Detect install command from the freshly created worktree's lockfile (#439).
 * Inspects the worktree (not main checkout) so `base` lockfile differences are
 * respected. Falls back to `pnpm install`. Best-effort: never throws.
 */
export async function detectInstallCommand(worktreePath: string): Promise<string> {
  const lockfiles: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm install'],
    ['package-lock.json', 'npm install'],
    ['yarn.lock', 'yarn install'],
    ['bun.lockb', 'bun install'],
  ];
  for (const [file, command] of lockfiles) {
    try {
      await fs.access(join(worktreePath, file));
      return command;
    } catch { /* not this one */ }
  }
  return 'pnpm install';
}

/** Build the note string returned with a successful worktree create. */
export async function buildCreateNote(info: ManagedWorktreeInfo): Promise<string> {
  if (info.setup?.status === 'ok') {
    const ran = (info.setup.completed ?? []).map((c) => `\`${c}\``).join(', ');
    return `Repo-declared worktree setup (.afk/worktree-setup.json) completed in ${info.path}${ran ? `: ${ran}` : ''}.`;
  }
  const failure = describeWorktreeSetupFailure(info.setup, info.path);
  if (failure !== undefined) return failure;
  const installCommand = await detectInstallCommand(info.path);
  return `Dependencies are NOT installed in this fresh worktree (no shared node_modules). Run \`${installCommand}\` in ${info.path} before building or testing, or the build/tests will fail opaquely.`;
}
