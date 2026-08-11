#!/usr/bin/env tsx
/**
 * Enforce the 350-line source-file ceiling. CI gate.
 * Mirrors `scripts/audit-env-access.ts` and `scripts/audit-chalk-usage.ts`.
 *
 * Invariant: no source file exceeds LIMIT raw lines. The reason is not
 * aesthetic. An oversized file costs an agent most of a working context just to
 * establish what it may safely touch, and the failure mode is silent — the agent
 * edits from a partial read. At the ceiling you pull one whole CONCERN into a new
 * file. You never shave lines and you never raise the limit.
 *
 * "Raw lines" means newline count, identical to `wc -l`. Comments are counted
 * deliberately: a comments-free metric would make prose free and let stale
 * `Invariant:` blocks balloon unchecked. The pressure valve is extraction —
 * JSDoc travels with its declaration, so moving a concern moves its docs too and
 * no documentation is ever deleted to satisfy this gate.
 *
 * Modes:
 *   (default) / --check   enforce the ceiling + baseline ratchet. Non-zero exit
 *                         on any violation.
 *   --update-baseline     regenerate `.filesize-baseline.json` from disk,
 *                         preserving `reason` / `permanent` by key.
 *   --changed-vs <ref>    touch-trigger: a baselined file MODIFIED relative to
 *                         <ref> must come under the ceiling in that same change.
 *   --list                print every scanned file with its line count.
 *
 * The baseline grandfathers files that already exceeded the ceiling when the gate
 * landed, and it is a ONE-WAY RATCHET — it fails four ways, so it can never
 * silently slacken into a parking lot:
 *   NEW      a non-baselined file exceeds the ceiling.
 *   GREW     a baselined file is larger than its recorded size.
 *   RETIRED  a baselined file now fits — remove it from the baseline.
 *   STALE    a baselined file no longer exists — remove it from the baseline.
 *
 * `permanent: true` entries are exempt from RETIRED (they are never expected to
 * fit) but NOT from GREW. Each needs a written reason. Keep the list tiny.
 *
 * Baseline formatting contract: keys sorted, one entry per line. Waves scoped to
 * one subtree then touch disjoint contiguous line ranges, so concurrent PRs
 * mostly avoid conflicting. Never resolve a conflict by editing markers — run
 * `git checkout origin/main -- .filesize-baseline.json && pnpm audit:filesize:update`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** Hard ceiling. Never raise this — extract a concern instead. */
const LIMIT = 350;
/** Early-warning band at 90% of LIMIT, so drift surfaces on the commit that starts it. */
const WARN_AT = Math.floor((LIMIT * 90) / 100);

const BASELINE_PATH = path.join(repoRoot, '.filesize-baseline.json');
const BASELINE_REL = '.filesize-baseline.json';

/**
 * Scanned roots. Source only, matching the rule's scope: these are the files an
 * agent must read whole to establish edit safety.
 */
const SCAN_ROOTS = ['src', 'scripts'] as const;

/**
 * Contract: excluded paths are those where a line count does not measure
 * context cost. Test files are a flat list of independent cases an agent greps
 * into, never read start-to-finish (223 exceed the ceiling; including them would
 * triple the baseline for no edit-safety benefit). Fixtures and generated
 * declarations are not authored prose or logic.
 */
const EXCLUDED_SUFFIXES = ['.test.ts', '.spec.ts', '.d.ts'] as const;
const EXCLUDED_DIRS = ['__fixtures__', '__test-utils__', 'node_modules', 'dist'] as const;
const INCLUDED_EXTENSIONS = ['.ts', '.mjs', '.js'] as const;

interface BaselineEntry {
  loc: number;
  reason: string;
  permanent?: boolean;
}

interface Baseline {
  limit: number;
  entries: Record<string, BaselineEntry>;
}

type ViolationKind = 'NEW' | 'GREW' | 'RETIRED' | 'STALE' | 'TOUCHED';

interface Violation {
  kind: ViolationKind;
  file: string;
  detail: string;
}

