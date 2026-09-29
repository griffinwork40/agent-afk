import { describe, it, expect } from 'vitest';
import {
  PlanTextTracker,
  MIN_PLAN_TEXT_CHARS,
  MAX_PLAN_TEXT_REFUSALS,
} from './plan-text-tracker.js';
import type { ProviderEvent } from '../provider.js';

const text = (t: string): ProviderEvent => ({ type: 'delta.text', text: t });
const toolStart = (name: string, pending?: true): ProviderEvent => ({
  type: 'tool.use.start',
  toolUseId: `id-${name}`,
  toolName: name,
  toolInput: '',
  ...(pending ? { pending } : {}),
});
const toolOut = (name: string): ProviderEvent => ({
  type: 'tool.output',
  toolUseId: `id-${name}`,
  content: 'result',
});
const plan = 'p'.repeat(MIN_PLAN_TEXT_CHARS);

function feed(t: PlanTextTracker, events: ProviderEvent[]): void {
  for (const e of events) t.observe(e);
}

describe('PlanTextTracker', () => {
  it('ok when the current response streamed enough visible text before the tool call', () => {
    const t = new PlanTextTracker();
    t.beginTurn();
    feed(t, [text(plan.slice(0, 40)), text(plan.slice(40)), toolStart('exit_plan_mode', true), toolStart('exit_plan_mode')]);
    expect(t.check()).toBe('ok');
  });

  it('refuses a tool-only response (the observed bug: thinking, then exit_plan_mode, no text)', () => {
    const t = new PlanTextTracker();
    t.beginTurn();
    feed(t, [toolStart('exit_plan_mode')]);
    expect(t.check()).toBe('refuse');
  });

  it('does not count whitespace or a short filler preamble', () => {
    const t = new PlanTextTracker();
    t.beginTurn();
    feed(t, [text('\n\n   \t'.repeat(50)), text('OK, let me finalize the plan now.'), toolStart('exit_plan_mode')]);
    expect(t.check()).toBe('refuse');
  });

  it('text from an EARLIER response in the turn does not count once tool results arrive', () => {
    const t = new PlanTextTracker();
    t.beginTurn();
    // Round 1: long prose + a subagent dispatch, whose result comes back.
    feed(t, [text(plan), toolStart('agent'), toolOut('agent')]);
    // Round 2: exit_plan_mode alone, no new prose.
    feed(t, [toolStart('exit_plan_mode')]);
    expect(t.check()).toBe('refuse');
  });

  it('a sibling tool output in the SAME batch does not erase this response\'s text', () => {
    const t = new PlanTextTracker();
    t.beginTurn();
    // One response: plan text, then two tool calls; the sibling's output is
    // observed before the exit handler runs.
    feed(t, [text(plan), toolStart('read_file'), toolStart('exit_plan_mode'), toolOut('read_file')]);
    expect(t.check()).toBe('ok');
  });

  it('after a refusal, a response that writes the plan passes', () => {
    const t = new PlanTextTracker();
    t.beginTurn();
    feed(t, [toolStart('exit_plan_mode')]);
    expect(t.check()).toBe('refuse');
    feed(t, [toolOut('exit_plan_mode'), text(plan), toolStart('exit_plan_mode')]);
    expect(t.check()).toBe('ok');
  });

  it('stops refusing after the budget is spent and returns warn (never strands the user)', () => {
    const t = new PlanTextTracker();
    t.beginTurn();
    for (let i = 0; i < MAX_PLAN_TEXT_REFUSALS; i++) {
      feed(t, [toolStart('exit_plan_mode')]);
      expect(t.check()).toBe('refuse');
      feed(t, [toolOut('exit_plan_mode')]);
    }
    feed(t, [toolStart('exit_plan_mode')]);
    expect(t.check()).toBe('warn');
  });

  it('beginTurn resets the text window and the refusal budget', () => {
    const t = new PlanTextTracker();
    t.beginTurn();
    feed(t, [text(plan)]);
    for (let i = 0; i < MAX_PLAN_TEXT_REFUSALS; i++) t.check();
    t.beginTurn();
    feed(t, [toolStart('exit_plan_mode')]);
    expect(t.check()).toBe('refuse');
  });

  it('stream.retry drops the partial round so re-streamed text is not double-counted', () => {
    const t = new PlanTextTracker();
    t.beginTurn();
    const half = 'h'.repeat(Math.ceil(MIN_PLAN_TEXT_CHARS / 2) + 1);
    feed(t, [text(half), { type: 'stream.retry' }, text(half.slice(0, 10)), toolStart('exit_plan_mode')]);
    expect(t.check()).toBe('refuse');
  });

  it('tool.output → stream.retry → delta.text(plan): re-emitted plan after a retry is not discarded', () => {
    // Regression: stream.retry did not clear resetArmed, so the stale armed
    // reset fired on the first post-retry delta.text and zeroed roundChars
    // before the plan characters were counted, producing a false refuse.
    const t = new PlanTextTracker();
    t.beginTurn();
    feed(t, [
      toolOut('agent'),          // arms the reset
      { type: 'stream.retry' }, // should clear the armed reset
      text(plan),                // plan re-emitted by the retried stream
      toolStart('exit_plan_mode'),
    ]);
    expect(t.check()).toBe('ok');
  });
});
