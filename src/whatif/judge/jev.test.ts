/**
 * Tests for judge/jev.ts — including multiple Jev result shape variants.
 */

import { describe, it, expect, vi } from 'vitest';
import { createJevJudge, parseJevResult } from './jev.js';
import type { JudgeInput, JudgeQuestion } from '../types.js';

const questions: JudgeQuestion[] = [
  { id: 'p1', question: 'Does the response ask first?' },
  { id: 'p2', question: 'Does the response use a tool?' },
];

const baseInput: JudgeInput = {
  prompt: 'do something',
  output: 'sure, I will ask first',
  questions,
};

// ---------------------------------------------------------------------------
// parseJevResult unit tests (exported for testing)
// ---------------------------------------------------------------------------

describe('parseJevResult', () => {
  it('Shape A: flat id→probability map from ToolResult.content string', () => {
    const raw = { content: '{"p1":0.9,"p2":0.2}', isError: false };
    const result = parseJevResult(raw, questions);
    expect(result['p1']).toBeCloseTo(0.9);
    expect(result['p2']).toBeCloseTo(0.2);
  });

  it('Shape A: flat map as raw object directly', () => {
    const raw = { p1: 0.85, p2: 0.15 };
    const result = parseJevResult(raw, questions);
    expect(result['p1']).toBeCloseTo(0.85);
    expect(result['p2']).toBeCloseTo(0.15);
  });

  it('Shape B: answers array with p_yes field', () => {
    const raw = { content: JSON.stringify({ answers: [{ id: 'p1', p_yes: 0.8 }, { id: 'p2', p_yes: 0.3 }] }) };
    const result = parseJevResult(raw, questions);
    expect(result['p1']).toBeCloseTo(0.8);
    expect(result['p2']).toBeCloseTo(0.3);
  });

  it('Shape B: answers array with probability field', () => {
    const raw = { content: JSON.stringify({ answers: [{ id: 'p1', probability: 0.6 }, { id: 'p2', probability: 0.4 }] }) };
    const result = parseJevResult(raw, questions);
    expect(result['p1']).toBeCloseTo(0.6);
    expect(result['p2']).toBeCloseTo(0.4);
  });

  it('Shape B: answers array with yes_probability field', () => {
    const raw = { content: JSON.stringify({ answers: [{ id: 'p1', yes_probability: 0.75 }] }) };
    const result = parseJevResult(raw, questions);
    expect(result['p1']).toBeCloseTo(0.75);
    expect(result['p2']).toBeUndefined(); // missing → omitted
  });

  it('Shape B: answers array with p field', () => {
    const raw = { content: JSON.stringify({ answers: [{ id: 'p1', p: 0.55 }, { id: 'p2', p: 0.45 }] }) };
    const result = parseJevResult(raw, questions);
    expect(result['p1']).toBeCloseTo(0.55);
    expect(result['p2']).toBeCloseTo(0.45);
  });

  it('clamps values above 1 to 1', () => {
    const raw = { content: '{"p1":1.5,"p2":-0.3}' };
    const result = parseJevResult(raw, questions);
    expect(result['p1']).toBe(1);
    expect(result['p2']).toBe(0);
  });

  it('omits missing ids instead of defaulting them', () => {
    const raw = { content: '{"p1":0.9}' };
    const result = parseJevResult(raw, questions);
    expect(result).toEqual({ p1: 0.9 });
  });

  it('returns an empty map on empty/malformed content', () => {
    expect(parseJevResult({ content: 'not json', isError: true }, questions)).toEqual({});
  });

  it('Shape C: the real jev_ask payload (answers keyed by id, P(yes) in noul)', () => {
    // Captured verbatim from jev 0.5.1 / jev-1.13.0 on 2026-09-26.
    const raw = {
      content: JSON.stringify({
        answers: { p1: { type: 'noul', noul: 0.97 }, p2: { type: 'noul', noul: 0.02 } },
        none_options: {},
        model: 'jev-1.13.0',
        usage: { input_tokens: 319, output_tokens: 38 },
        latency_ms: 383,
      }),
    };
    const result = parseJevResult(raw, questions);
    expect(result['p1']).toBeCloseTo(0.97);
    expect(result['p2']).toBeCloseTo(0.02);
  });

  it('handles bare string input', () => {
    const result = parseJevResult('{"p1":0.7,"p2":0.3}', questions);
    expect(result['p1']).toBeCloseTo(0.7);
    expect(result['p2']).toBeCloseTo(0.3);
  });

  it('handles null/undefined gracefully', () => {
    expect(parseJevResult(null, questions)).toEqual({});
  });

  it('handles JSON embedded in prose', () => {
    const raw = { content: 'Here are my results:\n{"p1":0.9,"p2":0.1}\nDone.' };
    const result = parseJevResult(raw, questions);
    expect(result['p1']).toBeCloseTo(0.9);
    expect(result['p2']).toBeCloseTo(0.1);
  });
});

// ---------------------------------------------------------------------------
// createJevJudge integration tests (fake callTool)
// ---------------------------------------------------------------------------

describe('createJevJudge', () => {
  it('calls jev_ask with correct wire name and args', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: '{"p1":0.9,"p2":0.1}' });
    const judge = createJevJudge({ callTool });
    await judge.grade(baseInput);
    expect(callTool).toHaveBeenCalledWith(
      'mcp__jev__jev_ask',
      expect.objectContaining({ yes_at_or_above: 0.7, no_at_or_below: 0.3 }),
      undefined,
    );
  });

  it('passes questions as check-type array', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: '{"p1":0.5}' });
    const judge = createJevJudge({ callTool });
    await judge.grade(baseInput);
    const args = (callTool.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    const qs = args['questions'] as { id: string; type: string }[];
    expect(qs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'p1', type: 'check' }),
        expect.objectContaining({ id: 'p2', type: 'check' }),
      ]),
    );
  });

  it('has name=jev and external=true', () => {
    const judge = createJevJudge({ callTool: vi.fn() });
    expect(judge.name).toBe('jev');
    expect(judge.external).toBe(true);
  });

  it('forwards signal to callTool', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: '{"p1":0.5}' });
    const judge = createJevJudge({ callTool });
    const ac = new AbortController();
    await judge.grade(baseInput, ac.signal);
    const sig = (callTool.mock.calls[0] as unknown[])[2];
    expect(sig).toBeDefined();
  });

  it('throws when jev returns no usable answers (counted as a judge failure)', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: '{}' });
    const judge = createJevJudge({ callTool });
    await expect(judge.grade(baseInput)).rejects.toThrow('no usable answers');
  });

  it('propagates callTool errors', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('timeout'));
    const judge = createJevJudge({ callTool });
    await expect(judge.grade(baseInput)).rejects.toThrow('timeout');
  });
});
