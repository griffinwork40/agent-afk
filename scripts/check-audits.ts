#!/usr/bin/env tsx
/**
 * check:audits — Run every deterministic audit gate from the lint-build CI job.
 *
 * Runs ALL gates (no stop-at-first), prints a concise per-gate pass/fail
 * summary with timing, and exits:
 *   0  all gates passed
 *   1  one or more gates failed (but not ALL)
 *   2  every gate failed — probable environment problem (try `pnpm install`)
 *
 * Gates are derived from .github/workflows/ci.yml's lint-build job:
 *   - pnpm audit:env:check
 *   - pnpm scan:env:check
 *   - pnpm audit:sdk:check
 *   - pnpm audit:chalk:check
 *   - pnpm audit:width:check
 *   - pnpm audit:filesize:check      (full-scan; no --changed-vs)
 *   - pnpm audit:funcsize:check      (full-scan; deduped: CI runs it twice)
 *   - pnpm audit:module-state:check
 *   - pnpm fix:pins:check
 *
 * Excluded (per spec):
 *   - audit:deps      (network)
 *   - lint            (tsc --noEmit, not an audit:* gate)
 *   - build
 *   - tests
 *
 * A drift test (tests/check-audits-drift.test.ts) parses ci.yml and asserts
 * the gate list here equals what CI runs.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Gate list ─────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH consumed by the drift test.
// Order matches ci.yml lint-build step order; funcsize appears once (CI dupes).
// --changed-vs args are stripped (full-scan form).
export const AUDIT_GATES: readonly string[] = [
  'audit:env:check',
  'scan:env:check',
  'audit:sdk:check',
  'audit:chalk:check',
  'audit:width:check',
  'audit:filesize:check',
  'audit:funcsize:check',
  'audit:module-state:check',
  'fix:pins:check',
];

// ── Runner ────────────────────────────────────────────────────────────────────

interface GateResult {
  gate: string;
  passed: boolean;
  durationMs: number;
  output: string;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function runGate(gate: string): GateResult {
  const start = Date.now();
  const result = spawnSync('pnpm', [gate], {
    cwd: repoRoot(),
    encoding: 'utf8',
    // Pipe stdio so each gate's output can be shown under its summary line.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = Date.now() - start;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`.trim();
  const passed = result.error ? false : (result.status ?? 1) === 0;
  return { gate, passed, durationMs, output };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function main(): void {
  console.log('Running CI audit gates (full-scan, no --changed-vs)…\n');

  const results: GateResult[] = [];

  for (const gate of AUDIT_GATES) {
    process.stdout.write(`  ${gate} … `);
    const r = runGate(gate);
    results.push(r);
    const marker = r.passed ? '✓' : '✗';
    const timing = formatDuration(r.durationMs);
    console.log(`${marker} (${timing})`);
    if (!r.passed && r.output) {
      // Indent failure output under the gate line.
      const indented = r.output.split('\n').map((l) => `    ${l}`).join('\n');
      console.log(indented);
    }
  }

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  console.log(`\n─── Summary ────────────────────────────────────────────`);
  console.log(`  ${passed.length}/${results.length} gates passed`);

  if (failed.length === 0) {
    console.log('  All audit gates passed.\n');
    process.exit(0);
  }

  console.log(`  Failed gates:`);
  for (const r of failed) {
    console.log(`    ✗ ${r.gate}`);
  }
  console.log();

  if (failed.length === results.length) {
    console.error(
      'Every audit gate failed — this is likely an environment problem, not a code issue.\n' +
        'Try: pnpm install\n',
    );
    process.exit(2);
  }

  process.exit(1);
}

// Only run when executed directly (not when imported by tests).
// import.meta.url is the canonical URL of this module; process.argv[1] is the
// entry-point path. When tsx runs this file directly they resolve to the same file.
import { realpathSync } from 'node:fs';

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
