#!/usr/bin/env node
/**
 * install-pre-push-hook.mjs — Install a pre-push launcher into the git repo's
 * common hooks directory so it covers all worktrees.
 *
 * Invoked by the package.json `prepare` lifecycle hook (runs on `pnpm install`).
 * Must never fail `pnpm install` — catches everything and exits 0 on error.
 *
 * Contract:
 *  - Skips when CI env var is set (any truthy value).
 *  - Skips when not inside a git work tree.
 *  - Skips when core.hooksPath is configured; custom hook routing is left alone.
 *  - Never overwrites an existing pre-push hook that lacks our marker.
 *  - Idempotent: re-running updates the launcher content but only when our
 *    marker is present (i.e. we own the file).
 *  - Sets chmod +x on the written file.
 *  - Does NOT set core.hooksPath.
 *  - Safe when run by `npm publish` / `npm pack` (CI skip + no git tree).
 *
 * The installer writes to the git COMMON dir so it is shared across all
 * worktrees. The launcher itself resolves the CURRENT worktree's toplevel at
 * run time and delegates to scripts/git-hooks/pre-push from that tree — so
 * branches/worktrees without the script are unaffected (the launcher exits 0).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── Marker embedded in the launcher ──────────────────────────────────────────
// The installer checks for this string before overwriting.
const MARKER = '# installed-by: agent-afk/install-pre-push-hook';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Run a git command and return stdout trimmed. Throws on failure.
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Determine whether we are inside a git work tree.
 * @returns {boolean}
 */
function insideGitWorkTree() {
  try {
    return git(['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

/**
 * Return the git common dir (shared across all worktrees).
 * @returns {string}
 */
function gitCommonDir() {
  return git(['rev-parse', '--git-common-dir']);
}

/** @returns {string} */
function gitTopLevel() {
  return git(['rev-parse', '--show-toplevel']);
}

/** @returns {string} */
function configuredHooksPath() {
  try {
    return git(['config', '--get', 'core.hooksPath']);
  } catch {
    return '';
  }
}

/**
 * True only when this installer is running from the checkout it is about to
 * modify. This prevents a nested consumer package or copied script from writing
 * hooks into an ancestor repository that does not own this package.
 * @param {string} dir
 */
function installerBelongsToTopLevel(dir) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptDir);
  try {
    return normalize(realpathSync(packageRoot)) === normalize(realpathSync(resolve(dir)));
  } catch {
    return normalize(resolve(packageRoot)) === normalize(resolve(dir));
  }
}

// ── Launcher content ──────────────────────────────────────────────────────────

/**
 * Build the launcher shell script content.
 * @returns {string}
 */
function launcherContent() {
  return [
    '#!/bin/sh',
    MARKER,
    '# This launcher delegates to scripts/git-hooks/pre-push in the CURRENT',
    '# worktree. Branches or worktrees that lack that file are unaffected.',
    '#',
    '# To bypass: git push --no-verify',
    '',
    'toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0',
    'hook="$toplevel/scripts/git-hooks/pre-push"',
    'if [ -f "$hook" ]; then',
    '  exec sh "$hook" "$@"',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  // Skip in CI.
  if (process.env['CI']) {
    return;
  }

  // Skip when not in a git work tree (e.g. npm pack / npm publish outside git).
  if (!insideGitWorkTree()) {
    return;
  }

  let commonDir;
  let topLevel;
  try {
    commonDir = gitCommonDir();
    topLevel = gitTopLevel();
  } catch {
    // Cannot determine git dirs — skip silently.
    return;
  }

  if (!installerBelongsToTopLevel(topLevel)) {
    console.warn('[agent-afk] install-pre-push-hook: package is nested under a different git toplevel; skipping hook install');
    return;
  }

  const hooksPath = configuredHooksPath();
  if (hooksPath) {
    console.warn(`[agent-afk] core.hooksPath is configured (${hooksPath}); skipping pre-push hook install`);
    return;
  }

  const hooksDir = join(commonDir, 'hooks');
  const hookPath = join(hooksDir, 'pre-push');
  const content = launcherContent();

  // Ensure hooks directory exists.
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (!existing.includes(MARKER)) {
      // Foreign hook — warn and leave it alone.
      console.warn(
        `[agent-afk] pre-push hook already exists at ${hookPath} without our marker.\n` +
          '  Not overwriting. To install the agent-afk launcher, back up the existing hook\n' +
          '  and re-run: node scripts/install-pre-push-hook.mjs',
      );
      return;
    }
    // Our hook — check if content changed.
    if (existing === content) {
      return; // Already up-to-date; idempotent.
    }
  }

  writeFileSync(hookPath, content, 'utf8');
  chmodSync(hookPath, 0o755);
  console.log(`[agent-afk] installed pre-push launcher → ${hookPath}`);
}

try {
  main();
} catch (err) {
  // Never fail pnpm install.
  console.warn('[agent-afk] install-pre-push-hook: non-fatal error during install:', err?.message ?? err);
}
