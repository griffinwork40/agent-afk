/**
 * Unit tests for the SPINE classifier parse pipeline.
 *
 * Tests `parseClassifierOutput` (exported for testability) directly — no LLM
 * calls needed. Covers the JSON extraction strategies, validation rules, and
 * sanitization behaviour described in the PR #1649 review.
 */

import { describe, expect, it } from 'vitest';
import { parseClassifierOutput, escapeDataBlock } from './spine-classifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a JSON string in a markdown JSON fence. */
function fence(json: string): string {
  return '```json\n' + json + '\n```';
}

/** Minimal valid new-addition item. */
const VALID_NEW_ADDITION = JSON.stringify([
  {
    label: 'new-addition',
    prefix: 'INV',
    description: 'All env vars go through env.ts',
    rationale: 'Centralises configuration access',
  },
]);

/** Minimal valid strengthens item. */
const VALID_STRENGTHENS = JSON.stringify([
  {
    label: 'strengthens',
    existingId: 'INV-001',
    existingDescription: 'All env vars go through env.ts',
    description: 'New module also uses env.ts',
    rationale: 'See src/config/env.ts',
  },
]);

// ---------------------------------------------------------------------------
// escapeDataBlock — prompt injection guard
// ---------------------------------------------------------------------------

describe('escapeDataBlock', () => {
  it('escapes triple-backtick sequences', () => {
    expect(escapeDataBlock('```')).toBe('` ` `');
    expect(escapeDataBlock('here\n```\nend')).toBe('here\n` ` `\nend');
  });

  it('escapes XML closing-tag opener (</) to prevent early block termination', () => {
    expect(escapeDataBlock('</git-diff>')).toBe('&lt;/git-diff>');
    expect(escapeDataBlock('</spine-content>')).toBe('&lt;/spine-content>');
  });

  it('escapes all < characters, not just </', () => {
    // A bare < could open a tag too; escaping all < is the safe superset.
    expect(escapeDataBlock('<tag>')).toBe('&lt;tag>');
  });

  it('handles text with both backticks and XML tags', () => {
    const input = '```\n</git-diff>\n```';
    const output = escapeDataBlock(input);
    expect(output).not.toContain('```');
    expect(output).not.toContain('</git-diff>');
    expect(output).toContain('` ` `');
    expect(output).toContain('&lt;/git-diff>');
  });

  it('passes through text with no injection vectors unchanged (modulo < chars)', () => {
    const clean = 'const x = 1;\nfunction foo() {}';
    expect(escapeDataBlock(clean)).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// JSON extraction strategies
// ---------------------------------------------------------------------------

describe('parseClassifierOutput — JSON extraction', () => {
  it('parses a JSON array inside a markdown json fence', () => {
    const result = parseClassifierOutput(fence(VALID_NEW_ADDITION));
    expect(result.parsed).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].label).toBe('new-addition');
  });

  it('parses a bare JSON array with no fence', () => {
    const result = parseClassifierOutput(VALID_NEW_ADDITION);
    expect(result.parsed).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it('parses correctly when trailing prose contains a ] character', () => {
    // The prose "See [note]" contains a ']' that would confuse a naive lastIndexOf scan.
    const raw =
      VALID_NEW_ADDITION +
      '\n\nSome trailing model commentary referencing [note] and another ] here.';
    const result = parseClassifierOutput(raw);
    expect(result.parsed).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].label).toBe('new-addition');
  });

  it('parses fenced content when it is a valid JSON array', () => {
    // Fence contains valid JSON — should be used preferentially
    const raw = 'Here is the result:\n' + fence(VALID_STRENGTHENS) + '\nDone.';
    const result = parseClassifierOutput(raw);
    expect(result.parsed).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].label).toBe('strengthens');
  });

  it('falls back to bare-array scan when fence contains non-JSON', () => {
    // Fence has diff content (not JSON array), bare array is valid
    const raw =
      '```diff\n+const x = 1;\n```\n\n' + VALID_NEW_ADDITION;
    const result = parseClassifierOutput(raw);
    expect(result.parsed).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it('returns parsed:false for a non-JSON response', () => {
    const raw = 'Sorry, I cannot classify this diff.';
    const result = parseClassifierOutput(raw);
    expect(result.parsed).toBe(false);
    expect(result.items).toHaveLength(0);
    expect(result.rawOutput).toBe(raw);
  });

  it('parses empty array [] correctly', () => {
    const result = parseClassifierOutput('[]');
    expect(result.parsed).toBe(true);
    expect(result.items).toHaveLength(0);
  });

  it('parses empty array inside a fence', () => {
    const result = parseClassifierOutput(fence('[]'));
    expect(result.parsed).toBe(true);
    expect(result.items).toHaveLength(0);
  });

  it('preserves rawOutput on failed parse', () => {
    const raw = 'not json at all';
    const result = parseClassifierOutput(raw);
    expect(result.rawOutput).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// Validation rules
// ---------------------------------------------------------------------------

describe('parseClassifierOutput — item validation', () => {
  it('rejects an item with an invalid label', () => {
    const raw = JSON.stringify([
      {
        label: 'hallucinated-label',
        prefix: 'INV',
        description: 'Some desc',
        rationale: 'Some rationale',
      },
    ]);
    const result = parseClassifierOutput(raw);
    expect(result.parsed).toBe(true); // array parsed fine
    expect(result.items).toHaveLength(0); // item rejected
  });

  it('rejects a new-addition item with an invalid prefix', () => {
    const raw = JSON.stringify([
      {
        label: 'new-addition',
        prefix: 'BAD',
        description: 'Some desc',
        rationale: 'Some rationale',
      },
    ]);
    const result = parseClassifierOutput(raw);
    expect(result.parsed).toBe(true);
    expect(result.items).toHaveLength(0);
  });

  it('accepts all three valid prefixes for new-addition', () => {
    for (const prefix of ['INV', 'REJ', 'TST'] as const) {
      const raw = JSON.stringify([
        { label: 'new-addition', prefix, description: 'desc', rationale: 'why' },
      ]);
      const result = parseClassifierOutput(raw);
      expect(result.items).toHaveLength(1);
      if (result.items[0].label === 'new-addition') {
        expect(result.items[0].prefix).toBe(prefix);
      }
    }
  });

  it('rejects a relation item missing required fields', () => {
    // strengthens without existingId
    const raw = JSON.stringify([
      {
        label: 'strengthens',
        existingDescription: 'some',
        description: 'some',
        rationale: 'why',
      },
    ]);
    const result = parseClassifierOutput(raw);
    expect(result.items).toHaveLength(0);
  });

  it('accepts all valid relation labels (strengthens / weakens / contradicts)', () => {
    for (const label of ['strengthens', 'weakens', 'contradicts'] as const) {
      const raw = JSON.stringify([
        {
          label,
          existingId: 'INV-001',
          existingDescription: 'base',
          description: 'change',
          rationale: 'because',
        },
      ]);
      const result = parseClassifierOutput(raw);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].label).toBe(label);
    }
  });

  it('passes an array with a mix of valid and invalid items, keeping only valid', () => {
    const raw = JSON.stringify([
      // valid
      { label: 'new-addition', prefix: 'INV', description: 'desc', rationale: 'why' },
      // invalid — bad label
      { label: 'unknown', prefix: 'INV', description: 'desc', rationale: 'why' },
    ]);
    const result = parseClassifierOutput(raw);
    expect(result.parsed).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].label).toBe('new-addition');
  });
});

// ---------------------------------------------------------------------------
// Sanitization (sanitizeField behaviour)
// ---------------------------------------------------------------------------

describe('parseClassifierOutput — field sanitization', () => {
  it('collapses embedded newlines in description to a single space', () => {
    const raw = JSON.stringify([
      {
        label: 'new-addition',
        prefix: 'INV',
        description: 'Line one\nLine two\r\nLine three',
        rationale: 'Why this matters',
      },
    ]);
    const result = parseClassifierOutput(raw);
    expect(result.parsed).toBe(true);
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    if (item.label === 'new-addition') {
      expect(item.description).not.toContain('\n');
      expect(item.description).not.toContain('\r');
      expect(item.description).toBe('Line one Line two Line three');
    }
  });

  it('truncates description to MAX_DESCRIPTION_LEN (300 chars)', () => {
    const longDesc = 'A'.repeat(400);
    const raw = JSON.stringify([
      { label: 'new-addition', prefix: 'INV', description: longDesc, rationale: 'why' },
    ]);
    const result = parseClassifierOutput(raw);
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    if (item.label === 'new-addition') {
      expect(item.description.length).toBeLessThanOrEqual(300);
    }
  });

  it('trims leading and trailing whitespace from fields', () => {
    const raw = JSON.stringify([
      {
        label: 'new-addition',
        prefix: 'REJ',
        description: '   No raw process.env access   ',
        rationale: '   Security invariant   ',
      },
    ]);
    const result = parseClassifierOutput(raw);
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    if (item.label === 'new-addition') {
      expect(item.description).toBe('No raw process.env access');
    }
  });
});
