#!/usr/bin/env tsx
/**
 * Audit raw `console.log/error/warn` calls bypassing `palette.ts` in user-facing code.
 *
 * Enforces the invariant: console output in `src/cli/commands/` and `src/telegram/`
 * routes through the centralized semantic palette (`src/cli/palette.ts`). Raw
 * `console.log/error/warn` calls bypass palette formatting and break the single
 * source of truth for output discipline. CI gate.
 *
 * Why: a palette sweep completed routing all console output through palette. This
 * gate is a one-way ratchet preventing regression — new raw console calls fail CI
 * immediately, while grandfathered counts can only decrease, never increase.
 *
 * Excluded from scanning (legitimate raw console usage):
 *   - `src/cli/commands/interactive/console-bridge.ts` — the bridge itself
 *   - `src/telegram/streaming.loop.ts` — already guarded behind traceEnabled
 *   - Test files (`*.test.ts`)
 *   - Lines containing `JSON.stringify` — machine-readable JSON output
 *   - Lines containing `palette.` — already routed through the palette system
 *   - `console.warn)` without `(` — function reference, not a call
 *   - Lines with `// console-ok` inline comment — intentional escape hatch
 *
 * Modes:
 *   (default) / --check   compare against `.console-baseline.json` ratchet.
 *                         Fail if any NEW file has violations, or any baselined
 *                         file has MORE violations than baseline.
 *   --update              regenerate `.console-baseline.json` from current state.
 *   --list                list all violations with file:line.
 *
 * Baseline is a ONE-WAY RATCHET: violations can only decrease, never increase.
 * Run `pnpm audit:console:update` after deliberately fixing violations to tighten it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const BASELINE_PATH = path.join(repoRoot, '.console-baseline.json');
const BASELINE_REL = '.console-baseline.json';

const SCAN_ROOTS = [
  path.join(repoRoot, 'src', 'cli', 'commands'),
  path.join(repoRoot, 'src', 'telegram'),
];

/** Files excluded from scanning — legitimate raw console usage. */
const EXCLUDED_FILES = new Set([
  'src/cli/commands/interactive/console-bridge.ts',
  'src/telegram/streaming.loop.ts',
]);

/** Regex matching raw console calls we care about. */
const CONSOLE_CALL_RE = /\bconsole\.(log|error|warn)\s*\(/;

interface Violation {
  file: string;
  line: number;
  text: string;
  method: string;
}

interface BaselineEntry {
  count: number;
  reason: string;
}

interface Baseline {
  entries: Record<string, BaselineEntry>;
}

// ── File walking ──────────────────────────────────────────────────────────────

function walkDir(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(abs);
    }
  }
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walkDir(root, files);
  return files.sort();
}

// ── Violation detection ───────────────────────────────────────────────────────

function isExcluded(relPath: string): boolean {
  return EXCLUDED_FILES.has(relPath);
}

function scanFile(absPath: string): Violation[] {
  const rel = path.relative(repoRoot, absPath);
  if (isExcluded(rel)) return [];

  const source = fs.readFileSync(absPath, 'utf8');
  const lines = source.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // Skip lines with the escape-hatch comment.
    if (line.includes('// console-ok')) continue;

    // Skip lines with JSON.stringify — machine-readable JSON output is legitimate.
    if (line.includes('JSON.stringify')) continue;

    // Skip lines already routed through palette — this IS the correct pattern.
    // e.g. console.log(palette.info('...')) or console.error(palette.error('...'))
    if (line.includes('palette.')) continue;

    // Skip full-comment lines.
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Match console.log/error/warn calls (not function references).
    // `console.warn)` (reference without `(`) is excluded by requiring `\s*\(` in regex.
    const match = CONSOLE_CALL_RE.exec(line);
    if (!match) continue;

    violations.push({
      file: rel,
      line: i + 1,
      text: line.trim(),
      method: `console.${match[1] ?? '?'}`,
    });
  }

  return violations;
}

// ── Baseline I/O ──────────────────────────────────────────────────────────────

function loadBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_PATH)) return { entries: {} };
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  } catch {
    return { entries: {} };
  }
}

function writeBaseline(baseline: Baseline): void {
  const sorted: Record<string, BaselineEntry> = {};
  for (const key of Object.keys(baseline.entries).sort()) {
    sorted[key] = baseline.entries[key]!;
  }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({ entries: sorted }, null, 2) + '\n', 'utf8');
}

// ── Scan aggregation ──────────────────────────────────────────────────────────

