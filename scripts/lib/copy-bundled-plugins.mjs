#!/usr/bin/env node
/**
 * Shared bundled-plugins copy step, used by BOTH build paths:
 *   - scripts/copy-prompts.js  (`pnpm build`     — tsc dev/build output)
 *   - scripts/build-dist.mjs   (`pnpm build:dist` — esbuild publish output)
 *
 * History: the npm-published tarball shipped ZERO bundled skills until this
 * fix, because `build:dist` (the prepublishOnly / CI publish path) never
 * copied src/bundled-plugins/, while `pnpm build` did. The two copy
 * implementations had silently diverged. Routing both through this single
 * helper makes that class of drift structurally impossible: a build script
 * either calls this (and ships the skills) or it does not (and the
 * publish-bundle CI assertion fails). The runtime resolves these files from
 * <dist>/bundled-plugins/ — see src/paths.ts getBundledPluginsDir().
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Recursively copy a directory tree, returning the number of files copied. */
function copyTree(src, dest) {
  let count = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      count += copyTree(srcPath, destPath);
    } else if (entry.isFile()) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

/**
 * Copy <srcRoot>/bundled-plugins → <distRoot>/bundled-plugins (recursively,
 * including non-.md files like .claude-plugin/plugin.json).
 *
 * @param {string} srcRoot   Absolute path to the dir CONTAINING `bundled-plugins/` (e.g. <repo>/src).
 * @param {string} distRoot  Absolute path to the dir that SHOULD contain `bundled-plugins/` (e.g. <repo>/dist).
 * @returns {{ copied: boolean, fileCount: number, src: string, dest: string }}
 *          `copied` is false (fileCount 0) when the source tree is absent — a
 *          no-op that never throws, so callers can decide whether absence is fatal.
 */
export function copyBundledPlugins(srcRoot, distRoot) {
  const src = join(srcRoot, 'bundled-plugins');
  const dest = join(distRoot, 'bundled-plugins');
  if (!existsSync(src)) {
    return { copied: false, fileCount: 0, src, dest };
  }
  const fileCount = copyTree(src, dest);
  return { copied: true, fileCount, src, dest };
}
