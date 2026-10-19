#!/usr/bin/env tsx
/**
 * check-test-typecheck.ts — one-way ratchet for test-file TypeScript errors.
 *
 * Runs `tsc -p tsconfig.test.json --noEmit`, counts `error TS` lines in the
 * output, and compares the count to the committed baseline in
 * `.test-typecheck-baseline.json`.
 *
 * This gate exists because the advisory `lint:tests || true` in CI keeps the
 * step permanently green, making a rising error count invisible. The ratchet
 * fails when the count grows, so regressions are caught while the burn-down
 * of #3053 continues.
 *
 * Modes:
 *   (default) / --check   compare current count to baseline. Non-zero exit on
 *                         regression (count > baseline).
 *   --update              rewrite `.test-typecheck-baseline.json` from the
 *                         current measured count. Only shrinks are automatic;
 *                         growth requires --allow-growth.
 *   --allow-growth        permit the baseline to increase (requires --reason).
 *   --reason "<text>"     required with --allow-growth; stamped in the file.
 *
 * Constraints (project-wide conventions, see AFK.md):
 *   - No raw process.env reads (reads from function args only).
 *   - No raw chalk colors (uses ANSI constants directly).
 *   - POSIX guard: tsc is invoked via execFileSync on node_modules/.bin/tsc,
 *     never via exec/spawn with a shell string.
 *   - File ceiling: ≤350 code lines; function ceiling: ≤200 lines.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGrowthArgs } from './lib/growth-args.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const BASELINE_REL = '.test-typecheck-baseline.json';
const TSCONFIG_REL = 'tsconfig.test.json';

/** Pattern that TypeScript emits for each type error. */
const ERROR_TS_RE = /^.*error TS\d+:/m;

/**
 * Option/config diagnostics invalidate the semantic error count. Besides TS6xxx,
 * TS18002 (empty files list) and TS18003 (no inputs) can hide the entire suite.
 * Do not match all TS18xxx: that range also contains ordinary semantic errors.
 */
const CONFIG_DIAGNOSTIC_RE = /^.*error TS(?:6\d+|18002|18003):/m;