function scanAll(): Map<string, Violation[]> {
  const files = collectFiles();
  const result = new Map<string, Violation[]>();
  for (const abs of files) {
    const violations = scanFile(abs);
    if (violations.length > 0) {
      const rel = path.relative(repoRoot, abs);
      result.set(rel, violations);
    }
  }
  return result;
}

// ── Modes ─────────────────────────────────────────────────────────────────────

function modeList(): void {
  const byFile = scanAll();
  let total = 0;
  for (const [file, violations] of byFile) {
    for (const v of violations) {
      console.log(`${file}:${v.line}  ${v.method}  ${v.text}`);
      total++;
    }
  }
  const fileCount = byFile.size;
  console.log(`\n(${total} raw console call(s) in ${fileCount} file(s))`);
}

function modeUpdate(): void {
  const byFile = scanAll();
  const baseline: Baseline = { entries: {} };

  for (const [file, violations] of byFile) {
    baseline.entries[file] = {
      count: violations.length,
      reason: 'grandfathered: predates console-palette sweep gate',
    };
  }

  writeBaseline(baseline);

  const totalViolations = [...byFile.values()].reduce((s, v) => s + v.length, 0);
  const fileCount = byFile.size;
  console.log(
    `✓ ${BASELINE_REL}: ${fileCount} file(s) grandfathered, ${totalViolations} raw console call(s) recorded.`,
  );
}

function modeCheck(): void {
  const byFile = scanAll();
  const baseline = loadBaseline();

  const newFiles: Array<{ file: string; count: number }> = [];
  const grewFiles: Array<{ file: string; was: number; now: number }> = [];
  const shrunkFiles: Array<{ file: string; was: number; now: number }> = [];

  // Check files with current violations against the baseline.
  for (const [file, violations] of byFile) {
    const entry = baseline.entries[file];
    if (!entry) {
      newFiles.push({ file, count: violations.length });
    } else if (violations.length > entry.count) {
      grewFiles.push({ file, was: entry.count, now: violations.length });
    } else if (violations.length < entry.count) {
      shrunkFiles.push({ file, was: entry.count, now: violations.length });
    }
  }

  // Hint when shrunk files can tighten the ratchet.
  if (shrunkFiles.length > 0) {
    console.log(`\n↓ ${shrunkFiles.length} baselined file(s) improved (run \`pnpm audit:console:update\` to tighten the ratchet):`);
    for (const s of shrunkFiles) {
      console.log(`    ${s.file}  ${s.was} → ${s.now} (-${s.was - s.now})`);
    }
  }

  const hasViolations = newFiles.length > 0 || grewFiles.length > 0;

  if (!hasViolations) {
    const grandfathered = [...byFile.values()].reduce((s, v) => s + v.length, 0);
    const fileCount = byFile.size;
    console.log(
      `✓ audit:console: no new raw console calls bypassing palette (${grandfathered} grandfathered in ${fileCount} files)`,
    );
    return;
  }

  console.error(`\n✗ audit:console: raw console calls bypassing palette detected:\n`);

  if (newFiles.length > 0) {
    console.error(`  NEW files (not in baseline):`);
    for (const n of newFiles) {
      console.error(`    ${n.file}  (${n.count} call(s))`);
      const violations = byFile.get(n.file) ?? [];
      for (const v of violations.slice(0, 5)) {
        console.error(`      L${v.line}: ${v.method}  ${v.text}`);
      }
      if (violations.length > 5) console.error(`      … and ${violations.length - 5} more`);
    }
    console.error('');
  }

  if (grewFiles.length > 0) {
    console.error(`  GREW files (more violations than baseline):`);
    for (const g of grewFiles) {
      console.error(`    ${g.file}  ${g.was} → ${g.now} (+${g.now - g.was})`);
    }
    console.error('');
  }

  console.error('Fix:');
  console.error('  Route console output through src/cli/palette.ts:');
  console.error("    import { palette } from '<path>/palette.js';");
  console.error('    process.stdout.write(palette.success(msg) + "\\n");  // ← was: console.log(msg)');
  console.error('    process.stderr.write(palette.error(msg) + "\\n");   // ← was: console.error(msg)');
  console.error('  Or add `// console-ok` to the line if this is intentional raw output.\n');

  process.exit(1);
}

// ── Entry point ───────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--update')) {
    modeUpdate();
  } else if (argv.includes('--list')) {
    modeList();
  } else {
    // Default and --check both run the ratchet check.
    modeCheck();
  }
}

main();
