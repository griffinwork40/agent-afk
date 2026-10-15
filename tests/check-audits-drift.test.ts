/**
 * Drift test: the gate list in scripts/check-audits.ts must stay in sync with
 * the audit gates run in .github/workflows/ci.yml's lint-build job.
 *
 * Derivation rule (mirrors what check-audits.ts does):
 *   1. Find all `run: pnpm <script>` lines in the lint-build job steps.
 *   2. Keep only lines where the script name matches /^(audit:|scan:.*:check|fix:.*:check)/
 *      AND is a known `*:check` style gate.
 *      More precisely: keep scripts that start with `audit:`, `scan:`, or `fix:`
 *      and end with `:check` or are exactly a `<prefix>:check`.
 *   3. Strip any trailing `--changed-vs ...` arguments.
 *   4. Deduplicate (CI runs audit:funcsize:check twice).
 *   5. Exclude `audit:deps` (network, excluded per spec).
 *
 * If a new gate is added to CI without updating AUDIT_GATES in check-audits.ts,
 * this test fails.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AUDIT_GATES } from '../scripts/check-audits.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ciYml = path.join(repoRoot, '.github', 'workflows', 'ci.yml');

/** Parse the lint-build job's `run: pnpm <script>` lines from ci.yml. */
function deriveCIGates(ciYmlText: string): string[] {
  const gates: string[] = [];

  // Find the lint-build job block. We look for lines starting with `  lint-build:`
  // and collect until the next top-level job definition.
  const lines = ciYmlText.split(/\r?\n/);
  let inLintBuild = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Detect the start of the lint-build job.
    if (/^\s{2}lint-build:/.test(line)) {
      inLintBuild = true;
      continue;
    }

    // Detect end: another top-level job definition at the same indent level.
    // Match only job-key patterns (`  job-name:`) to avoid false-positive breaks
    // on 2-space-indented YAML comments (`  # comment`).
    if (inLintBuild && /^\s{2}[a-zA-Z0-9_-]+:/.test(line)) {
      break;
    }

    if (!inLintBuild) continue;

    const run = collectRunCommand(lines, i);
    if (!run) continue;
    for (const script of pnpmScripts(run.command)) {
      if (!isAuditCheckGate(script)) continue;
      // Exclude audit:deps (network).
      if (script === 'audit:deps') continue;
      gates.push(script);
    }
    i = run.endIndex;
  }

  // Deduplicate while preserving first-occurrence order.
  return [...new Set(gates)];
}

/**
 * Returns true when the script name is an audit/scan/fix check gate.
 * Pattern: starts with `audit:`, `scan:`, or `fix:` and ends with `:check`.
 */
function isAuditCheckGate(script: string): boolean {
  const prefixes = ['audit:', 'scan:', 'fix:'];
  const hasPrefix = prefixes.some((p) => script.startsWith(p));
  if (!hasPrefix) return false;
  // Must end with :check (could be `audit:foo:check` or `fix:pins:check` etc.)
  return script.endsWith(':check');
}

function collectRunCommand(lines: string[], start: number): { command: string; endIndex: number } | undefined {
  const first = lines[start] ?? '';
  const inline = /^\s+run:\s+(.+?)\s*$/.exec(first);
  if (!inline) return undefined;
  const marker = inline[1]?.trim() ?? '';
  if (!['|', '|-', '|+', '>', '>-', '>+'].includes(marker)) return { command: marker, endIndex: start };

  const runIndent = first.search(/\S/);
  const parts: string[] = [];
  let endIndex = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      parts.push('');
      endIndex = i;
      continue;
    }
    const indent = line.search(/\S/);
    if (indent <= runIndent) break;
    parts.push(line.trim());
    endIndex = i;
  }
  return { command: parts.join(' && '), endIndex };
}

function pnpmScripts(command: string): string[] {
  return command
    .split(/\s*(?:&&|;)\s*/)
    .map((part) => /^pnpm\s+(\S+)/.exec(part.trim())?.[1])
    .filter((script): script is string => script !== undefined);
}

describe('check:audits drift test', () => {
  it('parses multiline run blocks, blank lines, chomping markers, dynamic indentation, and compound gates', () => {
    const gates = deriveCIGates(`
jobs:
  lint-build:
    steps:
      - name: grouped
        run: |-
          pnpm audit:env:check && pnpm scan:env:check

          pnpm audit:deps
          pnpm audit:chalk:check --changed-vs origin/main; pnpm fix:pins:check
  other:
    steps: []
`);

    expect(gates).toEqual(['audit:env:check', 'scan:env:check', 'audit:chalk:check', 'fix:pins:check']);
  });

  it('terminates scan at a digit-bearing job name (e.g. test-node26)', () => {
    // Regression guard for the widened job-boundary regex (^\s{2}[a-zA-Z0-9_-]+:).
    // Before the fix the regex excluded digits, so a job like `test-node26:` would
    // not terminate the lint-build scan and its steps would be misclassified.
    //
    // The test-node26 fixture job uses a DIFFERENT gate (audit:funcsize:check) so
    // that bleed-through produces ['audit:env:check', 'audit:funcsize:check'] and
    // the toEqual(['audit:env:check']) assertion fails with the broken regex.
    // Using the same gate in both jobs would allow Set deduplication to mask bleed.
    const gates = deriveCIGates(`
jobs:
  lint-build:
    steps:
      - name: audit
        run: pnpm audit:env:check
  test-node26:
    steps:
      - name: should not appear
        run: pnpm audit:funcsize:check
`);

    expect(gates).toEqual(['audit:env:check']);
  });

  it('ci.yml lint-build audit gates equal AUDIT_GATES in check-audits.ts', () => {
    const ciText = fs.readFileSync(ciYml, 'utf8');
    const ciGates = deriveCIGates(ciText);

    // Sort both for a stable comparison (order in CI vs check-audits.ts may differ).
    const ciSorted = [...ciGates].sort();
    const scriptSorted = [...AUDIT_GATES].sort();

    const onlyInCI = ciSorted.filter((g) => !scriptSorted.includes(g));
    const onlyInScript = scriptSorted.filter((g) => !ciSorted.includes(g));

    const message =
      onlyInCI.length > 0 || onlyInScript.length > 0
        ? [
            'Gate list drift detected:',
            ...(onlyInCI.map((g) => `  IN CI but not check:audits: ${g}`)),
            ...(onlyInScript.map((g) => `  IN check:audits but not CI: ${g}`)),
            '',
            'To fix: update AUDIT_GATES in scripts/check-audits.ts to match ci.yml.',
          ].join('\n')
        : '';

    expect(onlyInCI, message).toEqual([]);
    expect(onlyInScript, message).toEqual([]);
  });
});
