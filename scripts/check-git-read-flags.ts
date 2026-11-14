#!/usr/bin/env tsx
/**
 * Enforce `--no-optional-locks` on every git read-command invocation in src/.
 * CI gate. Mirrors `scripts/audit-chalk-usage.ts`.
 *
 * Invariant: every call site that invokes a git read subcommand must include
 * `--no-optional-locks` (or `GIT_OPTIONAL_LOCKS=0` in the environment) in the
 * same invocation context. Without it `git status`, `git diff`, etc. take an
 * index.lock that causes spurious failures when two afk sessions work on the
 * same repo simultaneously.
 *
 * Why grep, not AST: the call sites use a handful of wrapper shapes
 * (execFile, execFileSync, a local `git()` helper) and the flag always
 * appears as a string literal in the same array/call. A line-oriented regex
 * over the raw source is sufficient and keeps the script simple.
 *
 * What counts as a violation:
 *   A line that contains a git read subcommand token
 *   ('status', 'diff', 'log', 'show', 'blame', 'branch', 'tag',
 *    'rev-parse', 'ls-files', 'ls-tree', 'rev-list')
 *   AND also contains a recognizable git-invocation marker
 *   (execFile, execFileSync, spawnSync, or the bare pattern `'git'` / `"git"`)
 *   but does NOT contain '--no-optional-locks' or 'GIT_OPTIONAL_LOCKS'
 *   anywhere on that line or within 3 lines above it (same array / call block).
 *
 * Exclusions:
 *   - Test files (*.test.ts, *.spec.ts)
 *   - Declaration files (*.d.ts)
 *   - __fixtures__ and __test-utils__ directories
 *   - dist/ directory
 *   - src/agent/tools/handlers/git-read.ts (canonical correct implementation)
 *   - src/agent/subagent/continuation-guards.ts (delegates to GIT_READ_GLOBAL_ARGS)
 *   - Lines that are full-line comments
 *   - Lines inside a block that already carries --no-optional-locks nearby
 *
 * Modes:
 *   (default) / --check   scan and exit non-zero on any violation
 *   --list                print all matched git-call lines (including clean ones)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkSourceFiles, groupViolationsByFile } from './lib/walk-source-files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SCAN_ROOT = path.join(repoRoot, 'src');

// ── Git read subcommands that take index.lock ─────────────────────────────────

const READ_SUBCOMMANDS: readonly string[] = [
  'status', 'diff', 'log', 'show', 'blame',
  'branch', 'tag', 'rev-parse', 'ls-files', 'ls-tree', 'rev-list',
];

// Regex: a quoted git read subcommand token as a standalone string literal.
// Matches 'status' or "status" (single or double quote delimiters).
const SUBCMD_RE = new RegExp(
  "(?:'|\")(?:" + READ_SUBCOMMANDS.join('|') + ")(?:'|\")",
);

// Regex: markers indicating this line is part of a git invocation.
// Covers: execFile, execFileSync, spawnSync, spawn, the local git() helpers,
// and bare 'git' / "git" string literals used as the first arg to those helpers.
const GIT_INVOKE_RE =
  /execFile|execFileSync|spawnSync|\bspawn\b|'git'|"git"|\bgit\s*\(/;

// The flag we require.
const LOCK_FLAG_RE = /--no-optional-locks|GIT_OPTIONAL_LOCKS/;

// ── Files excluded from violation reporting ───────────────────────────────────

/**
 * Files that are known-correct implementations or delegates and must never be
 * flagged. Paths are relative to repoRoot.
 */
const EXCLUDED_FILES: ReadonlySet<string> = new Set([
  'src/agent/tools/handlers/git-read.ts',
  'src/agent/subagent/continuation-guards.ts',
]);

// ── File predicate ────────────────────────────────────────────────────────────

function isTarget(absPath: string): boolean {
  const base = path.basename(absPath);
  if (!base.endsWith('.ts')) return false;
  if (base.endsWith('.test.ts') || base.endsWith('.spec.ts')) return false;
  if (base.endsWith('.d.ts')) return false;
  return true;
}

// ── Per-file scanner ──────────────────────────────────────────────────────────

export interface Violation {
  file: string;   // repo-relative
  line: number;   // 1-based
  text: string;   // trimmed source line
  subcommand: string;
}

