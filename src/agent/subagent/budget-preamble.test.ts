import { describe, it, expect } from 'vitest';

import {
  injectToolBudgetPreamble,
  renderBudgetPreamble,
  renderUnboundedLimitsNote,
} from './budget-preamble.js';
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

  // Code-writing subagents must not interpret "partial answer" as permission
  // to return knowingly broken or unverified code. The caveat distinguishes
  // partial research (acceptable) from incomplete engineering (never acceptable).
  it('distinguishes partial research results from incomplete code output', () => {
    const text = renderBudgetPreamble(50);
    expect(text).toContain('internally consistent checkpoint');
    expect(text).toContain('not knowingly broken');
  });

  it('interpolates the actual cap, not a hardcoded default', () => {
    expect(renderBudgetPreamble(12)).toContain('12 tool-use rounds');
    expect(renderBudgetPreamble(12)).not.toContain('50 tool-use rounds');
  });

  // Regression: the "roughly 50 and roughly 500" example used to be a hardcoded
  // literal that stayed put regardless of maxRounds, so a small cap (e.g. 7)
  // rendered a preamble that contradicted itself — "7 is a hard ceiling"
  // alongside an example scaled for 50. The example must track maxRounds.
  it('scales the batching example to the default cap of 50', () => {
    expect(renderBudgetPreamble(50)).toContain('roughly 50 and roughly 500 tool calls');
  });

  it('scales the batching example to a small cap instead of the hardcoded 50/500', () => {
    const text = renderBudgetPreamble(7);
    expect(text).toContain('roughly 7 and roughly 70 tool calls');
    expect(text).not.toContain('roughly 50');
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

  // `0` means unbounded (resolveMaxToolIterations) — no round cap to disclose,
  // but wall-clock and idle limits still apply, so we emit the limits note
  // rather than returning the config unchanged (#5313 item 1).
  it.each([
    ['unset', undefined],
    ['zero (unbounded)', 0],
    ['negative', -1],
  ])('emits the limits note (not a no-op) when the cap is %s', (_label, cap) => {
    const config: AgentConfig = {
      systemPrompt: 'untouched',
      ...(cap === undefined ? {} : { maxToolUseIterations: cap }),
    };
    const out = injectToolBudgetPreamble(config);
    // Must produce a NEW object (not the original) containing the limits note.
    expect(out).not.toBe(config);
    expect(out.systemPrompt as string).toContain('# Tool budget');
    expect(out.systemPrompt as string).toContain('untouched');
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

  // Unbounded children (0 / undefined / non-finite) previously received no
  // limits note at all. Now they get renderUnboundedLimitsNote() appended so
  // they know about the wall-clock abort and idle watchdog (#5313 item 1).
  it('appends the limits note for an unbounded child with an existing prompt', () => {
    const config: AgentConfig = { systemPrompt: 'You are the research agent.' };
    const out = injectToolBudgetPreamble(config);
    expect(typeof out.systemPrompt).toBe('string');
    expect(out.systemPrompt as string).toMatch(/^You are the research agent\./);
    expect(out.systemPrompt as string).toContain('# Tool budget');
    // Unbounded path must NOT claim a numeric round cap.
    expect(out.systemPrompt as string).not.toMatch(/\d+ tool-use rounds/);
  });

  it('sets the limits note as the prompt when no prompt is set for unbounded child', () => {
    const out = injectToolBudgetPreamble({});
    expect(out.systemPrompt).toBe(renderUnboundedLimitsNote());
  });
});

describe('renderUnboundedLimitsNote', () => {
  it('opens with the Tool budget heading', () => {
    expect(renderUnboundedLimitsNote()).toMatch(/^# Tool budget/);
  });

  it('mentions wall-clock and idle-watchdog limits', () => {
    const text = renderUnboundedLimitsNote();
    expect(text).toContain('wall-clock');
    expect(text).toContain('idle-watchdog');
  });

  it('does not claim a numeric round cap', () => {
    expect(renderUnboundedLimitsNote()).not.toMatch(/\d+ tool-use rounds/);
    expect(renderUnboundedLimitsNote()).not.toContain('hard ceiling');
  });

  it('includes the convergence sentence', () => {
    expect(renderUnboundedLimitsNote()).toContain('stop gathering and answer now');
  });

  it('includes the code-quality caveat', () => {
    expect(renderUnboundedLimitsNote()).toContain('internally consistent checkpoint');
  });
});
