#!/usr/bin/env tsx
/**
 * Audit raw terminal-width reads in `src/`.
 *
 * Enforces the invariant: terminal width is read ONLY through the centralized
 * helper `src/cli/terminal-size.ts` (`getTerminalWidth()`) — downstream modules
 * must never access `process.stdout.columns` or `process.stderr.columns` directly.
 * CI gate. Mirrors `scripts/audit-chalk-usage.ts` and `scripts/audit-env-access.ts`.
 *
 * Why: the same terminal-width bug has recurred ~7 times in 300 commits because
 * each fix is applied at one call site, leaving others to drift. Raw
 * `process.stdout.columns` reads bypass the 80-column fallback guard and the
 * SIGWINCH debounce wiring that `terminal-size.ts` provides, so each scattered
 * raw read is independently fragile. A central helper makes the discipline
 * mechanical rather than documentary.
 *
 * Modes:
 *   (default)   — print every raw terminal-width read outside the allowlist.
 *                 Non-zero exit on any violation.
 *   --check     — alias of default, for CI clarity.
 *   --list      — list every raw terminal-width read (including allowlisted)
 *                 with file:line — useful when auditing a new batch.
 *
 * What counts as a violation: a bare `process.stdout.columns` or
 * `process.stderr.columns` access in production source (non-test) TypeScript
 * files under `src/`. The pattern is matched as a word-boundary expression so
 * `someStream.columns` (a stream reference injected via a constructor, not a
 * raw process.stdout read) is NOT flagged — those are not bypassing the helper.
 * Comment-only lines are exempt.
 *
 * Allowlist contract: the handful of files that legitimately own a raw
 * `process.stdout.columns` read — specifically the central helper itself, which
 * is the ONLY place this pattern should appear. Each entry carries a rationale.
 * Keep the list at one entry. Drift fails CI loudly.
 *
 * Failure mode is intentional: new raw reads fail CI, not code review.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SCAN_ROOT = path.join(repoRoot, 'src');

/**
 * Files allowed to contain raw `process.stdout.columns` reads. Each needs a
 * rationale; this list should have exactly one entry. When in doubt, route
 * through `src/cli/terminal-size.ts` instead.
 */
const ALLOWED_FILES: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'src/cli/terminal-size.ts',
    reason:
      'THE central terminal-width helper — the only file permitted to read process.stdout.columns. All other files call getTerminalWidth() from here.',
  },
];

interface Violation {
  file: string;
  line: number;
  text: string;
  match: string;
}

/**
 * Matches bare `process.stdout.columns` or `process.stderr.columns`.
 * Uses a word boundary after `columns` to avoid false positives on
 * longer property chains (none expected, but defensive).
 *
 * Contract: does NOT match `someVar.columns` or `stream.columns` because
 * the pattern requires `process.std(out|err).columns` literally. Those
 * caller-owned stream references are not raw terminal-width reads.
 */
const RAW_WIDTH_RE = /\bprocess\.std(?:out|err)\.columns\b/g;

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
    // Skip full-comment lines: prose that mentions the pattern is not code.
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    RAW_WIDTH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RAW_WIDTH_RE.exec(line)) !== null) {
      violations.push({
        file: rel,
        line: i + 1,
        text: line.trim(),
        match: match[0],
      });
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
    console.log(`\n=== All raw terminal-width reads (process.stdout/stderr.columns) in src/ ===`);
    console.log(`Allowlisted: ${allowedHits.length} site(s)`);
    for (const h of allowedHits) console.log(`  ${h.file}:${h.line} → ${h.match}`);
    console.log(`Other: ${allViolations.length} site(s)`);
    for (const h of allViolations) console.log(`  ${h.file}:${h.line} → ${h.match}`);
  }

  if (allViolations.length === 0) {
    console.log(
      `✓ check-terminal-width: ${files.length} files scanned, ${allowedHits.length} legitimate raw read(s) inside allowlist, 0 violations.`,
    );
    process.exit(0);
  }

  console.error(`\n✗ check-terminal-width: ${allViolations.length} raw terminal-width read(s) outside the central helper:\n`);
  const byFile = new Map<string, Violation[]>();
  for (const v of allViolations) {
    const existing = byFile.get(v.file);
    if (existing) existing.push(v);
    else byFile.set(v.file, [v]);
  }
  for (const [file, vs] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.error(`  ${file}`);
    for (const v of vs) {
      console.error(`    L${v.line}: ${v.match}`);
      console.error(`         ${v.text}`);
    }
    console.error('');
  }
  console.error('Fix:');
  console.error('  1. Import the central helper and replace the raw read:');
  console.error("     import { getTerminalWidth } from '<path>/terminal-size.js';");
  console.error('     const cols = getTerminalWidth();  // ← was: process.stdout.columns ?? 80');
  console.error('  2. getTerminalWidth() already applies the 80-column fallback for non-TTY');
  console.error('     environments — you do not need to chain ?? 80 yourself.');
  console.error('  3. If this file genuinely cannot import terminal-size.ts (inverted dep direction),');
  console.error('     add it to ALLOWED_FILES in scripts/check-terminal-width.ts with a rationale.\n');
  process.exit(1);
}

main();
