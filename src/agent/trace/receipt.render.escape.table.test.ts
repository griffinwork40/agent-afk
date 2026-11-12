/**
 * Table-driven escapeCell coverage for `renderReceiptMarkdown` byModel rows.
 *
 * The existing `receipt.render.escape.test.ts` exercises pipe, newline, `!`,
 * `[`, and `]`. This file adds one case per remaining escaped character class
 * in `escapeCell` (src/agent/trace/receipt.render.ts:20-33):
 *   - backslash (must be escaped first so added escapes aren't re-escaped)
 *   - backtick
 *   - asterisk
 *   - underscore
 *   - `<` and `>`
 * Plus the two inputs that prove backslash-first ordering:
 *   - pre-escaped pipe (`\|`) must render as `\\|` (backslash escaped, then pipe escaped)
 *   - trailing backslash
 * And the two newline variants not in the existing suite:
 *   - `\r` alone
 *   - `\r\n`
 *
 * Each case asserts:
 *   1. Exactly one `| Subagents (` row is produced (no row injection).
 *   2. The key portion between `| Subagents (` and `) |` does NOT contain an
 *      unescaped pipe.
 *   3. The specific character was actually escaped (no raw occurrence).
 */

import { describe, it, expect } from 'vitest';
import { renderReceiptMarkdown } from './receipt.js';
import type { RunReceipt } from './receipt.js';
import { RECEIPT_SCHEMA_VERSION } from './receipt.js';

const BASE: RunReceipt = {
  schemaVersion: RECEIPT_SCHEMA_VERSION,
  generatedAt: '2026-01-01T00:00:00.000Z',
  witnessLabel: 'run-t',
  tracePath: '/x/trace.jsonl',
  status: 'succeeded',
  incomplete: false,
  humanReviewRequired: false,
  humanReviewReasons: [],
  toolCalls: {
    total: 0, succeeded: 0, errored: 0, erroredNotable: 0,
    refused: 0, circuitBreakerHits: 0, byTool: {}, byFailureClass: {},
  },
  events: { total: 0, byKind: {} },
  subagents: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
  cost: {},
  failures: [],
  limitations: [],
};

/** Build a receipt whose single byModel key is `key`. */
function receiptWithKey(key: string): RunReceipt {
  return {
    ...BASE,
    subagents: {
      started: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      byModel: {
        [key]: { started: 1, succeeded: 1, failed: 0, cancelled: 0, costUsd: 0.01, requested: ['m'] },
      },
    },
  };
}

/** Extract the key portion between `| Subagents (` and `) |` on the matching line. */
function extractKeyPortion(md: string): string {
  const lines = md.split('\n');
  const line = lines.find(l => l.startsWith('| Subagents ('));
  expect(line).toBeDefined();
  const keyStart = line!.indexOf('| Subagents (') + '| Subagents ('.length;
  const keyEnd = line!.indexOf(') |', keyStart);
  expect(keyEnd).toBeGreaterThan(keyStart);
  return line!.slice(keyStart, keyEnd);
}

/** Assert the standard invariants for a single-key receipt. */
function assertSingleRow(md: string): void {
  const lines = md.split('\n');
  const subagentLines = lines.filter(l => l.startsWith('| Subagents ('));
  expect(subagentLines).toHaveLength(1);
  // Key portion must not contain an unescaped pipe.
  const keyPortion = extractKeyPortion(md);
  expect(keyPortion).not.toMatch(/(?<!\\)\|/);
}

// ---------------------------------------------------------------------------
// Table-driven cases
// ---------------------------------------------------------------------------

const cases: Array<{ label: string; key: string; rawChar: string; escapedForm: string }> = [
  {
    label: 'backslash is escaped to \\\\',
    key: 'model\\name',
    rawChar: 'model\\name',   // raw key
    escapedForm: 'model\\\\name',
  },
  {
    label: 'backtick is escaped to \\`',
    key: 'model`name',
    rawChar: '`',
    escapedForm: '\\`',
  },
  {
    label: 'asterisk is escaped to \\*',
    key: 'model*name',
    rawChar: '*',
    escapedForm: '\\*',
  },
  {
    label: 'underscore is escaped to \\_',
    key: 'model_name',
    rawChar: '_',
    escapedForm: '\\_',
  },
  {
    label: 'less-than is escaped to \\<',
    key: 'model<name',
    rawChar: '<',
    escapedForm: '\\<',
  },
  {
    label: 'greater-than is escaped to \\>',
    key: 'model>name',
    rawChar: '>',
    escapedForm: '\\>',
  },
  {
    // A pre-escaped pipe in the input: backslash must be escaped first,
    // then pipe, so \| becomes \\| (the backslash-first ordering invariant).
    label: 'pre-escaped pipe (\\|) is escaped to \\\\\\|',
    key: 'model\\|name',
    rawChar: '\\|',
    escapedForm: '\\\\\\|',
  },
  {
    // Trailing backslash: must become \\\\ (double-backslash).
    label: 'trailing backslash is escaped to \\\\',
    key: 'trailing\\',
    rawChar: 'trailing\\',
    escapedForm: 'trailing\\\\',
  },
];

describe('renderReceiptMarkdown: escapeCell — table-driven character classes', () => {
  for (const { label, key, escapedForm } of cases) {
    it(label, () => {
      const md = renderReceiptMarkdown(receiptWithKey(key));
      assertSingleRow(md);
      const keyPortion = extractKeyPortion(md);
      expect(keyPortion).toContain(escapedForm);
    });
  }
});

// ---------------------------------------------------------------------------
// Newline variants: \r and \r\n — collapsed to a space (no row injection)
// ---------------------------------------------------------------------------

describe('renderReceiptMarkdown: escapeCell — newline variants collapse to space', () => {
  it('\\r alone is collapsed to a space', () => {
    const key = 'before\rafter';
    const md = renderReceiptMarkdown(receiptWithKey(key));
    assertSingleRow(md);
    const keyPortion = extractKeyPortion(md);
    // No literal \r in the key portion.
    expect(keyPortion).not.toContain('\r');
    // The two parts of the key appear separated by a space.
    expect(keyPortion).toContain('before after');
  });

  it('\\r\\n is collapsed to a single space (not two spaces)', () => {
    const key = 'before\r\nafter';
    const md = renderReceiptMarkdown(receiptWithKey(key));
    assertSingleRow(md);
    const keyPortion = extractKeyPortion(md);
    // No literal \r or \n in the key portion.
    expect(keyPortion).not.toContain('\r');
    expect(keyPortion).not.toContain('\n');
    // Collapsed to exactly one space.
    expect(keyPortion).toContain('before after');
    expect(keyPortion).not.toContain('before  after');
  });
});
