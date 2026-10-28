#!/usr/bin/env tsx
/**
 * Audit cross-layer import violations in `src/`.
 *
 * Enforces the three-layer architecture:
 *
 *   Foundation  ←  Core/Infrastructure  ←  Surfaces / Features
 *
 * | Layer              | Directories / files                                       |
 * |--------------------|-----------------------------------------------------------|
 * | Foundation         | config/, utils/, src/paths*.ts (top-level)                |
 * | Core/Infra         | agent/, browser/, http-client/, remote/, service/,        |
 * |                    | skills/, bundled-plugins/                                 |
 * | Surfaces           | cli/, telegram/, web-server/                              |
 * | Features           | improve/, insights/, whatif/                              |
 *
 * Allowed direction:  Foundation ← Core/Infra ← Surfaces/Features
 * Forbidden:
 *   Rule 1 — Core/Infra importing Surfaces  (e.g. agent/ → cli/, agent/ → telegram/)
 *   Rule 2 — Foundation importing Core/Infra, Surfaces, or Features
 *             (paths*.ts is Foundation, so config/ → paths*.ts is fine)
 *   Rule 3 — Features importing Surfaces    (e.g. whatif/ → cli/)
 *
 * Pre-existing violations are allowlisted in audit-layer-imports.allowlist.ts.
 * Add new entries there with a rationale and tracking issue; keep this file
 * focused on detection logic only.
 *
 * Mirrors scripts/audit-chalk-usage.ts and scripts/audit-env-access.ts.
 *
 * Modes:
 *   (default)  — print every violation outside the allowlist. Non-zero exit.
 *   --check    — alias of default, for CI clarity.
 *   --list     — list every cross-layer import (including allowlisted).
 *
 * Failure mode is intentional: drift fails CI loudly, not silently.
 * Decision fact #3548. Tracked by issue #4457.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupViolationsByFile, isAnyTs, walkSourceFiles } from './lib/walk-source-files.js';
import { ALLOWED_PAIRS } from './audit-layer-imports.allowlist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SCAN_ROOT = path.join(repoRoot, 'src');

// ── Layer membership ──────────────────────────────────────────────────────────

const SURFACE_DIRS = new Set(['cli', 'telegram', 'web-server']);
const CORE_INFRA_DIRS = new Set([
  'agent',
  'browser',
  'http-client',
  'remote',
  'service',
  'skills',
  'bundled-plugins',
]);
const FOUNDATION_DIRS = new Set(['config', 'utils']);
const FEATURE_DIRS = new Set(['improve', 'insights', 'whatif']);

/** Top-level src/ files whose basename starts with this prefix are Foundation. */
const FOUNDATION_TOP_LEVEL_PREFIX = 'paths';

// ── Layer classification ──────────────────────────────────────────────────────

type Layer = 'foundation' | 'core-infra' | 'surface' | 'feature' | 'unknown';

function classifyDir(dirOrBasename: string): Layer {
  if (FOUNDATION_DIRS.has(dirOrBasename)) return 'foundation';
  if (dirOrBasename.startsWith(FOUNDATION_TOP_LEVEL_PREFIX)) return 'foundation';
  if (CORE_INFRA_DIRS.has(dirOrBasename)) return 'core-infra';
  if (SURFACE_DIRS.has(dirOrBasename)) return 'surface';
  if (FEATURE_DIRS.has(dirOrBasename)) return 'feature';
  return 'unknown';
}

/**
 * Return the src/ "segment" for a repo-relative file path:
 *   - subdirectory name for src/<dir>/... files
 *   - file's own basename for top-level src/ files (e.g. "paths.ts")
 */
function srcSegment(relPath: string): string | undefined {
  const parts = relPath.split('/');
  if (parts[0] !== 'src') return undefined;
  if (parts.length < 2) return undefined;
  return parts[1]; // subdirectory OR top-level filename
}

/**
 * Resolve a relative import specifier to the src/ segment it targets.
 * Returns undefined for third-party imports (no leading dot) or paths
 * that resolve outside src/.
 */
function importedSegment(importerAbsPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const importerDir = path.dirname(importerAbsPath);
  const resolved = path.resolve(importerDir, specifier);
  const rel = path.relative(SCAN_ROOT, resolved);
  if (rel.startsWith('..')) return undefined;
  const parts = rel.split('/');
  return parts[0];
}