/** Count newlines — identical to `wc -l`, including the no-trailing-newline case. */
function countLines(absPath: string): number {
  const content = fs.readFileSync(absPath, 'utf8');
  let n = 0;
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') n++;
  return n;
}

function isScannable(relPath: string): boolean {
  const base = path.basename(relPath);
  if (!INCLUDED_EXTENSIONS.some((e) => base.endsWith(e))) return false;
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

function scanAll(): Map<string, number> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(repoRoot, root), files);
  const sizes = new Map<string, number>();
  for (const rel of files.sort()) sizes.set(rel, countLines(path.join(repoRoot, rel)));
  return sizes;
}

function loadBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_PATH)) return { limit: LIMIT, entries: {} };
  const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  return { limit: parsed.limit ?? LIMIT, entries: parsed.entries ?? {} };
}

/**
 * Invariant: keys sorted, exactly one line per entry. This layout is what keeps
 * concurrent single-subtree waves from colliding in git, so do not reformat it
 * with a bare JSON.stringify(obj, null, 2) — that explodes each entry across
 * four lines and turns every wave into a conflict.
 */
function serializeBaseline(baseline: Baseline): string {
  const keys = Object.keys(baseline.entries).sort();
  const lines = keys.map((k) => {
    const e = baseline.entries[k];
    if (!e) return '';
    const parts: string[] = [`"loc": ${e.loc}`];
    if (e.permanent) parts.push('"permanent": true');
    parts.push(`"reason": ${JSON.stringify(e.reason)}`);
    return `    ${JSON.stringify(k)}: { ${parts.join(', ')} }`;
  });
  return `{\n  "limit": ${baseline.limit},\n  "entries": {\n${lines.join(',\n')}\n  }\n}\n`;
}

function updateBaseline(): void {
  const sizes = scanAll();
  const previous = loadBaseline();
  const entries: Record<string, BaselineEntry> = {};
  for (const [file, loc] of sizes) {
    if (loc <= LIMIT) continue;
    const prior = previous.entries[file];
    entries[file] = {
      loc,
      reason: prior?.reason ?? 'legacy: predates the ceiling gate; pending concern extraction',
      ...(prior?.permanent ? { permanent: true } : {}),
    };
  }
  fs.writeFileSync(BASELINE_PATH, serializeBaseline({ limit: LIMIT, entries }), 'utf8');
  const kept = Object.keys(entries).length;
  const dropped = Object.keys(previous.entries).filter((k) => !entries[k]);
  console.log(`✓ ${BASELINE_REL}: ${kept} entr${kept === 1 ? 'y' : 'ies'} over the ${LIMIT}-line ceiling.`);
  if (dropped.length > 0) {
    console.log(`  retired ${dropped.length} (now within the ceiling):`);
    for (const d of dropped) console.log(`    - ${d}`);
  }
}

/**
 * Files this branch changed relative to `ref`, restricted to scannable source.
 *
 * Invariant: diff from the MERGE BASE to the WORKING TREE, not `ref...HEAD`.
 * Two properties are load-bearing and each rules out a simpler form:
 *   - merge-base (not `ref` directly) so files advanced on `ref` since the branch
 *     point are not misattributed to this change;
 *   - working tree (not `HEAD`) so uncommitted edits are caught — a pre-commit or
 *     local invocation must see work that is not yet a commit.
 */
