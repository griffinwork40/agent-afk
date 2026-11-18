#!/usr/bin/env tsx
/**
 * Audit `.length`, `.padEnd`, and `.padStart` applied to palette-styled strings.
 *
 * Enforces the invariant: strings styled by `palette.*` (or other ANSI-wrapping
 * helpers under `src/cli/`) must NOT have `.length`, `.padEnd`, or `.padStart`
 * called directly on the styled result. Those operations count ANSI escape bytes
 * as visible columns, which breaks column-aligned terminal layouts.
 *
 * Use the visible-width helpers from `src/cli/display.ts` instead:
 *   - `displayWidth(str)`   — column count ignoring ANSI escapes
 *   - `padDisplayRight(str, n)` — right-pad to n visible columns
 *   - `padDisplayLeft(str, n)`  — left-pad to n visible columns
 *
 * CI gate. Modelled on `scripts/check-terminal-width.ts`.
 *
 * Modes:
 *   (default) / --check  — print every violation; non-zero exit on any hit.
 *   --list               — list all hits including allowlisted ones; exits 0.
 *
 * What counts as a violation: a source line where `palette.<role>(...)` (or
 * another allowlisted styled helper) is immediately followed by `.length`,
 * `.padEnd(`, or `.padStart(` — meaning the ANSI-wrapped result is measured
 * or padded instead of the raw string.
 *
 * Detection: paren-depth tracking on each source line. When a `palette.<role>(`
 * token is found, the scanner advances character-by-character keeping a depth
 * counter; when depth returns to zero the closing `)` has been found. If the
 * immediately following non-whitespace text is `.length`, `.padEnd(`, or
 * `.padStart(`, it is flagged.
 *
 * Known limitations (by design, matching check-terminal-width.ts behaviour):
 *   1. Multi-line calls are skipped — the scanner only inspects single source
 *      lines. A `palette.X(` that spans multiple lines will not be flagged.
 *      In practice all palette calls in this codebase fit on one line.
 *   2. Nested palette calls such as `palette.a(palette.b(x).padEnd(n))` are
 *      not detected: the inner `.padEnd` sits at paren depth ≥ 1 and the
 *      outer scan closes before seeing it. No such pattern exists on HEAD.
 *      Fix nested misuse by scanning the inner expression recursively if this
 *      pattern ever appears.
 *
 * False-positive rate on HEAD (2026-11-14): 0 — the scanner correctly ignores
 * `palette.X(str.padEnd(n))` (pad applied before styling) and
 * `palette.X(arr.length)` (array length passed into the template literal that
 * becomes the styled string), because those `)` closings occur inside the
 * outer palette call, not after it.
 *
 * Allowlist: files that legitimately apply `.length` / `.padEnd` / `.padStart`
 * to a styled string (e.g., a helper that intentionally measures raw bytes for
 * a specific protocol reason). Keep the list minimal; each entry requires a
 * rationale. The list starts empty because no such legitimate use exists on HEAD.
 *
 * Failure mode is intentional: new violations fail CI, not code review.
 */

import * as fs from 'node:fs';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupViolationsByFile, isProdTs, walkSourceFiles } from './lib/walk-source-files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SCAN_ROOT = path.join(repoRoot, 'src');

/**
 * Files allowed to call `.length` / `.padEnd` / `.padStart` on a styled string.
 * Each entry requires a rationale. The list starts empty.
 */
const ALLOWED_FILES: ReadonlyArray<{ file: string; reason: string }> = [
  // No legitimate uses on HEAD (2026-11-14). Add entries only when a file has
  // a protocol-level reason to measure ANSI bytes rather than visible columns.
];

/**
 * Styled-string producer prefixes to detect. Matches `palette.<word>(` and any
 * other ANSI-wrapping helper exported from src/cli/ that wraps a string in
 * escape codes before the caller measures it.
 *
 * Keep this list conservative — only add a prefix when you have confirmed it
 * returns an ANSI-styled string (not a plain string).
 */
const STYLED_PREFIXES: ReadonlyArray<string> = [
  'palette.',
];

