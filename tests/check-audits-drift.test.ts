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
  const lines = ciYmlText.split('\n');
  let inLintBuild = false;
  let jobIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Detect the start of the lint-build job.
    if (/^\s{2}lint-build:/.test(line)) {
      inLintBuild = true;
      jobIndent = 2;
      continue;
    }

    // Detect end: another top-level job at the same indent level.
    if (inLintBuild && /^\s{2}\S/.test(line) && !/^\s{4}/.test(line)) {
      break;
    }

    if (!inLintBuild) continue;

    // Match `run: pnpm <script>` lines (with optional leading spaces).
    // The script may have arguments after it.
    const m = /^\s+run:\s+pnpm\s+(\S+)(.*)$/.exec(line);
    if (!m) continue;

    const script = m[1]?.trim() ?? '';
    // Keep only audit/scan/fix check gates.
    if (!isAuditCheckGate(script)) continue;
    // Exclude audit:deps (network).
    if (script === 'audit:deps') continue;

    gates.push(script);
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

describe('check:audits drift test', () => {
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
