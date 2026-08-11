#!/usr/bin/env tsx
/**
 * Audit module-scope state duplicated across a sibling family. CI gate.
 * Mirrors `scripts/audit-env-access.ts` and `scripts/audit-chalk-usage.ts`.
 *
 * Invariant: within one dotted sibling family (`<base>.ts` + `<base>.<concern>.ts`,
 * the shape this repo's file-splitting convention produces), a given piece of
 * module-scope mutable state is DECLARED IN EXACTLY ONE FILE. Siblings that need
 * it import the binding; they never re-declare their own.
 *
 * Why this gate exists: extracting a concern into a sibling is only
 * behaviour-preserving if state stays singular. If a split re-declares
 * `const registry = new Set()` in the sibling instead of importing it, both
 * modules compile, every existing test passes, and the two halves silently
 * operate on different state. The live case is `src/agent/trace/writer.ts`,
 * whose module-scope `liveTraceWriters` Set and `exitBackstopInstalled` flag gate
 * a `process.on('exit')` backstop that seals otherwise-orphaned traces —
 * `writer.test.ts` calls the sealer directly, bypassing module-scope
 * registration, so a forked-state split would pass CI and lose traces only on
 * crash. The same shape has already shipped once here: see the header of
 * `src/agent/providers/shared/presence-signals.ts`, which documents a
 * multiple-listener leak (`MaxListenersExceededWarning`) of exactly this kind.
 *
 * Modes:
 *   (default) / --check   report duplicated module state. Non-zero exit on any.
 *   --list                list every family member and the state each declares.
 *
 * Scope: dotted families only. A directory of plain-named modules is NOT treated
 * as a family — unrelated modules in one directory legitimately each own a
 * `let cached`, and grouping them would drown the real signal in false
 * positives. Dotted families are precisely the split-product shape.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SCAN_ROOT = path.join(repoRoot, 'src');

const EXCLUDED_SUFFIXES = ['.test.ts', '.spec.ts', '.d.ts'] as const;
const EXCLUDED_DIRS = ['__fixtures__', '__test-utils__', 'node_modules', 'dist'] as const;

/**
 * Module-scope mutable-state declarations. Anchored at column 0 — indentation
 * means function scope, which is per-call state and not a singleton.
 */
const STATE_PATTERNS: ReadonlyArray<{ re: RegExp; kind: string }> = [
  { re: /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)/, kind: 'mutable binding' },
  {
    re: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/,
    kind: 'collection singleton',
  },
];

/**
 * Process-level handler registration. Deliberately NOT anchored at column 0:
 * the trace-writer case registers its exit backstop from inside a function, and
 * that is still a once-per-module side effect worth counting.
 */
const HANDLER_RE = /\b(process|globalThis)\.(on|once)\(\s*['"]([^'"]+)['"]/;

/**
 * Contract: a full-line comment is prose, not code. `src/agent/trace/writer.ts`
 * discusses `process.on('exit')` in its own header three times; counting those
 * would flag any two siblings that merely document the same mechanism.
 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

interface Declaration {
  name: string;
  kind: string;
  line: number;
}

interface Violation {
  family: string;
  name: string;
  kind: string;
  sites: Array<{ file: string; line: number }>;
}

function isScannable(relPath: string): boolean {
  const base = path.basename(relPath);
  if (!base.endsWith('.ts')) return false;
  if (EXCLUDED_SUFFIXES.some((s) => base.endsWith(s))) return false;
  return !relPath.split(path.sep).some((seg) => EXCLUDED_DIRS.includes(seg as never));
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.includes(entry.name as never)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      const rel = path.relative(repoRoot, full);
      if (isScannable(rel)) out.push(rel);
    }
  }
}

/**
 * Family key for a dotted sibling: `src/cli/terminal-compositor.frame.ts` and
 * `src/cli/terminal-compositor.ts` both key to `src/cli/terminal-compositor`.
 * A file with no dot in its basename keys to itself and so is always a family
 * of one, which can never produce a duplication finding.
 */
function familyKey(relPath: string): string {
  const dir = path.dirname(relPath);
  const base = path.basename(relPath, '.ts');
  const firstDot = base.indexOf('.');
  return path.join(dir, firstDot === -1 ? base : base.slice(0, firstDot));
}

function declarationsIn(relPath: string): Declaration[] {
  const text = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  const lines = text.split('\n');
  const found: Declaration[] = [];
  const seen = new Set<string>();

  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;

    for (const { re, kind } of STATE_PATTERNS) {
      const m = re.exec(line);
      if (m?.[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        found.push({ name: m[1], kind, line: i + 1 });
        break;
      }
    }

    const hm = HANDLER_RE.exec(line);
    if (hm) {
      const key = `${hm[1]}.${hm[2]}(${hm[3] ?? '?'})`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ name: key, kind: 'handler registration', line: i + 1 });
      }
    }
  });

  return found;
}

