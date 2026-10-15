/**
 * Human-readable messages for the POSIX-assumption guard. Shared by the CLI and
 * the vitest gate so both print the same remediation text.
 *
 * Contract: pure string builders; no I/O.
 */

import { RULE_FIXES, RULE_IDS, RULE_TITLES } from './posix-guard-rules.js';
import { BASELINE_REL, type Comparison } from './posix-guard.js';

export const UPDATE_CMD = 'pnpm audit:posix:update';

/** Failure text for growth: every offending site plus exactly what to do instead. */
export function formatGrowth(cmp: Comparison): string {
  const lines: string[] = [
    `✗ posix-guard: ${cmp.growth.length} new Windows-hostile pattern(s) (baseline: ${BASELINE_REL}).`,
    '',
  ];
  for (const rule of RULE_IDS) {
    const group = cmp.growth.filter((g) => g.rule === rule);
    if (group.length === 0) continue;
    lines.push(`  ${rule} — ${RULE_TITLES[rule]}:`);
    for (const g of group) {
      lines.push(`    ${g.file}  (${g.baseline} grandfathered → ${g.actual})`);
      for (const s of g.sites) lines.push(`      ${g.file}:${s.line}  ${s.text}`);
    }
    lines.push(`    Fix: ${RULE_FIXES[rule]}`, '');
  }
  lines.push(
    'Do not raise the baseline to make this pass. If a site is genuinely correct (e.g. code that',
    `only ever runs on POSIX by construction), record it deliberately with:`,
    `  ${UPDATE_CMD} --allow-growth --reason "<why this site is safe on Windows>"`,
  );
  return lines.join('\n');
}

/** Non-failing hint when grandfathered sites were removed. */
export function formatShrinkHint(cmp: Comparison): string {
  if (cmp.shrunk.length === 0) return '';
  const lines = [`ℹ posix-guard: ${cmp.shrunk.length} grandfathered count(s) dropped — thank you. Optionally run`];
  lines.push(`  \`${UPDATE_CMD}\` to lower ${BASELINE_REL} (not required; shrinking always passes):`);
  for (const s of cmp.shrunk) lines.push(`    ${s.file}  ${s.rule}: ${s.baseline} → ${s.actual}`);
  return lines.join('\n');
}