function changedSince(ref: string): string[] {
  let base = ref;
  try {
    base = execFileSync('git', ['merge-base', ref, 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    // No merge base (unrelated histories, or `ref` unfetched) — fall back to a
    // direct diff rather than failing the gate on a git topology problem.
  }
  const out = execFileSync('git', ['diff', '--name-only', base], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && isScannable(l));
}

function collectViolations(sizes: Map<string, number>, baseline: Baseline, changedVs: string | null): Violation[] {
  const violations: Violation[] = [];

  for (const [file, loc] of sizes) {
    const entry = baseline.entries[file];
    if (!entry) {
      if (loc > LIMIT) {
        violations.push({
          kind: 'NEW',
          file,
          detail: `${loc} lines exceeds the ${LIMIT}-line ceiling by ${loc - LIMIT}`,
        });
      }
      continue;
    }
    if (loc > entry.loc) {
      violations.push({
        kind: 'GREW',
        file,
        detail: `grew ${entry.loc} → ${loc} (+${loc - entry.loc}); baselined files may shrink, never grow`,
      });
    } else if (loc <= LIMIT && !entry.permanent) {
      violations.push({
        kind: 'RETIRED',
        file,
        detail: `now ${loc} lines and within the ceiling — remove it from ${BASELINE_REL}`,
      });
    }
  }

  for (const file of Object.keys(baseline.entries)) {
    if (!sizes.has(file)) {
      violations.push({ kind: 'STALE', file, detail: `no longer exists — remove it from ${BASELINE_REL}` });
    }
  }

  if (changedVs) {
    for (const file of changedSince(changedVs)) {
      const loc = sizes.get(file);
      if (loc === undefined || loc <= LIMIT) continue;
      if (!baseline.entries[file]) continue; // already reported as NEW
      violations.push({
        kind: 'TOUCHED',
        file,
        detail: `modified vs ${changedVs} while still ${loc} lines — a change that touches a baselined file must bring it under ${LIMIT}`,
      });
    }
  }

  return violations;
}

function reportAndExit(sizes: Map<string, number>, baseline: Baseline, violations: Violation[]): void {
  const warnings = [...sizes.entries()]
    .filter(([f, n]) => n > WARN_AT && n <= LIMIT && !baseline.entries[f])
    .sort(([, a], [, b]) => b - a);

  if (warnings.length > 0) {
    console.log(`\n⚠ ${warnings.length} file(s) in the ${WARN_AT + 1}–${LIMIT} warn band (not failing):`);
    for (const [file, n] of warnings.slice(0, 10)) console.log(`    ${String(n).padStart(5)}  ${file}`);
    if (warnings.length > 10) console.log(`    … and ${warnings.length - 10} more`);
  }

  const baselined = Object.keys(baseline.entries).length;
  if (violations.length === 0) {
    console.log(`\n✓ check-file-size: every source file within the ${LIMIT}-line ceiling (${baselined} grandfathered).`);
    return;
  }

  console.error(`\n✗ check-file-size: ${violations.length} violation(s) of the ${LIMIT}-line ceiling:\n`);
  for (const kind of ['NEW', 'GREW', 'TOUCHED', 'RETIRED', 'STALE'] as const) {
    const group = violations.filter((v) => v.kind === kind);
    if (group.length === 0) continue;
    console.error(`  ${kind}:`);
    for (const v of group) console.error(`    ${v.file}\n      ${v.detail}`);
    console.error('');
  }
  console.error('Fix:');
  console.error(`  NEW/TOUCHED — pull one whole CONCERN into a sibling file (<base>.<concern>.ts).`);
  console.error('                JSDoc travels with its declaration, so moving code moves its docs.');
  console.error('                Never delete, reflow, or condense a comment to satisfy this gate, and');
  console.error("                never reclassify an 'Invariant:'/'Contract:' block as 'History:'.");
  console.error('  GREW        — the file was already over the ceiling; do not add to it. Extract first.');
  console.error(`  RETIRED/STALE — run \`pnpm audit:filesize:update\` to regenerate ${BASELINE_REL}.\n`);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--update-baseline')) {
    updateBaseline();
    return;
  }

  const sizes = scanAll();

  if (argv.includes('--list')) {
    for (const [file, n] of [...sizes.entries()].sort(([, a], [, b]) => b - a)) {
      console.log(`${String(n).padStart(5)}  ${file}`);
    }
    return;
  }

  const idx = argv.indexOf('--changed-vs');
  const changedVs = idx >= 0 ? (argv[idx + 1] ?? null) : null;
  if (idx >= 0 && !changedVs) {
    console.error('✗ check-file-size: --changed-vs requires a git ref, e.g. --changed-vs origin/main');
    process.exit(1);
  }

  const baseline = loadBaseline();
  reportAndExit(sizes, baseline, collectViolations(sizes, baseline, changedVs));
}

main();
