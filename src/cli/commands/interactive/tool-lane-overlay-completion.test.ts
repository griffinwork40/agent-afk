/**
 * Tests for formatFlatRootCompletion — the toolCard wiring into the primary
 * flat-root overlay completion path.
 *
 * These tests verify:
 *   1. Successful completion renders the done badge.
 *   2. Error results render the error badge.
 *   3. Benign failures (blocked) render the blocked badge.
 *   4. The batch badge is appended when provided.
 *   5. The elapsed value is forwarded to the component.
 *   6. The output is a single line (collapsed mode — no body lines).
 *   7. toolCard is used (header only) — no ' — ✓ outcome' inline format.
 */

import { describe, it, expect } from 'vitest';
import { formatFlatRootCompletion } from './tool-lane-overlay-completion.js';
import { stripAnsi } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';

function makeResult(opts: Partial<ToolResultChunk> = {}): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 'test-id',
    content: 'ok',
    isError: false,
    ...opts,
  };
}

describe('formatFlatRootCompletion', () => {
  it('returns a single line (collapsed — no body)', () => {
    const line = formatFlatRootCompletion('bash', makeResult(), 1000, '', 80);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('done result includes tool name', () => {
    const plain = stripAnsi(formatFlatRootCompletion('read_file', makeResult(), 500, '', 80));
    expect(plain).toContain('read_file');
  });

  it('done result renders done badge (✓)', () => {
    const plain = stripAnsi(formatFlatRootCompletion('bash', makeResult({ isError: false }), 500, '', 80));
    expect(plain).toContain('✓');
  });

  it('error result renders error badge (✗)', () => {
    const plain = stripAnsi(formatFlatRootCompletion('bash', makeResult({ isError: true }), 500, '', 80));
    expect(plain).toContain('✗');
  });

  it('benign failure renders blocked badge (⊘)', () => {
    const plain = stripAnsi(formatFlatRootCompletion(
      'ask_question',
      makeResult({ isError: true, failureClass: 'policy-refusal' }),
      500,
      '',
      80,
    ));
    expect(plain).toContain('⊘');
  });

  it('batch badge is appended to the header line', () => {
    const badge = ' ∥2/3';
    const plain = stripAnsi(formatFlatRootCompletion('bash', makeResult(), 500, badge, 80));
    expect(plain).toContain('∥2/3');
  });

  it('empty batch badge produces no extra content', () => {
    const withBadge = formatFlatRootCompletion('bash', makeResult(), 500, ' ∥1/2', 80);
    const noBadge   = formatFlatRootCompletion('bash', makeResult(), 500, '', 80);
    // The version with a badge must be strictly longer (badge adds characters).
    expect(stripAnsi(withBadge).length).toBeGreaterThan(stripAnsi(noBadge).length);
  });

  it('elapsed ≥ 1000ms shows elapsed seconds in the line', () => {
    // tool-card.ts uses render/utils.js formatElapsed which shows '3s' for 3000ms.
    const plain = stripAnsi(formatFlatRootCompletion('bash', makeResult(), 3000, '', 80));
    expect(plain).toMatch(/\d+s/);
  });

  it('elapsed < 1000ms shows <1s placeholder', () => {
    // tool-card.ts uses render/utils.js formatElapsed which returns '<1s' for <1000ms.
    const plain = stripAnsi(formatFlatRootCompletion('bash', makeResult(), 500, '', 80));
    expect(plain).toContain('<1s');
  });

  it('output does not use the old inline outcome format (— ✓)', () => {
    // toolCard collapsed mode never emits ' — ✓' — that is the old inline format.
    const plain = stripAnsi(formatFlatRootCompletion('bash', makeResult(), 500, '', 80));
    expect(plain).not.toContain(' — ');
  });
});