function collect(): { families: Map<string, string[]>; decls: Map<string, Declaration[]> } {
  const files: string[] = [];
  walk(SCAN_ROOT, files);
  const families = new Map<string, string[]>();
  const decls = new Map<string, Declaration[]>();
  for (const rel of files.sort()) {
    const key = familyKey(rel);
    const members = families.get(key);
    if (members) members.push(rel);
    else families.set(key, [rel]);
    decls.set(rel, declarationsIn(rel));
  }
  return { families, decls };
}

function findViolations(
  families: Map<string, string[]>,
  decls: Map<string, Declaration[]>,
): Violation[] {
  const violations: Violation[] = [];
  for (const [family, members] of families) {
    if (members.length < 2) continue;
    const byName = new Map<string, Array<{ file: string; line: number; kind: string }>>();
    for (const file of members) {
      for (const d of decls.get(file) ?? []) {
        const sites = byName.get(d.name);
        const site = { file, line: d.line, kind: d.kind };
        if (sites) sites.push(site);
        else byName.set(d.name, [site]);
      }
    }
    for (const [name, sites] of byName) {
      if (sites.length < 2) continue;
      violations.push({
        family,
        name,
        kind: sites[0]?.kind ?? 'unknown',
        sites: sites.map((s) => ({ file: s.file, line: s.line })),
      });
    }
  }
  return violations.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
}

function main(): void {
  const argv = process.argv.slice(2);
  const { families, decls } = collect();

  if (argv.includes('--list')) {
    for (const [family, members] of [...families.entries()].sort()) {
      if (members.length < 2) continue;
      console.log(`\n${family} (${members.length} members)`);
      for (const file of members) {
        const d = decls.get(file) ?? [];
        console.log(`  ${file}${d.length === 0 ? '  —' : ''}`);
        for (const x of d) console.log(`      L${x.line} ${x.name}  [${x.kind}]`);
      }
    }
    return;
  }

  const violations = findViolations(families, decls);
  const familyCount = [...families.values()].filter((m) => m.length >= 2).length;

  if (violations.length === 0) {
    console.log(`\n✓ audit-module-state: no duplicated module state across ${familyCount} sibling famil${familyCount === 1 ? 'y' : 'ies'}.`);
    return;
  }

  console.error(`\n✗ audit-module-state: ${violations.length} duplicated module-scope declaration(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.family}.*  —  ${v.name}  [${v.kind}]`);
    for (const s of v.sites) console.error(`    ${s.file}:${s.line}`);
    console.error('');
  }
  console.error('Fix:');
  console.error('  Declare the state in ONE file of the family and import the binding in the others.');
  console.error('  Two module-scope declarations of the same name are two independent values: both');
  console.error('  halves compile, every test passes, and they silently diverge at runtime.');
  console.error('  For a handler registration, register once behind an idempotent guard owned by a');
  console.error('  single module — duplicate process.on registrations leak listeners per session.\n');
  process.exit(1);
}

main();
