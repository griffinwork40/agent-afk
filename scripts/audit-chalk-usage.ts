#!/usr/bin/env tsx
/**
 * Audit raw `chalk` styling usage in `src/`.
 *
 * Enforces the invariant: styling goes through the centralized semantic palette
 * (`src/cli/palette.ts`) — downstream modules import `palette.success`,
 * `palette.error`, etc. and never reach for raw `chalk.<color>(...)`. CI gate.
 * Mirrors `scripts/audit-env-access.ts` and `scripts/audit-sdk-dependency.ts`.
 *
 * Why: a semantic palette only pays off if tone changes happen in ONE place.
 * Scattered `chalk.green` / `chalk.red` re-introduces the drift the palette
 * exists to eliminate — an audit found ~180 such sites had crept back into
 * src/cli/commands/** before this gate landed.
 *
 * Modes:
 *   (default)   — print every raw styling-chalk site outside the allowlist.
 *                 Non-zero exit on any violation.
 *   --check     — alias of default, for CI clarity.
 *   --list      — list every styling-chalk site (including allowlisted) with
 *                 file:line — useful when a migration misses a spot.
 *
 * What counts as a violation: a `chalk.<method>(...)` styling call — any color
 * (`green`, `red`, `hex`, `rgb`, `bgRgb`, `blackBright`, …) or modifier
 * (`bold`, `dim`, `italic`, `inverse`, …), including chained forms like
 * `chalk.bold.white(...)`. Deliberately NOT flagged:
 *   - `chalk.level` reads/writes — the color-capability switch, not styling.
 *   - `import type { ChalkInstance } from 'chalk'` — a type, not a call.
 *   - Full-comment lines — prose mentioning chalk is not code.
 *
 * Allowlist contract: the handful of files that legitimately own raw chalk —
 * the palette itself, the sanctioned tool-category palette extension, and the
 * cases the palette structurally can't cover (per-pixel art, dynamic runtime
 * hexes). Each entry carries an inline rationale. Keep the list small.
 *
 * Failure mode is intentional: drift fails CI loudly, not silently.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SCAN_ROOT = path.join(repoRoot, 'src');

/**
 * Files allowed to use raw `chalk.<styler>(...)` directly. Each needs a
 * rationale; new entries should be rare. When in doubt, route through
 * `src/cli/palette.ts` instead.
 */
const ALLOWED_FILES: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'src/cli/palette.ts',
    reason: 'THE palette — the canonical styling source every role wraps.',
  },
  {
    file: 'src/cli/tool-category.ts',
    reason:
      'Sanctioned palette extension: per-tool-category hues colocated with their glyphs (CATEGORY_GLYPH). See the module header for why these live here, not in palette.ts.',
  },
  {
    file: 'src/cli/mascot.ts',
    reason:
      'Per-pixel truecolor sprite art — chalk.rgb/bgRgb over a private RGB pixel map. A single flat palette role cannot express per-pixel color.',
  },
  {
    file: 'src/cli/render/welcome-banner.ts',
    reason: 'ASCII banner gradient — chalk.rgb per row over a truecolor stop ramp. Banner art, not chrome.',
  },
  {
    file: 'src/cli/trusted-skill-badge.ts',
    reason: 'chalk.hex(entry.color) where the hex is a data-driven per-skill registry value resolved at runtime — no fixed role fits.',
  },
  {
    file: 'src/utils/prompt-secret.ts',
    reason:
      'Leaf util (src/utils) with two error-styling sites; importing src/cli/palette.ts would invert the util→cli dependency direction. Low-traffic, non-TTY secret-prompt path.',
  },
];

interface Violation {
  file: string;
  line: number;
  text: string;
  method: string;
}

/**
 * Matches `chalk.<method>` where <method> is not `level`. Catches the first
 * method of a chain (`chalk.bold.white(` → `bold`), color methods, and
 * factory methods (`hex`, `rgb`, `bgRgb`). The negative lookahead exempts the
 * `chalk.level` capability switch (color on/off), which is config, not styling.
 */
const CHALK_STYLE_RE = /\bchalk\s*\.\s*(?!level\b)([A-Za-z][A-Za-z0-9]*)/g;

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

function isAllowedFile(relPath: string): boolean {
  return ALLOWED_FILES.some((entry) => entry.file === relPath);
}

function scan(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');
  const rel = path.relative(repoRoot, file);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    // Skip full-comment lines: prose that mentions `chalk.foo` is not code.
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    CHALK_STYLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CHALK_STYLE_RE.exec(line)) !== null) {
      violations.push({ file: rel, line: i + 1, text: line.trim(), method: match[1] ?? '?' });
    }
  }
  return violations;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const listMode = args.has('--list');

  const files: string[] = [];
  walk(SCAN_ROOT, files);

  const allViolations: Violation[] = [];
  const allowedHits: Violation[] = [];

  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const v = scan(file, fs.readFileSync(file, 'utf8'));
    if (v.length === 0) continue;
    if (isAllowedFile(rel)) allowedHits.push(...v);
    else allViolations.push(...v);
  }

  if (listMode) {
    console.log(`\n=== All raw chalk styling sites in src/ ===`);
    console.log(`Allowlisted: ${allowedHits.length} site(s)`);
    for (const h of allowedHits) console.log(`  ${h.file}:${h.line} → chalk.${h.method}`);
    console.log(`Other: ${allViolations.length} site(s)`);
    for (const h of allViolations) console.log(`  ${h.file}:${h.line} → chalk.${h.method}`);
  }

  if (allViolations.length === 0) {
    console.log(
      `✓ audit-chalk-usage: ${files.length} files scanned, ${allowedHits.length} legitimate raw-chalk sites inside allowlist, 0 violations.`,
    );
    process.exit(0);
  }

  console.error(`\n✗ audit-chalk-usage: ${allViolations.length} raw chalk styling call(s) outside the palette:\n`);
  const byFile = new Map<string, Violation[]>();
  for (const v of allViolations) {
    const existing = byFile.get(v.file);
    if (existing) existing.push(v);
    else byFile.set(v.file, [v]);
  }
  for (const [file, vs] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.error(`  ${file}`);
    for (const v of vs) {
      console.error(`    L${v.line}: chalk.${v.method}(...)`);
      console.error(`         ${v.text}`);
    }
    console.error('');
  }
  console.error('Fix:');
  console.error('  1. Replace raw chalk with a semantic role from src/cli/palette.ts:');
  console.error("     import { palette } from '<path>/palette.js';");
  console.error('     palette.success(x)  // ← was: chalk.green(x)');
  console.error('     palette.error(x)    // ← was: chalk.red(x)');
  console.error('     palette.warning(x)  // ← was: chalk.yellow(x)');
  console.error('     palette.meta(x)     // ← was: chalk.gray(x)');
  console.error('     palette.heading(x)  // ← was: chalk.bold(<section title>) / chalk.cyan.bold(x)');
  console.error('  2. If the palette lacks a fitting role, add one to src/cli/palette.ts (keep it semantic).');
  console.error('  3. If this is a genuinely uncoverable case (per-pixel art, dynamic runtime hex), add the');
  console.error('     file to ALLOWED_FILES in scripts/audit-chalk-usage.ts with a rationale.\n');
  process.exit(1);
}

main();
