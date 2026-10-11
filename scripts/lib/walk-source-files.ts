/**
 * Shared predicate-driven source-file walker for audit/check scripts.
 *
 * Seven scripts previously each defined their own `walk()` function with the
 * same structure: recurse a directory, skip excluded dirs, and push paths that
 * pass a per-script file predicate. This module consolidates that into a single
 * exported function.
 *
 * Contract: pure recursive FS walk — no I/O beyond `fs.readdirSync` /
 * `fs.existsSync`, no side effects, no `process.exit`. Callers supply the
 * predicate; this module owns only the traversal logic.
 *
 * Default excluded dirs: `node_modules`, `dist`, and any dir starting with `.`
 * (e.g. `.git`, `.afk`). Callers may supply additional dirs to exclude via
 * `extraExcludeDirs`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Named dirs excluded from traversal by default.
 *
 * Note: dot-prefixed dirs (`.git`, `.afk`, etc.) are excluded by a separate
 * `entry.name.startsWith('.')` check in `walkSourceFiles` — they are NOT
 * listed here (finding #3319-nit).
 */
const DEFAULT_EXCLUDED_DIRS = new Set(['node_modules', 'dist']);

/**
 * Walk `dir` recursively, pushing every file that satisfies `predicate` into
 * `out`.
 *
 * @param dir              Absolute directory to walk.
 * @param predicate        Return `true` to include a file. Receives the
 *                         absolute path as first argument and the `fs.Dirent`
 *                         as second.
 * @param out              Accumulator — collected paths are appended here.
 * @param extraExcludeDirs Additional directory names to skip (merged with the
 *                         defaults). Dot-prefixed dirs are always skipped.
 */
export function walkSourceFiles(
  dir: string,
  predicate: (absPath: string, entry: fs.Dirent) => boolean,
  out: string[],
  extraExcludeDirs: ReadonlySet<string> = new Set(),
): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name.startsWith('.') ||
        DEFAULT_EXCLUDED_DIRS.has(entry.name) ||
        extraExcludeDirs.has(entry.name)
      ) {
        continue;
      }
      walkSourceFiles(full, predicate, out, extraExcludeDirs);
    } else if (entry.isFile() && predicate(full, entry)) {
      out.push(full);
    }
  }
}

// ── Violation grouping helper ────────────────────────────────────────────────

/**
 * Group an array of violation objects by their `file` property, returning a
 * `Map<string, V[]>` sorted by filename.
 *
 * Previously duplicated at `audit-chalk-usage.ts:186`, `check-terminal-width.ts:154`,
 * and `audit-env-access.ts:295`. Each script's error-printing loop uses the same
 * grouping pattern; extracting it here removes the boilerplate without touching
 * the per-script rendering (each script prints violation details differently).
 *
 * @param violations  Flat violation list; items must have a `file` string field.
 */
export function groupViolationsByFile<V extends { file: string }>(
  violations: V[],
): Map<string, V[]> {
  const byFile = new Map<string, V[]>();
  for (const v of violations) {
    const existing = byFile.get(v.file);
    if (existing) existing.push(v);
    else byFile.set(v.file, [v]);
  }
  // Sort the map keys so the output is deterministic across runs.
  return new Map([...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ── Ready-made predicates ────────────────────────────────────────────────────

/**
 * Accepts non-test TypeScript production files (`*.ts`, not `*.test.ts` or
 * `*.spec.ts`). Used by chalk, terminal-width, env-access, and module-state
 * audit scripts.
 */
export function isProdTs(absPath: string): boolean {
  const base = path.basename(absPath);
  return base.endsWith('.ts') && !base.endsWith('.test.ts') && !base.endsWith('.spec.ts');
}

/**
 * Accepts all TypeScript files (`*.ts`, including tests). Used by the SDK
 * dependency scanner which needs to inspect test imports too.
 */
export function isAnyTs(absPath: string): boolean {
  return path.basename(absPath).endsWith('.ts');
}
