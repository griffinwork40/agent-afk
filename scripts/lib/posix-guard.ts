/**
 * Tree scan + baseline ratchet for the POSIX-assumption guard. Consumed by the
 * CLI (`scripts/check-posix-guard.ts`) and by `tests/posix-guard.test.ts`, which
 * is what makes `pnpm test` (ubuntu CI + auto-release) enforce it on every PR.
 *
 * Invariant: the ratchet is GROWTH-ONLY. A (file, rule) count above its
 * baseline fails; a count at or below it passes, including a file that has
 * dropped to zero or disappeared. That asymmetry is deliberate and differs from
 * the size ratchets (which fail RETIRED/STALE): several lanes remove
 * grandfathered violations concurrently, and none of them may be forced to edit
 * this baseline to land. Shrinkage only prints a hint to regenerate.
 *
 * Keys are repo-relative POSIX paths with per-rule COUNTS, never line numbers,
 * so unrelated edits above a grandfathered site never churn the baseline.
 *
 * Contract: pure apart from reading source files and the baseline; never
 * prints, never exits. Messages and exit codes belong to the caller.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { RULE_IDS, scanSource, type Finding, type RuleId } from './posix-guard-rules.js';

export const BASELINE_REL = '.posix-guard-baseline.json';

export type RuleCounts = Partial<Record<RuleId, number>>;

export interface PosixBaseline {
  entries: Record<string, RuleCounts>;
}

const SCAN_ROOTS = ['src', 'scripts', 'tests'] as const;
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '__fixtures__', 'web-ui-assets']);
const INCLUDED_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Test code: `*.test.*` / `*.spec.*`, anything under `__test-utils__/`, or the `tests/` tree. */
export function isTestPath(rel: string): boolean {
  const segs = rel.replaceAll('\\', '/').split('/');
  const base = segs[segs.length - 1] ?? '';
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || segs.includes('__test-utils__') || segs[0] === 'tests';
}

/**
 * Which rules apply to a repo-relative path. `[]` means out of scope.
 * R1/R3 are product-code rules (tests legitimately use POSIX-shaped fixtures
 * and `/bin/sh` inside spawned-command strings); R2 applies everywhere a temp
 * dir is made; R4 is a test-only rule.
 */
export function rulesFor(rel: string): RuleId[] {
  const segs = rel.replaceAll('\\', '/').split('/');
  if (!SCAN_ROOTS.includes(segs[0] as never)) return [];
  if (segs.some((s) => EXCLUDED_DIRS.has(s))) return [];
  const base = segs[segs.length - 1] ?? '';
  if (!INCLUDED_EXT.test(base) || base.endsWith('.d.ts')) return [];
  return isTestPath(rel) ? ['R2', 'R4'] : ['R1', 'R2', 'R3'];
}

/** Cheap text prefilter per rule, so the AST parse runs on a small fraction of files. */
const PREFILTER: Record<RuleId, RegExp> = {
  R1: /(exec|spawn|shell)[\s\S]*\b(sh|bash|zsh|dash)\b/,
  R2: /mkdtemp/,
  R3: /(resolve|normalize)\s*\(/,
  R4: /skipIf|runIf|\.skip\b|platform|win32|isWin/i,
};

/** Scan one file's text, applying the prefilter first. */
export function scanFile(rel: string, text: string): Finding[] {
  const rules = rulesFor(rel).filter((r) => PREFILTER[r].test(text));
  return rules.length === 0 ? [] : scanSource(rel, text, rules);
}

function walk(repoRoot: string, dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(repoRoot, path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      const rel = path.relative(repoRoot, path.join(dir, entry.name)).replaceAll('\\', '/');
      if (rulesFor(rel).length > 0) out.push(rel);
    }
  }
}

/** Every finding in the tree, keyed by repo-relative POSIX path (files with none omitted). */
export function scanTree(repoRoot: string): Map<string, Finding[]> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(repoRoot, path.join(repoRoot, root), files);
  const out = new Map<string, Finding[]>();
  for (const rel of files.sort()) {
    const findings = scanFile(rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
    if (findings.length > 0) out.set(rel, findings);
  }
  return out;
}

export function countFindings(findings: readonly Finding[]): RuleCounts {
  const counts: RuleCounts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  return counts;
}

export function countsByFile(scan: Map<string, Finding[]>): Record<string, RuleCounts> {
  const out: Record<string, RuleCounts> = {};
  for (const [rel, findings] of scan) out[rel] = countFindings(findings);
  return out;
}

export function totalsByRule(entries: Record<string, RuleCounts>): Record<RuleId, number> {
  const t = { R1: 0, R2: 0, R3: 0, R4: 0 };
  for (const counts of Object.values(entries)) for (const r of RULE_IDS) t[r] += counts[r] ?? 0;
  return t;
}

export function loadPosixBaseline(file: string): PosixBaseline & { fileExisted: boolean } {
  if (!fs.existsSync(file)) return { entries: {}, fileExisted: false };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PosixBaseline>;
  return { entries: parsed.entries ?? {}, fileExisted: true };
}

/** Invariant: keys sorted, one line per file, so concurrent edits rarely collide in git. */
export function serializePosixBaseline(b: PosixBaseline): string {
  const lines = Object.keys(b.entries)
    .sort()
    .map((k) => {
      const counts = b.entries[k] ?? {};
      const parts = RULE_IDS.filter((r) => (counts[r] ?? 0) > 0).map((r) => `"${r}": ${counts[r]}`);
      return `    ${JSON.stringify(k)}: { ${parts.join(', ')} }`;
    });
  return `{\n  "entries": {\n${lines.join(',\n')}\n  }\n}\n`;
}

export interface Growth {
  file: string;
  rule: RuleId;
  baseline: number;
  actual: number;
  /** The offending sites in this file for this rule (all of them; the new one is among them). */
  sites: Finding[];
}

export interface Comparison {
  growth: Growth[];
  /** (file, rule) pairs now below baseline: pass, but the baseline can be lowered. */
  shrunk: Array<{ file: string; rule: RuleId; baseline: number; actual: number }>;
}

/** Compare a scan against a baseline. Growth fails; shrink is informational. */
export function compareToBaseline(scan: Map<string, Finding[]>, baseline: PosixBaseline): Comparison {
  const growth: Growth[] = [];
  const shrunk: Comparison['shrunk'] = [];
  const files = new Set([...scan.keys(), ...Object.keys(baseline.entries)]);
  for (const file of [...files].sort()) {
    const findings = scan.get(file) ?? [];
    const actual = countFindings(findings);
    const base = baseline.entries[file] ?? {};
    for (const rule of RULE_IDS) {
      const a = actual[rule] ?? 0;
      const b = base[rule] ?? 0;
      if (a > b) growth.push({ file, rule, baseline: b, actual: a, sites: findings.filter((f) => f.rule === rule) });
      else if (a < b) shrunk.push({ file, rule, baseline: b, actual: a });
    }
  }
  return { growth, shrunk };
}
