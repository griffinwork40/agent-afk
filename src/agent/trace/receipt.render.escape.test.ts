/**
 * Tests for `escapeCell` behavior in `renderReceiptMarkdown` byModel rows.
 *
 * Covers Item 1 (security): a model key containing `|`, newline, and image
 * syntax must not break the GFM table or inject forged rows.
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

describe('renderReceiptMarkdown: escapeCell for byModel keys', () => {
  it('escapes a key containing pipe, newline, and image syntax', () => {
    const maliciousKey = 'evil|model\n![x](http://example.invalid/a.png)';
    const r: RunReceipt = {
      ...BASE,
      subagents: {
        started: 1,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        byModel: {
          [maliciousKey]: { started: 1, succeeded: 1, failed: 0, cancelled: 0, costUsd: 0.01, requested: ['evil'] },
        },
      },
    };
    const md = renderReceiptMarkdown(r);
    const lines = md.split('\n');

    // Exactly one line must start with "| Subagents (" for this key.
    const subagentLines = lines.filter(l => l.startsWith('| Subagents ('));
    expect(subagentLines).toHaveLength(1);

    // The key portion must not contain an unescaped pipe inside the parens.
    // The cell boundary pipes are at column 0 and after the closing paren+space.
    // Extract the text between "| Subagents (" and the next " |" separator.
    const line = subagentLines[0]!;
    const keyStart = line.indexOf('| Subagents (') + '| Subagents ('.length;
    const keyEnd = line.indexOf(') |', keyStart);
    expect(keyEnd).toBeGreaterThan(keyStart);
    const keyPortion = line.slice(keyStart, keyEnd);
    // No unescaped pipe inside the key portion.
    expect(keyPortion).not.toMatch(/(?<!\\)\|/);

    // No line of the output starts with content injected after the newline.
    const injectedLine = lines.find(l => l.startsWith('![x]('));
    expect(injectedLine).toBeUndefined();

    // The raw image substring must not appear unescaped anywhere in the output.
    expect(md).not.toContain('![x](');
  });

  it('leaves a plain key like claude-sonnet-4-6 unchanged', () => {
    const plainKey = 'claude-sonnet-4-6';
    const r: RunReceipt = {
      ...BASE,
      subagents: {
        started: 1,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        byModel: {
          [plainKey]: { started: 1, succeeded: 1, failed: 0, cancelled: 0, costUsd: 0.02, requested: ['sonnet'] },
        },
      },
    };
    const md = renderReceiptMarkdown(r);
    expect(md).toContain(`| Subagents (${plainKey}) |`);
  });

  it('leaves a (mixed) key unchanged', () => {
    const mixedKey = 'claude-sonnet-4-6 (mixed)';
    const r: RunReceipt = {
      ...BASE,
      subagents: {
        started: 2,
        succeeded: 2,
        failed: 0,
        cancelled: 0,
        byModel: {
          [mixedKey]: { started: 2, succeeded: 2, failed: 0, cancelled: 0, costUsd: 0.03, requested: ['sonnet'] },
        },
      },
    };
    const md = renderReceiptMarkdown(r);
    expect(md).toContain(`| Subagents (${mixedKey}) |`);
  });
});
