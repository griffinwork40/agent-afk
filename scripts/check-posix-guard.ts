#!/usr/bin/env tsx
/**
 * POSIX-assumption guard: catch Windows regressions on every PR, on ubuntu.
 *
 * The Windows CI leg only runs on main pushes and `windows-compat`-labelled
 * PRs, and auto-release gates publishing on `pnpm lint && pnpm test` (ubuntu),
 * so a PR can ship a Windows break unseen (#2588: host `path.resolve('/dev/null')`
 * in bash-scan-exempt.ts). This gate statically flags the known shapes; the
 * rules live in `lib/posix-guard-rules.ts`. It is enforced inside `pnpm test`
 * by `tests/posix-guard.test.ts`; this CLI is for listing and regenerating.
 *
 * Modes:
 *   (default) / --check   fail when any (file, rule) count exceeds the baseline.
 *   --list                print every current finding.
 *   --update-baseline     rewrite `.posix-guard-baseline.json` from disk. Shrinks
 *                         are always allowed; growth needs --allow-growth --reason.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGrowthArgs } from './lib/growth-args.js';
import {
  BASELINE_REL,
  compareToBaseline,
  countsByFile,
  loadPosixBaseline,
  scanTree,
  serializePosixBaseline,
  totalsByRule,
} from './lib/posix-guard.js';
import { formatGrowth, formatShrinkHint, UPDATE_CMD } from './lib/posix-guard-report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const baselinePath = path.join(repoRoot, BASELINE_REL);
const KNOWN_FLAGS = ['--check', '--list', '--update-baseline', '--allow-growth', '--reason'];

function totalsLine(entries: Parameters<typeof totalsByRule>[0]): string {
  const t = totalsByRule(entries);
  return `R1=${t.R1} R2=${t.R2} R3=${t.R3} R4=${t.R4}`;
}

function update(argv: string[]): void {
  const parsed = parseGrowthArgs(argv, KNOWN_FLAGS);
  if ('error' in parsed) {
    console.error(`✗ posix-guard: ${parsed.error}`);
    process.exit(1);
  }
  const scan = scanTree(repoRoot);
  const previous = loadPosixBaseline(baselinePath);
  const { growth } = compareToBaseline(scan, previous);
  if (previous.fileExisted && growth.length > 0 && !parsed.allowGrowth) {
    console.error(formatGrowth({ growth, shrunk: [] }));
    console.error(`\n✗ refusing to raise ${BASELINE_REL} without --allow-growth --reason "<text>".`);
    process.exit(1);
  }
  const entries = countsByFile(scan);
  fs.writeFileSync(baselinePath, serializePosixBaseline({ entries }), 'utf8');
  console.log(`✓ ${BASELINE_REL}: ${Object.keys(entries).length} file(s) grandfathered (${totalsLine(entries)}).`);
  if (parsed.allowGrowth) console.log(`  growth allowed (${parsed.reason}); repeat that reason in the commit message.`);
}

function list(): void {
  const scan = scanTree(repoRoot);
  for (const [file, findings] of scan) {
    for (const f of findings) console.log(`${f.rule}  ${file}:${f.line}  ${f.text}`);
  }
  console.log(`\n(${totalsLine(countsByFile(scan))})`);
}

function check(): void {
  const baseline = loadPosixBaseline(baselinePath);
  const cmp = compareToBaseline(scanTree(repoRoot), baseline);
  const hint = formatShrinkHint(cmp);
  if (hint) console.log(hint);
  if (cmp.growth.length > 0) {
    console.error(formatGrowth(cmp));
    process.exit(1);
  }
  console.log(`✓ posix-guard: no new Windows-hostile patterns (grandfathered ${totalsLine(baseline.entries)}).`);
  if (!baseline.fileExisted) console.log(`  (no ${BASELINE_REL}; run \`${UPDATE_CMD}\` to create it)`);
}

const argv = process.argv.slice(2);
if (argv.includes('--update-baseline')) update(argv);
else if (argv.includes('--list')) list();
else check();