// ── Violation detection ───────────────────────────────────────────────────────

/**
 * Collect a logical import statement that may span multiple lines.
 *
 * TypeScript allows multiline import bindings:
 *   import {
 *     Foo,
 *     Bar,
 *   } from '../cli/types.js';
 *
 * The opening line ends with `{` (no closing `}` before `from`), so we
 * accumulate continuation lines until we find the closing `}` on the same
 * line as `from '...'`.  Returns the joined single-line representation and
 * the number of raw lines consumed (so the caller can advance `i`).
 */
export function collectLogicalLine(lines: string[], startIdx: number): { logical: string; consumed: number } {
  const first = lines[startIdx] ?? '';
  // Fast path: complete on one line (no unclosed `{` before `from`).
  // An unclosed `{` means the `}` appears on a later line.
  const openBrace = first.indexOf('{');
  const closeBrace = first.indexOf('}');
  if (openBrace === -1 || closeBrace > openBrace) {
    return { logical: first, consumed: 1 };
  }

  // Multiline: accumulate until a line contains `} from '...'`.
  const parts: string[] = [first.trimEnd()];
  let j = startIdx + 1;
  while (j < lines.length) {
    const continuation = lines[j] ?? '';
    parts.push(continuation.trimEnd());
    // Stop once we see the closing `}` followed (eventually) by `from`.
    if (/\}.*from\s+['"]/.test(continuation)) {
      break;
    }
    j++;
  }
  return { logical: parts.join(' '), consumed: j - startIdx + 1 };
}

/** Matches a complete (single-line-normalised) import/export-from statement. */
const IMPORT_RE =
  /^\s*(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\S+|\S+)\s+from\s+['"]([^'"]+)['"]/;

interface Violation {
  file: string;
  line: number;
  text: string;
  rule: string;
}

function checkPair(
  importerLayer: Layer,
  importerDir: string,
  importedLayer: Layer,
  importedDir: string,
): string | null {
  if (importerLayer === 'core-infra' && importedLayer === 'surface') {
    return `Rule 1 (Core/Infra → Surface): ${importerDir}/ imports ${importedDir}/`;
  }
  if (
    importerLayer === 'foundation' &&
    (importedLayer === 'core-infra' ||
      importedLayer === 'surface' ||
      importedLayer === 'feature')
  ) {
    return `Rule 2 (Foundation → ${importedLayer}): ${importerDir}/ imports ${importedDir}/`;
  }
  if (importerLayer === 'feature' && importedLayer === 'surface') {
    return `Rule 3 (Feature → Surface): ${importerDir}/ imports ${importedDir}/`;
  }
  return null;
}

/**
 * Returns true when the (file, specifier) pair is covered by an allowlist entry.
 *
 * Contract: each AllowedPair.importContains value is a directory-segment
 * prefix such as `'cli/'` or `'telegram/'`.  We test whether the specifier
 * contains that prefix as a path segment boundary rather than an arbitrary
 * substring, so `'cli/'` matches `'../cli/palette.js'` but NOT a hypothetical
 * `'../unicli/foo.js'`.
 *
 * History: the original `specifier.includes(e.importContains)` was a plain
 * substring test which could in theory exempt an entire directory class when
 * the importContains string appeared anywhere in the path.  Using an exact
 * path-segment check (the prefix must follow a `/` or `.`) is safer.
 */
