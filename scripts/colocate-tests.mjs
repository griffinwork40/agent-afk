#!/usr/bin/env node
/**
 * Move unit tests from tests/ into co-located positions alongside src/.
 *
 * Rules
 * -----
 * - tests/<rel>/X.test.ts -> src/<rel>/X.test.ts when src/<rel>/ exists.
 * - tests/<file>.test.ts (root-level) routed via SPECIAL_CASES below.
 * - tests/integration/, tests/e2e/ are left in place.
 * - tests/helpers/test-utils.ts        -> src/__test-utils__/test-utils.ts
 * - tests/agent/fixtures/mock-provider.ts -> src/agent/__fixtures__/mock-provider.ts
 *
 * Import rewrite
 * --------------
 * For each moved test, rewrite import paths of the form
 *   '../../../src/foo/bar.js'  or  "../../../src/foo/bar.js"
 * into a relative path from the file's new location.
 * Imports that don't reference '../../../src/' (or any '../**\/src/') are left alone.
 *
 * History
 * -------
 * Uses `git mv` so renames are tracked.
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const DRY_RUN = process.argv.includes('--dry-run');

/** Tests that don't mirror a single src path — route by hand. */
const SPECIAL_CASES = new Map([
  ['tests/changelog.test.ts',         'src/changelog.test.ts'],
  ['tests/paths.test.ts',             'src/paths.test.ts'],
  ['tests/config.test.ts',            'src/cli/config.test.ts'],
  ['tests/entry.test.ts',             'src/index.test.ts'],
  ['tests/separation.test.ts',        'src/agent/daemon/separation.test.ts'],
  ['tests/paths-separation.test.ts',  'src/paths-separation.test.ts'],
  ['tests/project-scope.test.ts',     'src/skills/project-scope.test.ts'],
  ['tests/plugins-scanner.test.ts',   'src/agent/plugins-scanner.test.ts'],
  ['tests/helpers/test-utils.ts',     'src/__test-utils__/test-utils.ts'],
  ['tests/agent/fixtures/mock-provider.ts', 'src/agent/__fixtures__/mock-provider.ts'],
]);

/** Directories whose contents stay in tests/ as-is. */
const KEEP_PREFIXES = ['tests/integration/', 'tests/e2e/'];

