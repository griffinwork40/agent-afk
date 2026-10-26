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

/** Matches static import/export-from lines (including `import type`). */
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

function isAllowed(relPath: string, specifier: string): boolean {
  return ALLOWED_PAIRS.some(
    (e) => e.file === relPath && specifier.includes(e.importContains),
  );
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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
        continue;

      const match = IMPORT_RE.exec(line);
      if (!match) continue;
      const specifier = match[1];
      if (!specifier) continue;

      const imported = importedSegment(absPath, specifier);
      if (!imported) continue;

      const importedLayer = classifyDir(imported);
      if (importedLayer === 'unknown') continue;
      if (importerLayer === importedLayer) continue; // same layer, fine
      if (importerLayer === 'foundation' && importedLayer === 'foundation') continue;

      const rule = checkPair(importerLayer, seg, importedLayer, imported);
      if (!rule) continue;

      if (isAllowed(relPath, specifier)) {
        allowedHits.push({ file: relPath, line: i + 1, rule });
      } else {
        allViolations.push({ file: relPath, line: i + 1, text: line.trim(), rule });
      }
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

main();
