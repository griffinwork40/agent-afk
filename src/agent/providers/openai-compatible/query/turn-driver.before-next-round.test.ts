/**
 * applyBeforeNextRound — inter-round steering injection (#2420).
 *
 * Regression focus: after an ordinary tool round the history tail is a
 * `role:'tool'` message; steering text must be appended as a new user turn,
 * never silently dropped (the callback has already drained its queue).
 */
import { describe, it, expect } from 'vitest';
import { applyBeforeNextRound } from './turn-driver.js';
import type { OpenAIMessage } from '../messages.js';

const asMsgs = (m: unknown[]): OpenAIMessage[] => m as OpenAIMessage[];

describe('applyBeforeNextRound', () => {
  it('appends a new user turn when the tail is a tool result', () => {
    const turns = asMsgs([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ]);
    applyBeforeNextRound(turns, 'steer: stop and summarize', undefined, 'sub-1');
    expect(turns).toHaveLength(4);
    expect(turns.at(-1)).toEqual({ role: 'user', content: 'steer: stop and summarize' });
    // The tool message is untouched (OpenAI tool{} content must stay the tool result).
    expect(turns[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });

  it('merges into an existing trailing string user message', () => {
    const turns = asMsgs([{ role: 'user', content: 'image follow-up' }]);
    applyBeforeNextRound(turns, 'steer', undefined, undefined);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ role: 'user', content: 'image follow-up\n\nsteer' });
  });

  it('appends a text part to a trailing array-content user message', () => {
    const turns = asMsgs([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }]);
    applyBeforeNextRound(turns, 'steer', undefined, undefined);
    expect(turns).toHaveLength(1);
    expect((turns[0] as { content: unknown[] }).content.at(-1)).toEqual({ type: 'text', text: 'steer' });
  });

  it('is a no-op when there is no steering text', () => {
    const turns = asMsgs([{ role: 'tool', tool_call_id: 'c1', content: 'ok' }]);
    applyBeforeNextRound(turns, undefined, undefined, undefined);
    applyBeforeNextRound(turns, '', undefined, undefined);
    expect(turns).toHaveLength(1);
  });
});
