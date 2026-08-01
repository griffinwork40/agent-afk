/**
 * Fail-closed assertion that no prompt read survived inlining (#776).
 *
 * Invariant: this runs against the PREPARED SOURCE TREE, not `dist/*.mjs`. The
 * issue suggested grepping the bundle, and that was reconsidered deliberately:
 * inlined prompt bodies land in the bundle as template literals, and several of
 * this repo's prompts contain code examples — including `readFileSync` and `.md`
 * filenames — so a proximity grep over minified output would false-positive on
 * prompt CONTENT and fail a correct build. Minification also renames local
 * bindings, making the call shape unreliable to match.
 *
 * The prepared tree has neither problem: it is unminified TypeScript, every
 * inlining pass has already run, and a surviving `readFileSync(...'.md')` there is
 * unambiguously an escape. Checking one layer earlier is strictly more reliable
 * and catches Pattern A, B and C escapes uniformly.
 *
 * Contract: throws with every offending file:line on the first failure; returns
 * the number of files scanned otherwise. Never mutates anything.
 *
 * @module scripts/assert-inlined-prompts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Any `readFileSync` call naming a `.md` path, in any quote style. Deliberately
 * broader than the inliner's own resolver pattern: this is the backstop, so it
 * must catch shapes the resolver never claimed to handle.
 */
const SURVIVING_MD_READ = /readFileSync\([^)]{0,400}?\.md['"`]/g;

/**
 * Invariant: only a read anchored to the MODULE'S OWN directory is in scope.
 * Plenty of legitimate runtime `.md` reads exist and must not fail the build —
 * `/changelog` reads the user's repo `CHANGELOG.md`, `user-skills.ts` reads
 * user-authored `SKILL.md` from disk, and tests read temp fixtures. Those target
 * files on the USER's disk, which the package never ships and never should.
 * A `__dirname`/`here` anchor is what distinguishes "this file must be inside the
 * published package" from "this path belongs to the user" — an unanchored scan
 * flagged 13 correct call sites on the first run.
 */
function isPackageRelativeRead(callText) {
  return /__dirname|\bhere\b/.test(callText);
}

function walkTsFiles(dir, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, onFile);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) onFile(full);
  }
}

/**
 * @param {string} preparedSrc Root of the prepared (post-inlining) source tree.
 * @returns {number} Files scanned.
 */
export function assertNoRemainingPromptReads(preparedSrc) {
  const offenders = [];
  let scanned = 0;

  walkTsFiles(preparedSrc, (filePath) => {
    scanned++;
    const content = readFileSync(filePath, 'utf-8');
    if (!content.includes('readFileSync')) return;
    for (const match of content.matchAll(SURVIVING_MD_READ)) {
      if (!isPackageRelativeRead(match[0])) continue;
      const line = content.slice(0, match.index).split('\n').length;
      offenders.push(
        `  ${relative(preparedSrc, filePath)}:${line}  ${match[0].replace(/\s+/g, ' ').slice(0, 120)}`,
      );
    }
  });

  if (offenders.length > 0) {
    throw new Error(
      `[assert-inlined-prompts] ${offenders.length} prompt read(s) survived inlining:\n` +
        `${offenders.join('\n')}\n` +
        `  These would ship as runtime reads of .md files that are NOT in the published\n` +
        `  package, failing only when a user runs the published artifact. Either make the\n` +
        `  path a string literal the inliner can resolve, or extend the inliner to handle\n` +
        `  the shape. See scripts/esbuild-plugin-inline-prompts.mjs.`,
    );
  }

  return scanned;
}
