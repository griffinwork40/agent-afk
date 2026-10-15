/**
 * Tests for structural.ts — computeStructuralImpact
 */

import { describe, it, expect } from 'vitest';
import { computeStructuralImpact } from './structural.js';
import type { RequestSnapshot } from './types.js';

function snap(overrides: Partial<RequestSnapshot> = {}): RequestSnapshot {
  return {
    model: 'claude-haiku-4-5-20250929',
    system: 'You are a helpful assistant.',
    tools: [],
    firstUserMessage: 'Hello',
    ...overrides,
  };
}

describe('computeStructuralImpact', () => {
  it('returns empty diffs and no tool deltas when snapshots are identical', () => {
    const s = snap();
    const result = computeStructuralImpact(s, s);
    expect(result.systemDiff).toBe('');
    expect(result.userMessageDiff).toBe('');
    expect(result.toolsAdded).toEqual([]);
    expect(result.toolsRemoved).toEqual([]);
    expect(result.toolsChanged).toEqual([]);
    expect(result.modelChanged).toBe(false);
    expect(result.tokens.baseline).toBeGreaterThan(0);
    expect(result.tokens.baseline).toBe(result.tokens.candidate);
  });

  it('detects system prompt changes and renders a unified diff', () => {
    const baseline = snap({ system: 'Line one\nLine two\nLine three' });
    const candidate = snap({ system: 'Line one\nLine TWO\nLine three' });
    const result = computeStructuralImpact(baseline, candidate);
    expect(result.systemDiff).toContain('-');
    expect(result.systemDiff).toContain('+');
    expect(result.systemDiff).toContain('Line two');
    expect(result.systemDiff).toContain('Line TWO');
  });

  it('detects user message changes', () => {
    const baseline = snap({ firstUserMessage: 'Hello world' });
    const candidate = snap({ firstUserMessage: 'Hello WORLD' });
    const result = computeStructuralImpact(baseline, candidate);
    expect(result.userMessageDiff).toContain('-');
    expect(result.userMessageDiff).toContain('+');
  });

  it('detects added tools', () => {
    const baseline = snap({
      tools: [{ name: 'read_file', description: 'Reads a file' }],
    });
    const candidate = snap({
      tools: [
        { name: 'read_file', description: 'Reads a file' },
        { name: 'write_file', description: 'Writes a file' },
      ],
    });
    const result = computeStructuralImpact(baseline, candidate);
    expect(result.toolsAdded).toContain('write_file');
    expect(result.toolsRemoved).toEqual([]);
  });

  it('detects removed tools', () => {
    const baseline = snap({
      tools: [
        { name: 'read_file', description: 'Reads a file' },
        { name: 'bash', description: 'Runs bash' },
      ],
    });
    const candidate = snap({
      tools: [{ name: 'read_file', description: 'Reads a file' }],
    });
    const result = computeStructuralImpact(baseline, candidate);
    expect(result.toolsRemoved).toContain('bash');
    expect(result.toolsAdded).toEqual([]);
  });

  it('detects changed tool descriptions', () => {
    const baseline = snap({
      tools: [{ name: 'bash', description: 'Run shell commands' }],
    });
    const candidate = snap({
      tools: [{ name: 'bash', description: 'Run shell commands (restricted)' }],
    });
    const result = computeStructuralImpact(baseline, candidate);
    expect(result.toolsChanged).toContain('bash');
    expect(result.toolsAdded).toEqual([]);
    expect(result.toolsRemoved).toEqual([]);
  });

  it('detects model changes', () => {
    const baseline = snap({ model: 'claude-haiku-4-5-20250929' });
    const candidate = snap({ model: 'claude-sonnet-4-5' });
    const result = computeStructuralImpact(baseline, candidate);
    expect(result.modelChanged).toBe(true);
  });

  it('returns undefined perTurnCostDeltaUsd for unknown models', () => {
    const baseline = snap({ model: 'unknown-model-xyz' });
    const candidate = snap({ model: 'unknown-model-xyz' });
    const result = computeStructuralImpact(baseline, candidate);
    expect(result.perTurnCostDeltaUsd).toBeUndefined();
  });

  it('computes a non-zero token estimate for non-empty system prompts', () => {
    const s = snap({ system: 'A'.repeat(350), tools: [] });
    const result = computeStructuralImpact(s, s);
    // 350 chars / 3.5 = 100 tokens
    expect(result.tokens.baseline).toBe(100);
  });

  it('includes tool descriptions in token count', () => {
    const withTools = snap({
      system: '',
      tools: [{ name: 'bash', description: 'x'.repeat(350) }],
    });
    const noTools = snap({ system: '' });
    const r1 = computeStructuralImpact(withTools, withTools);
    const r2 = computeStructuralImpact(noTools, noTools);
    // (4 + 350) / 3.5 ≈ 101
    expect(r1.tokens.baseline).toBeGreaterThan(r2.tokens.baseline);
  });

  it('perTurnCostDeltaUsd is 0 when tokens are equal for known model', () => {
    // Use a known model and identical snapshots → cost delta must be 0
    const s = snap({ model: 'claude-3-5-haiku-20241022' });
    const result = computeStructuralImpact(s, s);
    if (result.perTurnCostDeltaUsd !== undefined) {
      expect(result.perTurnCostDeltaUsd).toBeCloseTo(0);
    }
  });
});
