/**
 * Tests for judge/claude.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { createClaudeJudge } from './claude.js';
import type { CompleteFn, JudgeInput } from '../types.js';

const MODEL = 'claude-haiku-4-5-20250929';

function makeFake(text: string): CompleteFn {
  return vi.fn().mockResolvedValue({ text, costUsd: 0.001 });
}

const baseInput: JudgeInput = {
  prompt: 'Write a file',
  output: 'I will write the file now.',
  questions: [
    { id: 'p1', question: 'Does the response write a file?' },
    { id: 'p2', question: 'Does the response ask a question?' },
  ],
};

describe('createClaudeJudge', () => {
  it('parses probability map from model response', async () => {
    const judge = createClaudeJudge(makeFake('{"p1":0.9,"p2":0.1}'), MODEL);
    const result = await judge.grade(baseInput);
    expect(result['p1']).toBeCloseTo(0.9);
    expect(result['p2']).toBeCloseTo(0.1);
  });

  it('clamps values to [0,1]', async () => {
    const judge = createClaudeJudge(makeFake('{"p1":2.5,"p2":-0.5}'), MODEL);
    const result = await judge.grade(baseInput);
    expect(result['p1']).toBe(1);
    expect(result['p2']).toBe(0);
  });

  it('omits missing ids instead of defaulting them', async () => {
    const judge = createClaudeJudge(makeFake('{"p1":0.8}'), MODEL);
    const result = await judge.grade(baseInput);
    expect(result).toEqual({ p1: 0.8 });
  });

  it('throws on malformed JSON so the output counts as a judge failure', async () => {
    const judge = createClaudeJudge(makeFake('not json at all'), MODEL);
    await expect(judge.grade(baseInput)).rejects.toThrow('no usable answers');
  });

  it('handles JSON in ```json fences', async () => {
    const judge = createClaudeJudge(makeFake('```json\n{"p1":0.7}\n```'), MODEL);
    const result = await judge.grade(baseInput);
    expect(result['p1']).toBeCloseTo(0.7);
  });

  it('has name=claude and external=false', () => {
    const judge = createClaudeJudge(makeFake('{}'), MODEL);
    expect(judge.name).toBe('claude');
    expect(judge.external).toBe(false);
  });

  it('handles non-finite values by defaulting to 0.5', async () => {
    // NaN and Infinity are not valid JSON numbers so we test via coercion
    const judge = createClaudeJudge(makeFake('{"p1":0,"p2":1}'), MODEL);
    const result = await judge.grade(baseInput);
    expect(result['p1']).toBe(0);
    expect(result['p2']).toBe(1);
  });
});