export function isAllowed(relPath: string, specifier: string, pairs = ALLOWED_PAIRS): boolean {
  return pairs.some((e) => {
    if (e.file !== relPath) return false;
    const needle = e.importContains;
    // Accept the needle when it appears at a path-segment boundary:
    //   - immediately after a `/`  (e.g. `../cli/foo`)
    //   - at the very start        (e.g. `cli/foo` — bare relative)
    //   - after a `.` segment      (e.g. `./cli/foo`)
    const idx = specifier.indexOf(needle);
    if (idx === -1) return false;
    if (idx === 0) return true;
    const charBefore = specifier[idx - 1];
    return charBefore === '/' || charBefore === '.';
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = new Set(process.argv.slice(2));
  const listMode = args.has('--list');

  const files: string[] = [];
  walkSourceFiles(SCAN_ROOT, (p) => isAnyTs(p), files);

  const allViolations: Violation[] = [];
  const allowedHits: Array<{ file: string; line: number; rule: string }> = [];

  for (const absPath of files) {
    const relPath = path.relative(repoRoot, absPath);
    const seg = srcSegment(relPath);
    if (!seg) continue;
    const importerLayer = classifyDir(seg);
    if (importerLayer === 'unknown') continue;

    const source = fs.readFileSync(absPath, 'utf8');
    const lines = source.split('\n');

    let inBlockComment = false;

    for (let i = 0; i < lines.length; ) {
      const line = lines[i];
      if (line === undefined) { i++; continue; }

      // ── Block-comment state tracking ──────────────────────────────────────
      // Contract: inBlockComment is true from the line that opens `/*` until
      // (and including) the line that closes `*/`.  A line may open and close
      // a block comment (`/* foo */`) — we handle that by checking both.
      if (inBlockComment) {
        if (line.includes('*/')) inBlockComment = false;
        i++;
        continue;
      }
      const trimmed = line.trimStart();
      if (trimmed.startsWith('/*')) {
        // Single-line block comment (`/* ... */`) or start of a multi-line one.
        if (!line.includes('*/')) inBlockComment = true;
        i++;
        continue;
      }
      // Skip line comments and mid-block-comment continuation lines (`* ...`).
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        i++;
        continue;
      }

      // ── Multiline import accumulation ─────────────────────────────────────
      const { logical, consumed } = collectLogicalLine(lines, i);

      const match = IMPORT_RE.exec(logical);
      if (!match) { i += consumed; continue; }
      const specifier = match[1];
      if (!specifier) { i += consumed; continue; }

      const imported = importedSegment(absPath, specifier);
      if (!imported) { i += consumed; continue; }

      const importedLayer = classifyDir(imported);
      if (importedLayer === 'unknown') { i += consumed; continue; }
      if (importerLayer === importedLayer) { i += consumed; continue; }
      if (importerLayer === 'foundation' && importedLayer === 'foundation') { i += consumed; continue; }

      const rule = checkPair(importerLayer, seg, importedLayer, imported);
      if (!rule) { i += consumed; continue; }

      if (isAllowed(relPath, specifier)) {
        allowedHits.push({ file: relPath, line: i + 1, rule });
      } else {
        allViolations.push({ file: relPath, line: i + 1, text: line.trim(), rule });
      }
      i += consumed;
    }
  }

  if (listMode) {
    console.log(`\n=== All cross-layer import sites in src/ ===`);
    console.log(`Allowlisted: ${allowedHits.length} site(s)`);
    for (const h of allowedHits) console.log(`  ${h.file}:${h.line} → ${h.rule}`);
    console.log(`Violations: ${allViolations.length} site(s)`);
    for (const v of allViolations) console.log(`  ${v.file}:${v.line} → ${v.rule}`);
    process.exit(allViolations.length > 0 ? 1 : 0);
  }

  if (allViolations.length === 0) {
    console.log(
      `✓ audit-layer-imports: ${files.length} files scanned, ` +
        `${allowedHits.length} allowlisted cross-layer site(s), 0 violations.`,
    );
    process.exit(0);
  }

  console.error(`\n✗ audit-layer-imports: ${allViolations.length} layer-contract violation(s):\n`);
  for (const [file, vs] of groupViolationsByFile(allViolations)) {
    console.error(`  ${file}`);
    for (const v of vs) {
      console.error(`    L${v.line}: ${v.rule}`);
      console.error(`         ${v.text}`);
    }
    console.error('');
  }
  console.error('Fix:');
  console.error('  1. Move shared types upward into Foundation (src/config/ or src/utils/)');
  console.error('  2. Introduce a Core-layer adapter that the Surface/Feature imports instead');
  console.error('  3. If the violation is genuinely unavoidable, add the file to ALLOWED_PAIRS');
  console.error('     in scripts/audit-layer-imports.allowlist.ts with a rationale and tracking issue.\n');
  process.exit(1);
}

// Run only when executed directly, not when imported by tests.
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('audit-layer-imports.ts') ||
    process.argv[1].endsWith('audit-layer-imports.js'));
if (isMain) main();
