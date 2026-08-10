#!/usr/bin/env tsx
/**
 * Enforce a function-scoped size ceiling. CI gate.
 * Sibling of `scripts/check-file-size.ts`; shares its ratchet via `lib/size-ratchet.ts`.
 *
 * Invariant: no function exceeds LIMIT lines. This gate exists because the file
 * gate does not imply it. File size measures how much an agent must read to
 * establish edit safety; function size measures how much it must hold in mind to
 * change one behaviour safely. The two diverge in both directions — a 900-line
 * flat registry is a large file with no large function, and a 700-line function
 * can hide inside a file that passes the 350-line ceiling only because siblings
 * were extracted around it.
 *
 * The evidence for the divergence is this repo's own history. Issue #831 measured
 * that ~40% of the largest files are large from breadth (registries, wire
 * schemas, handler chains) and splitting them buys nothing, while six individual
 * functions each exceeded the whole-FILE ceiling. Issue #919 records the sharpest
 * case: #829 shrank `subagent.ts` and closed, yet `forkSubagent` never changed.
 * A file-scoped gate reports that as progress. This one does not.
 *
 * Modes:
 *   (default) / --check   enforce the ceiling + baseline ratchet. Non-zero exit
 *                         on any violation.
 *   --update-baseline     regenerate `.funcsize-baseline.json` from disk,
 *                         preserving `reason` / `permanent` by key.
 *   --changed-vs <ref>    touch-trigger: a baselined function in a file MODIFIED
 *                         relative to <ref> must come under the ceiling in that
 *                         same change.
 *   --list [n]            print the largest n functions (default 40).
 *
 * Baseline keys are `<path>::<qualified name>`, never line numbers — see the
 * naming invariant in `lib/function-extents.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { functionKey, measureFile, parseFunctionKey } from './lib/function-extents.js';
import {
  changedSince,
  collectViolations,
  loadBaseline,
  updateBaseline,
  VIOLATION_ORDER,
  type RatchetConfig,
  type Violation,
} from './lib/size-ratchet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/**
 * Hard ceiling. Never raise this — extract a helper instead.
 *
 * History: chosen from the measured distribution, not by taste. Issue #831
 * proposed "350 to match the file gate, or 200 to be stricter". Measured over
 * 4,388 functions in `src/` + `scripts/` (median 10 lines, p99 229, max 856):
 *
 *     limit | over |  % of all | excess lines
 *       350 |   15 |     0.34% |  3,394
 *       250 |   31 |     0.71% |  5,459
 *       200 |   54 |     1.23% |  7,595   ← chosen
 *       150 |  100 |     2.28% | 11,284
 *
 * 200 sits at roughly the 99th percentile and yields a 54-entry baseline — one
 * screen, so it stays readable and therefore honest. That is the whole argument
 * of #831 made concrete: the FILE gate grandfathers 138 of 885 files (15.6%),
 * while this one grandfathers 1.2% of functions. A gate whose baseline you can
 * read is a gate that gets fixed; one that fires on a fifth of the tree gets
 * disabled. 350 was rejected because it would miss the entire 200–350 band —
 * 39 functions including `buildChildConfig` (346) and `handleOrchestratorEvent`
 * (304), which are exactly the "hold it all in mind" cases the gate is for.
 *
 * The limit is expected to fall over time; that is what makes it a ratchet and
 * not a speed limit.
 */
const LIMIT = 200;
/** Early-warning band at 90% of LIMIT, so drift surfaces on the commit that starts it. */
const WARN_AT = Math.floor((LIMIT * 90) / 100);

const BASELINE_REL = '.funcsize-baseline.json';

const RATCHET: RatchetConfig = {
  limit: LIMIT,
  baselinePath: path.join(repoRoot, BASELINE_REL),
  baselineRel: BASELINE_REL,
  unit: 'line',
  entryPlural: 'functions',
  legacyReason: 'legacy: predates the function-size gate; pending helper extraction',
};

/** Source only, matching the file gate's scope. */
const SCAN_ROOTS = ['src', 'scripts'] as const;
const EXCLUDED_SUFFIXES = ['.test.ts', '.spec.ts', '.d.ts'] as const;
const EXCLUDED_DIRS = ['__fixtures__', '__test-utils__', 'node_modules', 'dist'] as const;
const INCLUDED_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'] as const;

export function isScannable(relPath: string): boolean {
  const base = path.basename(relPath);
  if (!INCLUDED_EXTENSIONS.some((e) => base.endsWith(e))) return false;
  if (EXCLUDED_SUFFIXES.some((s) => base.endsWith(s))) return false;
  const segments = relPath.split(path.sep);
  if (segments.some((seg) => EXCLUDED_DIRS.includes(seg as never))) return false;
  return SCAN_ROOTS.some((root) => segments[0] === root);
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

interface Measured {
  sizes: Map<string, number>;
  lines: Map<string, number>;
}

function scanAll(): Measured {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(repoRoot, root), files);
  const sizes = new Map<string, number>();
  const lines = new Map<string, number>();
  for (const rel of files.sort()) {
    for (const fn of measureFile(path.join(repoRoot, rel))) {
      const key = functionKey(rel, fn.name);
      sizes.set(key, fn.loc);
      lines.set(key, fn.line);
    }
  }
  return { sizes, lines };
}