function gitListFiles() {
  const out = execSync('git ls-files tests', { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function planTarget(srcPath) {
  if (KEEP_PREFIXES.some((p) => srcPath.startsWith(p))) return null;
  if (SPECIAL_CASES.has(srcPath)) return SPECIAL_CASES.get(srcPath);

  // Default: tests/<rel> -> src/<rel>
  if (!srcPath.startsWith('tests/')) return null;
  const rel = srcPath.slice('tests/'.length);
  return `src/${rel}`;
}

/**
 * Rewrite relative imports inside a moved file.
 *
 * Strategy: for each ('...'|"...") string literal that LOOKS like a relative
 * import (starts with ./ or ../), resolve it against the OLD absolute path of
 * the file. Then, if that resolved target was itself moved (per `moveMap`),
 * remap to the NEW target. Finally, re-express the path as a relative spec
 * from the file's NEW directory.
 *
 * This correctly handles:
 *   - '../../../src/foo.js'  (target unchanged, depth changes)
 *   - './fixtures/mock-provider.js'  (target itself moves to __fixtures__/)
 *   - '../helpers/test-utils.js'    (only the import-site moves, target also moves)
 *
 * Non-relative imports ('vitest', 'node:fs', etc.) are passed through.
 */
function rewriteImports(content, oldAbsFile, newAbsFile, moveMap) {
  const oldDir = dirname(oldAbsFile);
  const newDir = dirname(newAbsFile);

  // Helper to remap one spec string.
  const remap = (spec) => {
    const resolvedAbs = join(oldDir, spec);
    const remappedAbs = moveMap.get(resolvedAbs) ?? resolvedAbs;
    let rel = relative(newDir, remappedAbs);
    rel = rel.split(/[\\/]/).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
  };

  // Only rewrite literals in IMPORT-LIKE positions. We anchor on the leading
  // syntax to avoid touching data-literal strings inside the test body.
  //
  // Patterns covered:
  //   from '...'                  — static import/export
  //   import '...'                — bare side-effect import
  //   import('...')               — dynamic import
  //   require('...')              — CJS (rare in this repo, harmless)
  //   vi.mock('...', ...)         — vitest mock
  //   vi.doMock('...', ...)       — vitest dynamic mock
  //   vi.importActual('...')      — vitest helpers
  //   vi.importMock('...')
  //
  // The capture groups are: (prefix)(quote)(spec)(quote)
  const patterns = [
    // `from '...'` (handles `} from '...'`, `* from '...'`, etc.)
    /(\bfrom\s+)(['"])(\.\.?\/[^'"]*)\2/g,
    // bare `import '...'` (no `from`)
    /(\bimport\s+)(['"])(\.\.?\/[^'"]*)\2/g,
    // `import('...')`
    /(\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]*)\2/g,
    // `require('...')`
    /(\brequire\s*\(\s*)(['"])(\.\.?\/[^'"]*)\2/g,
    // `vi.mock('...')`, `vi.doMock('...')`, `vi.importActual('...')`, `vi.importMock('...')`
    /(\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*)(['"])(\.\.?\/[^'"]*)\2/g,
  ];

  let next = content;
  for (const re of patterns) {
    next = next.replace(re, (_full, prefix, quote, spec) => {
      return `${prefix}${quote}${remap(spec)}${quote}`;
    });
  }
  return next;
}

function ensureDir(absDir) {
  if (!existsSync(absDir)) {
    if (DRY_RUN) {
      console.log(`  mkdir -p ${relative(repoRoot, absDir)}`);
    } else {
      mkdirSync(absDir, { recursive: true });
    }
  }
}

function gitMv(from, to) {
  const cmd = `git mv "${from}" "${to}"`;
  if (DRY_RUN) {
    console.log(`  ${cmd}`);
  } else {
    execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
  }
}

function main() {
  const files = gitListFiles();
  const moves = [];
  const skipped = [];

  for (const f of files) {
    const target = planTarget(f);
    if (!target) {
      skipped.push(f);
      continue;
    }
    moves.push({ from: f, to: target });
  }

  // Sanity: no two moves land on the same target.
  const targetSet = new Set();
  for (const m of moves) {
    if (targetSet.has(m.to)) {
      throw new Error(`Target collision: ${m.to}`);
    }
    targetSet.add(m.to);
    if (existsSync(join(repoRoot, m.to))) {
      throw new Error(`Target already exists: ${m.to}`);
    }
  }

  console.log(`Plan: ${moves.length} files to move, ${skipped.length} kept in place.`);
  console.log('Kept in tests/:');
  for (const s of skipped) console.log(`  - ${s}`);
  console.log('');

  // Build map of OLD-absolute-path -> NEW-absolute-path for both .ts and .js specs.
  // Imports use '.js' extensions (ESM-style) even when source is '.ts', so we
  // register BOTH the .ts source path and a '.js' alias, both pointing at the
  // NEW .ts location (rewriter just needs the new dir).
  const moveMap = new Map();
  for (const { from, to } of moves) {
    const oldAbs = join(repoRoot, from);
    const newAbs = join(repoRoot, to);
    moveMap.set(oldAbs, newAbs);
    // Also register the .js alias the test source uses in import specs.
    if (oldAbs.endsWith('.ts')) {
      moveMap.set(oldAbs.replace(/\.ts$/, '.js'), newAbs.replace(/\.ts$/, '.js'));
    }
  }

  // Execute moves
  for (const { from, to } of moves) {
    const toAbs = join(repoRoot, to);
    ensureDir(dirname(toAbs));
    gitMv(from, to);
  }

  // Rewrite imports in moved files
  if (!DRY_RUN) {
    for (const { from, to } of moves) {
      const oldAbs = join(repoRoot, from);
      const newAbs = join(repoRoot, to);
      const content = readFileSync(newAbs, 'utf8');
      const next = rewriteImports(content, oldAbs, newAbs, moveMap);
      if (next !== content) writeFileSync(newAbs, next);
    }
  }

  // Rewrite imports in retained files that still reference moved targets.
  // Currently this is only tests/integration/test-utils.test.ts -> ../helpers/test-utils.js.
  const retainedToRewrite = [
    'tests/integration/test-utils.test.ts',
    'tests/integration/cli-agent-integration.test.ts',
    'tests/integration/telegram-agent-integration.test.ts',
    'tests/e2e/cli-workflow.test.ts',
    'tests/e2e/performance.test.ts',
  ];
  if (!DRY_RUN) {
    for (const rel of retainedToRewrite) {
      const abs = join(repoRoot, rel);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, 'utf8');
      // For retained files, OLD and NEW abs paths are identical.
      const next = rewriteImports(content, abs, abs, moveMap);
      if (next !== content) writeFileSync(abs, next);
    }
  }

  console.log(`\nDone. Moved ${moves.length} files.`);
  if (DRY_RUN) console.log('(dry run — no changes written)');
}

main();