/** Shared by the CLI and its tests; importing this script does not run main(). */
export function detectConfigDiagnosticLines(output: string): string[] {
  return output.split('\n').filter((line) => CONFIG_DIAGNOSTIC_RE.test(line));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function baselinePath(): string {
  return path.join(repoRoot, BASELINE_REL);
}

function tscBin(): string {
  // Resolve tsc from node_modules/.bin so we never shell out to a PATH binary.
  // This satisfies the POSIX guard (R1): the command is a concrete file path,
  // not a shell invocation.
  const bin = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
  if (!fs.existsSync(bin)) {
    throw new Error(`tsc not found at ${bin} — run pnpm install first`);
  }
  return bin;
}

interface Baseline {
  errors: number;
  reason?: string;
}

function readBaseline(): Baseline & { fileExisted: boolean } {
  const p = baselinePath();
  if (!fs.existsSync(p)) return { errors: 0, fileExisted: false };
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<Baseline>;
  return { errors: raw.errors ?? 0, reason: raw.reason, fileExisted: true };
}

function writeBaseline(b: Baseline): void {
  const lines: string[] = [`{ "errors": ${b.errors}`];
  if (b.reason) lines[0] += `, "reason": ${JSON.stringify(b.reason)}`;
  lines[0] += ' }';
  fs.writeFileSync(baselinePath(), lines.join('') + '\n', 'utf8');
}

/** Run tsc and count lines matching `error TS`. */
function measureErrors(): number {
  const tsconfig = path.join(repoRoot, TSCONFIG_REL);
  let output = '';
  try {
    execFileSync(tscBin(), ['-p', tsconfig, '--noEmit'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Exit 0: no errors.
    output = '';
  } catch (err) {
    // tsc exits non-zero when there are errors; stdout/stderr carry the output.
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }

  // Reject config failures before either check or update can use a bogus count.
  const configLines = detectConfigDiagnosticLines(output);
  if (configLines.length > 0) {
    process.stderr.write(
      `\u2717 lint:tests — option/config diagnostics detected (TS6xxx, TS18002, TS18003).\n` +
        `  These errors can prevent semantic type-checking, making the gate blind.\n` +
        `  Fix the tsconfig.test.json configuration first:\n` +
        configLines
          .slice(0, 5)
          .map((l) => `    ${l.trim()}`)
          .join('\n') +
        (configLines.length > 5 ? `\n    … and ${configLines.length - 5} more` : '') +
        '\n',
    );
    process.exit(1);
  }

  return output.split('\n').filter((l) => ERROR_TS_RE.test(l)).length;
}

// ── CLI parsing (no process.env reads — all state from argv) ─────────────────

/**
 * All flags recognised by this script. Passed to `parseGrowthArgs` so that a
 * flag used as a `--reason` value is rejected rather than silently accepted.
 * Previously the local `parseArgs` did not guard this case, causing drift from
 * the contract enforced by `parseGrowthArgs` in the size-ceiling scripts.
 */
const KNOWN_FLAGS = ['--check', '--update', '--allow-growth', '--reason'] as const;

interface ParsedArgs {
  mode: 'check' | 'update';
  allowGrowth: boolean;
  reason: string;
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const args = argv.slice(2);
  const isUpdate = args.includes('--update');

  // --allow-growth is only meaningful with --update; check before parseGrowthArgs
  // so the error message is script-specific.
  if (args.includes('--allow-growth') && !isUpdate) {
    return { error: '--allow-growth is only valid with --update' };
  }

  const growth = parseGrowthArgs(args, KNOWN_FLAGS);
  if ('error' in growth) return growth;

  return { mode: isUpdate ? 'update' : 'check', allowGrowth: growth.allowGrowth, reason: growth.reason };
}

// ── Mode: check ───────────────────────────────────────────────────────────────

function runCheck(): void {
  const baseline = readBaseline();
  const current = measureErrors();
  const baselineCount = baseline.errors;

  if (current > baselineCount) {
    process.stderr.write(
      `\u2717 lint:tests:check — TypeScript error count INCREASED.\n` +
        `  baseline : ${baselineCount}\n` +
        `  current  : ${current}  (+${current - baselineCount})\n` +
        `\n` +
        `  This is a regression in test-file type-safety.\n` +
        `  Fix the new errors introduced by this change, then re-run:\n` +
        `    pnpm lint:tests:check\n` +
        `\n` +
        `  If the increase is intentional (rare — requires justification):\n` +
        `    pnpm lint:tests:update --allow-growth --reason "<why>"\n`,
    );
    process.exit(1);
  }

  if (current < baselineCount) {
    process.stdout.write(
      `\u2713 lint:tests:check passed (${current} errors, down from baseline ${baselineCount}).\n` +
        `  The error count shrank — lower the baseline to lock in the improvement:\n` +
        `    pnpm lint:tests:update\n`,
    );
    // Still a pass — the burn-down is progressing. We only fail on regressions.
    process.exit(0);
  }

  process.stdout.write(`\u2713 lint:tests:check passed (${current} errors, matches baseline).\n`);
  process.exit(0);
}

// ── Mode: update ──────────────────────────────────────────────────────────────

/**
 * Pure helper: given the previous baseline, the current measured error count,
 * and the growth flags, compute the new baseline to write.
 *
 * Exported for unit testing without running tsc.
 *
 * Reason-carry contract:
 *   - allowGrowth + reason         → new reason stamped (growth explicitly approved)
 *   - !allowGrowth, count shrinks  → reason dropped (growth it justified is gone)
 *   - !allowGrowth, count unchanged → previous.reason carried forward (approval still valid)
 *   - !allowGrowth, count grows    → caller rejects before reaching here
 */
export function computeNewBaseline(
  previous: Baseline & { fileExisted: boolean },
  current: number,
  allowGrowth: boolean,
  reason: string,
): Baseline {
  const newBaseline: Baseline = { errors: current };
  if (allowGrowth && reason && current > previous.errors) {
    newBaseline.reason = reason;
  } else if (current === previous.errors && previous.reason?.trim()) {
    newBaseline.reason = previous.reason;
  }
  return newBaseline;
}

function runUpdate(allowGrowth: boolean, reason: string): void {
  const previous = readBaseline();
  const current = measureErrors();

  if (!allowGrowth && current > previous.errors && previous.fileExisted) {
    process.stderr.write(
      `\u2717 lint:tests:update — error count GREW (${previous.errors} → ${current}).\n` +
        `  Refusing to raise the baseline without --allow-growth --reason "<why>".\n` +
        `  Fix the new errors, then re-run pnpm lint:tests:update.\n`,
    );
    process.exit(1);
  }

  writeBaseline(computeNewBaseline(previous, current, allowGrowth, reason));

  const delta = current - previous.errors;
  const sign = delta > 0 ? '+' : '';
  const changeStr = previous.fileExisted ? ` (${sign}${delta} from ${previous.errors})` : '';
  process.stdout.write(
    `\u2713 ${BASELINE_REL} updated: ${current} errors${changeStr}.\n`,
  );
  if (allowGrowth) {
    process.stdout.write(`  Growth allowed — reason: ${reason || '(none)'}\n`);
    process.stdout.write(`  Include this reason in the commit message.\n`);
  }
  process.exit(0);
}

// ── Entry point ───────────────────────────────────────────────────────────────

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(argv1);
  } catch {
    return fileURLToPath(import.meta.url) === argv1;
  }
}

function main(): void {
  const parsed = parseArgs(process.argv);
  if ('error' in parsed) {
    process.stderr.write(`\u2717 check-test-typecheck: ${parsed.error}\n`);
    process.exit(1);
  }

  if (parsed.mode === 'update') {
    runUpdate(parsed.allowGrowth, parsed.reason);
  } else {
    runCheck();
  }
}

if (isMain()) {
  main();
}
