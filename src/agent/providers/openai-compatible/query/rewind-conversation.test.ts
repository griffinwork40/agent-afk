/**
 * Unit tests for the OpenAI-compatible conversation-rewind helpers.
 *
 * Mirrors anthropic-direct/query/rewind-conversation.test.ts on the OpenAI
 * message shape.
 */

import { describe, it, expect } from 'vitest';
import { listOpenAIUserTurns, rewindOpenAIConversation } from './rewind-conversation.js';
import type { OpenAIMessage } from '../messages.js';
import type { AbortCoordinator } from '../../shared/abort-coordinator.js';

const idleAbort = { isIdle: () => true } as unknown as AbortCoordinator;
const busyAbort = { isIdle: () => false } as unknown as AbortCoordinator;

/** Build a simple conversation with tool-call turns. */
function sampleHistory(): OpenAIMessage[] {
  return [
    // 0: genuine user
    { role: 'user', content: 'first question' } as OpenAIMessage,
    // 1: assistant with tool_calls
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{}' } }] } as unknown as OpenAIMessage,
    // 2: tool result (role: tool — NOT 'user', so not a genuine user turn)
    { role: 'tool', content: 'ok', tool_call_id: 't1' } as unknown as OpenAIMessage,
    // 3: assistant text
    { role: 'assistant', content: 'first answer' } as OpenAIMessage,
    // 4: genuine user
    { role: 'user', content: 'second question' } as OpenAIMessage,
    // 5: assistant text
    { role: 'assistant', content: 'second answer' } as OpenAIMessage,
    // 6: genuine user
    { role: 'user', content: 'third question' } as OpenAIMessage,
    // 7: assistant text
    { role: 'assistant', content: 'third answer' } as OpenAIMessage,
  ];
}

// ---- listOpenAIUserTurns --------------------------------------------------

describe('listOpenAIUserTurns', () => {
  it('enumerates genuine user-text turns newest-first', () => {
    const targets = listOpenAIUserTurns(sampleHistory());
    expect(targets.map((t) => t.turnIndex)).toEqual([6, 4, 0]);
    expect(targets.map((t) => t.preview)).toEqual([
      'third question',
      'second question',
      'first question',
    ]);
  });

  it('excludes role:tool messages', () => {
    const targets = listOpenAIUserTurns(sampleHistory());
    expect(targets.some((t) => t.turnIndex === 2)).toBe(false);
  });

  it('handles array content (text blocks)', () => {
    const msgs: OpenAIMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'block content' }] } as unknown as OpenAIMessage,
      { role: 'assistant', content: 'reply' } as OpenAIMessage,
    ];
    const targets = listOpenAIUserTurns(msgs);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.preview).toBe('block content');
  });

  it('truncates long previews with ellipsis', () => {
    const longText = 'a'.repeat(100);
    const msgs: OpenAIMessage[] = [
      { role: 'user', content: longText } as OpenAIMessage,
    ];
    const [target] = listOpenAIUserTurns(msgs);
    expect(target?.preview.endsWith('…')).toBe(true);
    expect(target?.preview.length).toBe(72);
  });

  it('returns empty array for empty history', () => {
    expect(listOpenAIUserTurns([])).toEqual([]);
  });

  it('excludes assistant messages from the list', () => {
    const msgs: OpenAIMessage[] = [
      { role: 'assistant', content: 'hi' } as OpenAIMessage,
    ];
    expect(listOpenAIUserTurns(msgs)).toEqual([]);
  });
});

// ---- rewindOpenAIConversation --------------------------------------------

describe('rewindOpenAIConversation', () => {
  it('truncates history at the target turn index (in place)', () => {
    const turns = sampleHistory();
    const ref = turns;
    const result = rewindOpenAIConversation(turns, idleAbort, false, 4);
    expect(result.rewound).toBe(true);
    expect(result.reloadText).toBe('second question');
    expect(result.messagesBefore).toBe(8);
    expect(result.messagesAfter).toBe(4);
    expect(turns).toBe(ref); // same array reference
    expect(turns.length).toBe(4);
  });

  it('returns session-closed when closed=true', () => {
    const turns = sampleHistory();
    const result = rewindOpenAIConversation(turns, idleAbort, true, 0);
    expect(result.rewound).toBe(false);
    expect(result.reason).toBe('session-closed');
    expect(turns.length).toBe(8); // unchanged
  });

  it('returns turn-in-flight when abort is not idle', () => {
    const turns = sampleHistory();
    const result = rewindOpenAIConversation(turns, busyAbort, false, 0);
    expect(result.rewound).toBe(false);
    expect(result.reason).toBe('turn-in-flight');
  });

  it('returns invalid-target for out-of-range index', () => {
    const turns = sampleHistory();
    const result = rewindOpenAIConversation(turns, idleAbort, false, 99);
    expect(result.rewound).toBe(false);
    expect(result.reason).toBe('invalid-target');
  });

  it('returns invalid-target for non-user-text turn (role:tool)', () => {
    const turns = sampleHistory();
    // index 2 is a role:'tool' message
    const result = rewindOpenAIConversation(turns, idleAbort, false, 2);
    expect(result.rewound).toBe(false);
    expect(result.reason).toBe('invalid-target');
  });

  it('returns invalid-target for assistant message', () => {
    const turns = sampleHistory();
    // index 1 is role:'assistant'
    const result = rewindOpenAIConversation(turns, idleAbort, false, 1);
    expect(result.rewound).toBe(false);
    expect(result.reason).toBe('invalid-target');
  });

  it('returns invalid-target for negative index', () => {
    const turns = sampleHistory();
    const result = rewindOpenAIConversation(turns, idleAbort, false, -1);
    expect(result.rewound).toBe(false);
    expect(result.reason).toBe('invalid-target');
  });

  it('rewinding to index 0 leaves an empty priorTurns', () => {
    const turns = sampleHistory();
    const result = rewindOpenAIConversation(turns, idleAbort, false, 0);
    expect(result.rewound).toBe(true);
    expect(turns.length).toBe(0);
    expect(result.messagesAfter).toBe(0);
  });
});