// Write-mode flags that make branch/tag/log etc. into mutating commands.
// A line containing one of these after the subcommand is not a read and
// should not be flagged (branch -d, branch -D, branch -m, tag -d, etc.).
const WRITE_FLAGS_RE = /['"]-[dDmMf]['"]|--delete\b|--move\b|--force\b|--set-upstream/;

/**
 * Scan one file for git read invocations missing `--no-optional-locks`.
 *
 * Context window: when a violation candidate is found on line N, we also check
 * the 3 lines immediately above it (lines N-3..N-1). If any of those lines
 * contain the lock flag, the call site is considered covered (the flag lives
 * in a shared args array declared above the call).
 */
export function scanFile(absPath: string, source: string): Violation[] {
  const rel = path.relative(repoRoot, absPath);
  if (EXCLUDED_FILES.has(rel)) return [];

  const lines = source.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trimStart();

    // Skip full-line comments.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Must contain a git read subcommand string literal.
    if (!SUBCMD_RE.test(line)) continue;

    // Must also look like a git invocation (not just a string in a comment or schema).
    if (!GIT_INVOKE_RE.test(line)) continue;

    // Extract which subcommand matched (for the violation message).
    const subcmdMatch = SUBCMD_RE.exec(line);
    const subcommand = subcmdMatch ? subcmdMatch[0].replace(/['"]/g, '') : '?';

    // Skip write-mode invocations (branch -d, branch -D, tag -d, etc.).
    if (WRITE_FLAGS_RE.test(line)) continue;

    // Check this line and the 3 lines above for the lock flag.
    const windowStart = Math.max(0, i - 3);
    const window = lines.slice(windowStart, i + 1);
    const covered = window.some((l) => LOCK_FLAG_RE.test(l));
    if (covered) continue;

    violations.push({ file: rel, line: i + 1, text: trimmed, subcommand });
  }

  return violations;
}

// ── Walk + collect ────────────────────────────────────────────────────────────

function collectAll(): { violations: Violation[]; fileCount: number; hitCount: number } {
  const files: string[] = [];
  const extraExclude = new Set(['__fixtures__', '__test-utils__', 'dist']);
  walkSourceFiles(SCAN_ROOT, isTarget, files, extraExclude);

  const violations: Violation[] = [];
  let hitCount = 0;

  for (const absPath of files) {
    const source = fs.readFileSync(absPath, 'utf8');
    const v = scanFile(absPath, source);
    if (v.length > 0) hitCount++;
    violations.push(...v);
  }

  return { violations, fileCount: files.length, hitCount };
}

// ── Entry point ───────────────────────────────────────────────────────────────

function main(): void {
  const args = new Set(process.argv.slice(2));
  const listMode = args.has('--list');

  const { violations, fileCount } = collectAll();

  if (listMode) {
    if (violations.length === 0) {
      console.log('check-git-read-flags: no git read-command sites missing --no-optional-locks.');
    } else {
      console.log(`\ncheck-git-read-flags: ${violations.length} site(s) missing --no-optional-locks:\n`);
      for (const [file, vs] of groupViolationsByFile(violations)) {
        console.log(`  ${file}`);
        for (const v of vs) {
          console.log(`    L${v.line} [${v.subcommand}]: ${v.text}`);
        }
      }
    }
    return;
  }

  if (violations.length === 0) {
    console.log(
      `✓ check-git-read-flags: ${fileCount} files scanned, ` +
        `0 git read-command sites missing --no-optional-locks.`,
    );
    process.exit(0);
  }

  console.error(
    `\n✗ check-git-read-flags: ${violations.length} git read-command invocation(s) ` +
      `missing --no-optional-locks:\n`,
  );

  for (const [file, vs] of groupViolationsByFile(violations)) {
    console.error(`  ${file}`);
    for (const v of vs) {
      console.error(`    ${file}:${v.line} [${v.subcommand}]`);
      console.error(`      ${v.text}`);
    }
    console.error('');
  }

  console.error('Fix:');
  console.error('  Pass --no-optional-locks as a global git flag before the subcommand:');
  console.error("    execFile('git', ['--no-optional-locks', 'status', '--porcelain'], ...)");
  console.error('  Or reuse the canonical constant:');
  console.error("    import { GIT_READ_GLOBAL_ARGS } from '.../git-read.js';");
  console.error("    execFile('git', [...GIT_READ_GLOBAL_ARGS, 'status', '--porcelain'], ...)");
  console.error(
    '  Rationale: without this flag, git status/diff/log take an index.lock that causes\n' +
      '  spurious failures when two afk sessions run on the same repo simultaneously.\n',
  );

  process.exit(1);
}

main();