/** Operations that are unsafe on a styled string's character count. */
const UNSAFE_OPS_RE = /^\.(length\b|padEnd\(|padStart\()/;

interface Violation {
  file: string;
  line: number;
  text: string;
  match: string;
}

/**
 * Scan one source line for `styledHelper(...).<unsafe>` patterns.
 *
 * Uses paren-depth tracking to find the exact closing `)` of the outer styled
 * call, then checks whether `.length` / `.padEnd(` / `.padStart(` immediately
 * follows. This correctly ignores `palette.X(str.padEnd(n))` and
 * `palette.X(arr.length)` because those inner uses close before the outer `)`.
 */
export function scanLine(line: string): string[] {
  const hits: string[] = [];
  for (const prefix of STYLED_PREFIXES) {
    let searchFrom = 0;
    while (true) {
      const idx = line.indexOf(prefix, searchFrom);
      if (idx === -1) break;

      // Find the opening `(` after `palette.<word>`.
      // The member name runs until the first `(`; we only skip over identifier
      // chars (word chars) and then optional whitespace — a non-whitespace,
      // non-`(` character (e.g. `;` or `,`) means this is not a call site.
      let openParen = idx + prefix.length;
      while (openParen < line.length && /\w/.test(line[openParen]!)) openParen++;
      // Allow optional whitespace between name and `(`.
      while (openParen < line.length && line[openParen] !== '(' && /\s/.test(line[openParen]!)) openParen++;
      if (openParen >= line.length || line[openParen] !== '(') {
        searchFrom = idx + prefix.length;
        continue;
      }

      // Track paren depth from the opening `(`.
      let depth = 0;
      let pos = openParen;
      let inStr: false | "'" | '"' | '`' = false;
      let closingParen = -1;
      while (pos < line.length) {
        const ch = line[pos]!;
        if (inStr) {
          if (ch === '\\') { pos += 2; continue; }
          if (ch === inStr) inStr = false;
        } else {
          if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
          else if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth === 0) { closingParen = pos; break; }
          }
        }
        pos++;
      }

      if (closingParen === -1) {
        // Multi-line call — skip; single-line detection only.
        searchFrom = idx + prefix.length;
        continue;
      }

      // Check what immediately follows the closing `)`.
      const after = line.slice(closingParen + 1);
      const m = UNSAFE_OPS_RE.exec(after);
      if (m) {
        const palettePart = line.slice(idx, closingParen + 1);
        hits.push(`${palettePart}${m[0]}`);
      }

      searchFrom = closingParen + 1;
    }
  }
  return hits;
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

    for (const match of scanLine(line)) {
      violations.push({ file: rel, line: i + 1, text: line.trim(), match });
    }
  }
  return violations;
}

function isAllowedFile(relPath: string): boolean {
  return ALLOWED_FILES.some((entry) => entry.file === relPath);
}

function walk(dir: string, out: string[]): void {
  walkSourceFiles(dir, (absPath) => isProdTs(absPath), out);
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
    console.log(`\n=== All styled-string .length/.padEnd/.padStart hits in src/ ===`);
    console.log(`Allowlisted: ${allowedHits.length} site(s)`);
    for (const h of allowedHits) console.log(`  ${h.file}:${h.line} → ${h.match}`);
    console.log(`Violations: ${allViolations.length} site(s)`);
    for (const h of allViolations) console.log(`  ${h.file}:${h.line} → ${h.match}`);
    process.exit(0);
  }

  if (allViolations.length === 0) {
    console.log(
      `✓ check-styled-length: ${files.length} files scanned, ` +
        `${allowedHits.length} allowlisted site(s), 0 violations.`,
    );
    process.exit(0);
  }

  console.error(
    `\n✗ check-styled-length: ${allViolations.length} unsafe operation(s) on styled strings:\n`,
  );
  for (const [file, vs] of groupViolationsByFile(allViolations)) {
    console.error(`  ${file}`);
    for (const v of vs) {
      console.error(`    L${v.line}: ${v.match}`);
      console.error(`         ${v.text}`);
    }
    console.error('');
  }
  console.error('Fix:');
  console.error('  .length on a styled string counts ANSI escape bytes as visible columns.');
  console.error('  Use the visible-width helpers from src/cli/display.ts instead:');
  console.error("    import { displayWidth, padDisplayRight, padDisplayLeft } from '<path>/display.js';");
  console.error('    displayWidth(styledStr)        // ← was: styledStr.length');
  console.error('    padDisplayRight(styledStr, n)  // ← was: styledStr.padEnd(n)');
  console.error('    padDisplayLeft(styledStr, n)   // ← was: styledStr.padStart(n)');
  console.error('  Or pad the raw string BEFORE styling:');
  console.error('    palette.dim(rawStr.padEnd(n))  // correct: pad plain string, then style');
  console.error('  If this file has a legitimate reason to measure ANSI bytes, add it to');
  console.error('  ALLOWED_FILES in scripts/check-styled-length.ts with a rationale.\n');
  process.exit(1);
}

// Only run when executed directly (not when imported by tests).
function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(argv1);
  } catch {
    return fileURLToPath(import.meta.url) === argv1;
  }
}

if (isMain()) {
  main();
}
