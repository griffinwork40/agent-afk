import { describe, it, expect } from 'vitest';

import { injectToolBudgetPreamble, renderBudgetPreamble } from './budget-preamble.js';
import type { AgentConfig } from '../types/config-types.js';

describe('renderBudgetPreamble', () => {
  it('states the round count and that a round is one reply, not one call', () => {
    const text = renderBudgetPreamble(50);
    expect(text).toContain('50 tool-use rounds');
    expect(text).toContain('costs 1 round, not 5');
  });

  // The framing is load-bearing, not decoration: disclosing a budget WITHOUT
  // "ceiling, not target" risks inverting the fix into "I have 50 rounds, let
  // me use them". Assert the framing survives future edits to the wording.
  it('frames the budget as a ceiling to finish under, not an allowance to spend', () => {
    const text = renderBudgetPreamble(50);
    expect(text).toContain('hard ceiling, not a target');
    expect(text).toContain('stop gathering and answer now');
  });

  it('interpolates the actual cap, not a hardcoded default', () => {
    expect(renderBudgetPreamble(12)).toContain('12 tool-use rounds');
    expect(renderBudgetPreamble(12)).not.toContain('50 tool-use rounds');
  });
});

describe('injectToolBudgetPreamble', () => {
  it('appends after an existing string prompt so the child mission keeps top salience', () => {
    const config: AgentConfig = { systemPrompt: 'You are the research agent.', maxToolUseIterations: 50 };
    const out = injectToolBudgetPreamble(config);
    expect(typeof out.systemPrompt).toBe('string');
    expect(out.systemPrompt as string).toMatch(/^You are the research agent\./);
    expect(out.systemPrompt as string).toContain('50 tool-use rounds');
  });

  it('becomes the system prompt when none is set', () => {
    const out = injectToolBudgetPreamble({ maxToolUseIterations: 20 });
    expect(out.systemPrompt).toBe(renderBudgetPreamble(20));
  });

  it('treats an empty-string prompt as absent rather than emitting leading blank lines', () => {
    const out = injectToolBudgetPreamble({ systemPrompt: '', maxToolUseIterations: 20 });
    expect(out.systemPrompt).toBe(renderBudgetPreamble(20));
  });

  it('appends into the append slot of a preset prompt', () => {
    const out = injectToolBudgetPreamble({
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'extra' },
      maxToolUseIterations: 30,
    });
    expect(out.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: `extra\n\n${renderBudgetPreamble(30)}`,
    });
  });

  it('fills an empty preset append without a leading separator', () => {
    const out = injectToolBudgetPreamble({
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      maxToolUseIterations: 30,
    });
    expect(out.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: renderBudgetPreamble(30),
    });
  });

  // `0` means unbounded (resolveMaxToolIterations) — a child with no ceiling
  // has no budget to disclose, and claiming one would be a lie.
  it.each([
    ['unset', undefined],
    ['zero (unbounded)', 0],
    ['negative', -1],
  ])('is a no-op when the cap is %s', (_label, cap) => {
    const config: AgentConfig = {
      systemPrompt: 'untouched',
      ...(cap === undefined ? {} : { maxToolUseIterations: cap }),
    };
    const out = injectToolBudgetPreamble(config);
    expect(out).toBe(config);
    expect(out.systemPrompt).toBe('untouched');
  });

  it('floors a fractional cap rather than printing a decimal', () => {
    const out = injectToolBudgetPreamble({ maxToolUseIterations: 12.7 });
    expect(out.systemPrompt).toContain('12 tool-use rounds');
    expect(out.systemPrompt).not.toContain('12.7');
  });

  it('does not mutate the input config', () => {
    const config: AgentConfig = { systemPrompt: 'original', maxToolUseIterations: 50 };
    injectToolBudgetPreamble(config);
    expect(config.systemPrompt).toBe('original');
  });
});