/** Map changed FILES onto the function keys they contain. */
function touchedKeysSince(ref: string, sizes: Map<string, number>): Set<string> {
  const changed = new Set(changedSince(ref, repoRoot, isScannable));
  const keys = new Set<string>();
  for (const key of sizes.keys()) {
    const parsed = parseFunctionKey(key);
    if (parsed && changed.has(parsed.file)) keys.add(key);
  }
  return keys;
}

function formatKey(key: string, lines: Map<string, number>): string {
  const parsed = parseFunctionKey(key);
  const line = lines.get(key);
  if (!parsed) return key;
  return line === undefined ? key : `${parsed.file}:${line}  ${parsed.name}()`;
}

function reportAndExit(measured: Measured, violations: Violation[]): void {
  const { sizes, lines } = measured;
  const baseline = loadBaseline(RATCHET);

  const warnings = [...sizes.entries()]
    .filter(([k, n]) => n > WARN_AT && n <= LIMIT && !baseline.entries[k])
    .sort(([, a], [, b]) => b - a);

  if (warnings.length > 0) {
    console.log(`\n⚠ ${warnings.length} function(s) in the ${WARN_AT + 1}–${LIMIT} warn band (not failing):`);
    for (const [key, n] of warnings.slice(0, 10)) console.log(`    ${String(n).padStart(4)}  ${formatKey(key, lines)}`);
    if (warnings.length > 10) console.log(`    … and ${warnings.length - 10} more`);
  }

  const baselined = Object.keys(baseline.entries).length;
  if (violations.length === 0) {
    console.log(`\n✓ check-function-size: every function within the ${LIMIT}-line ceiling (${baselined} grandfathered).`);
    return;
  }

  console.error(`\n✗ check-function-size: ${violations.length} violation(s) of the ${LIMIT}-line ceiling:\n`);
  for (const kind of VIOLATION_ORDER) {
    const group = violations.filter((v) => v.kind === kind);
    if (group.length === 0) continue;
    console.error(`  ${kind}:`);
    for (const v of group) console.error(`    ${formatKey(v.key, lines)}\n      ${v.detail}`);
    console.error('');
  }
  console.error('Fix:');
  console.error('  NEW/TOUCHED — extract a named helper for one step of the function. Prefer a helper');
  console.error('                that takes explicit parameters over one that closes over locals: a');
  console.error('                closure moves lines without reducing what you must hold in mind.');
  console.error('  GREW        — the function was already over the ceiling; do not add to it. Extract first.');
  console.error(`  RETIRED/STALE — run \`pnpm audit:funcsize:update\` to regenerate ${BASELINE_REL}.\n`);
  process.exit(1);
}

function listLargest(measured: Measured, count: number): void {
  const sorted = [...measured.sizes.entries()].sort(([, a], [, b]) => b - a).slice(0, count);
  for (const [key, n] of sorted) console.log(`${String(n).padStart(5)}  ${formatKey(key, measured.lines)}`);
  console.log(`\n(${measured.sizes.size} functions scanned)`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const measured = scanAll();

  if (argv.includes('--update-baseline')) {
    const { kept, dropped } = updateBaseline(RATCHET, measured.sizes);
    console.log(`✓ ${BASELINE_REL}: ${kept} entr${kept === 1 ? 'y' : 'ies'} over the ${LIMIT}-line ceiling.`);
    if (dropped.length > 0) {
      console.log(`  retired ${dropped.length} (now within the ceiling):`);
      for (const d of dropped) console.log(`    - ${d}`);
    }
    return;
  }

  const listIdx = argv.indexOf('--list');
  if (listIdx >= 0) {
    const raw = argv[listIdx + 1];
    const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
    listLargest(measured, Number.isFinite(parsed) && parsed > 0 ? parsed : 40);
    return;
  }

  const idx = argv.indexOf('--changed-vs');
  const changedVs = idx >= 0 ? (argv[idx + 1] ?? null) : null;
  if (idx >= 0 && !changedVs) {
    console.error('✗ check-function-size: --changed-vs requires a git ref, e.g. --changed-vs origin/main');
    process.exit(1);
  }

  const baseline = loadBaseline(RATCHET);
  const violations = collectViolations({
    sizes: measured.sizes,
    baseline,
    cfg: RATCHET,
    ...(changedVs ? { touchedKeys: touchedKeysSince(changedVs, measured.sizes), touchedVs: changedVs } : {}),
  });
  reportAndExit(measured, violations);
}

main();
