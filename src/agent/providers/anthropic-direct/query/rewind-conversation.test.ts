/**
 * Unit tests for the conversation-rewind helpers — the provider half of the
 * REPL "press Esc-Esc to edit a previous message" feature.
 *
 * Covers turn enumeration (newest-first, tool_result turns excluded), the
 * guard paths (closed / turn-in-flight / invalid target), in-place truncation
 * with array-identity preservation, reloadText extraction, and the
 * tool_use/tool_result boundary repair after a splice.
 */

import { describe, it, expect } from 'vitest';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import { listUserTurns, rewindConversationHistory } from './rewind-conversation.js';
import { createSessionState, type SessionState } from './session-state.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';
import type { AbortCoordinator } from '../../shared/abort-coordinator.js';

function makeState(messages: MessageParam[], closed = false): SessionState {
  const state = createSessionState({
    model: 'claude-test',
    permissionMode: 'default',
    userSystem: null,
    toolDispatcher: {} as unknown as ToolDispatcher,
    initialMessages: messages,
  });
  state.closed = closed;
  return state;
}

const idleAbort = { isIdle: () => true } as unknown as AbortCoordinator;
const busyAbort = { isIdle: () => false } as unknown as AbortCoordinator;

const toolUse = (id: string): ContentBlockParam[] => [
  { type: 'tool_use', id, name: 'x', input: {} },
];
const toolResult = (id: string): ContentBlockParam[] => [
  { type: 'tool_result', tool_use_id: id, content: 'ok' },
];

/** A realistic 3-turn conversation with one tool round in the middle. */
function sampleHistory(): MessageParam[] {
  return [
    { role: 'user', content: 'first question' },          // 0  genuine
    { role: 'assistant', content: toolUse('t1') },         // 1
    { role: 'user', content: toolResult('t1') },           // 2  tool_result (NOT genuine)
    { role: 'assistant', content: 'first answer' },        // 3
    { role: 'user', content: 'second question' },          // 4  genuine
    { role: 'assistant', content: 'second answer' },       // 5
    { role: 'user', content: 'third question' },           // 6  genuine
    { role: 'assistant', content: 'third answer' },        // 7
  ];
}

describe('listUserTurns', () => {
  it('enumerates only genuine user-text turns, newest-first', () => {
    const targets = listUserTurns(sampleHistory());
    expect(targets.map((t) => t.turnIndex)).toEqual([6, 4, 0]);
    expect(targets.map((t) => t.preview)).toEqual([
      'third question',
      'second question',
      'first question',
    ]);
  });

  it('excludes pure tool_result user messages', () => {
    const targets = listUserTurns(sampleHistory());
    // index 2 is a tool_result user message — must not appear.
    expect(targets.some((t) => t.turnIndex === 2)).toBe(false);
  });

  it('handles string and text-block user content', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'plain string' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: [{ type: 'text', text: 'block text' }] as ContentBlockParam[] },
      { role: 'assistant', content: 'b' },
    ];
    expect(listUserTurns(messages).map((t) => t.preview)).toEqual([
      'block text',
      'plain string',
    ]);
  });

  it('collapses whitespace and truncates long previews', () => {
    const long = 'word '.repeat(40); // 200 chars
    const targets = listUserTurns([{ role: 'user', content: long }]);
    expect(targets[0]!.preview.length).toBeLessThanOrEqual(72);
    expect(targets[0]!.preview.endsWith('…')).toBe(true);
    expect(targets[0]!.preview).not.toContain('  '); // whitespace collapsed
  });

  it('returns empty for a history with no genuine user turns', () => {
    expect(listUserTurns([])).toEqual([]);
    expect(listUserTurns([{ role: 'assistant', content: 'hi' }])).toEqual([]);
    expect(listUserTurns([{ role: 'user', content: toolResult('t1') }])).toEqual([]);
  });

  // Regression: the per-round [vitals] note rides as a sibling text block in
  // the tool_result user message (loop/tool-results.ts). It made every tool
  // round look like a typed prompt, flooding the Esc-Esc picker with
  // "[vitals] …" rows.
  const vitals = '[vitals] Thu 2026-10-15 18:31 EDT · turn 4s · context 61%';

  it('excludes a tool-round carrier whose only text is the vitals note', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: toolUse('t1') },
      { role: 'user', content: [...toolResult('t1'), { type: 'text', text: vitals }] },
      { role: 'assistant', content: 'answer' },
    ];
    expect(listUserTurns(messages).map((t) => t.turnIndex)).toEqual([0]);
  });

  it('never targets a tool-round carrier, even when it holds queued text', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: toolUse('t1') },
      {
        role: 'user',
        content: [
          ...toolResult('t1'),
          { type: 'text', text: 'queued follow-up' },
          { type: 'text', text: vitals },
        ],
      },
      { role: 'assistant', content: 'answer' },
    ];
    expect(listUserTurns(messages).map((t) => t.turnIndex)).toEqual([0]);

    // Rewinding there would discard the real tool_result, orphan t1, and make
    // repair fabricate an is_error result. The guard refuses and leaves
    // history byte-identical.
    const state = makeState(messages);
    const snapshot = JSON.stringify(state.messages);
    const result = rewindConversationHistory({ state, abort: idleAbort }, 2);
    expect(result).toMatchObject({ rewound: false, reason: 'invalid-target' });
    expect(JSON.stringify(state.messages)).toBe(snapshot);
  });

  it('keeps a mid-turn steering message (its own text-only user turn) rewindable', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: toolUse('t1') },
      { role: 'user', content: [...toolResult('t1'), { type: 'text', text: vitals }] },
      { role: 'user', content: [{ type: 'text', text: 'steer: use pnpm' }] },
      { role: 'assistant', content: 'answer' },
    ];
    expect(listUserTurns(messages).map((t) => t.preview)).toEqual(['steer: use pnpm', 'real question']);

    const state = makeState(messages);
    const result = rewindConversationHistory({ state, abort: idleAbort }, 3);
    expect(result).toMatchObject({ rewound: true, reloadText: 'steer: use pnpm' });
    // The tool_use/tool_result pair before the cut is intact, nothing fabricated.
    expect(state.messages).toHaveLength(3);
    expect(JSON.stringify(state.messages)).not.toContain('is_error');
  });

  it('leaves a typed prompt that starts with [vitals] untouched', () => {
    const typed = [{ type: 'text', text: vitals }] as ContentBlockParam[];
    expect(listUserTurns([{ role: 'user', content: typed }]).map((t) => t.turnIndex)).toEqual([0]);
  });
});

describe('rewindConversationHistory', () => {
  it('truncates to just before the chosen turn and returns its text', () => {
    const state = makeState(sampleHistory());
    const before = state.messages;

    const result = rewindConversationHistory({ state, abort: idleAbort }, 4);

    expect(result.rewound).toBe(true);
    expect(result.reloadText).toBe('second question');
    expect(result.messagesBefore).toBe(8);
    expect(result.messagesAfter).toBe(4);
    // Kept [0,4): the previous turn is fully resolved (ends on an assistant).
    expect(state.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    // Mutated IN PLACE — array identity preserved (loop holds this reference).
    expect(state.messages).toBe(before);
  });

  it('rewinding to the most-recent turn drops just that turn', () => {
    const state = makeState(sampleHistory());
    const result = rewindConversationHistory({ state, abort: idleAbort }, 6);
    expect(result.rewound).toBe(true);
    expect(result.reloadText).toBe('third question');
    expect(state.messages).toHaveLength(6);
  });

  it('rewinding to the first turn yields an empty history', () => {
    const state = makeState(sampleHistory());
    const result = rewindConversationHistory({ state, abort: idleAbort }, 0);
    expect(result.rewound).toBe(true);
    expect(result.reloadText).toBe('first question');
    expect(state.messages).toHaveLength(0);
  });

  it('repairs an orphaned tool_use left at the new tail (API contract)', () => {
    // Contrived tail: truncating at the genuine user turn strands an assistant
    // tool_use with no following tool_result. repairOrphanToolUses must append
    // a synthetic error tool_result so the next Messages API call is valid.
    const messages: MessageParam[] = [
      { role: 'assistant', content: toolUse('t9') },
      { role: 'user', content: 'redo from here' },
    ];
    const state = makeState(messages);

    const result = rewindConversationHistory({ state, abort: idleAbort }, 1);

    expect(result.rewound).toBe(true);
    const last = state.messages[state.messages.length - 1]!;
    expect(last.role).toBe('user');
    const blocks = last.content as ContentBlockParam[];
    expect(blocks[0]?.type).toBe('tool_result');
    expect((blocks[0] as { tool_use_id?: string }).tool_use_id).toBe('t9');
  });

  it('no-ops when the session is closed', () => {
    const state = makeState(sampleHistory(), /* closed */ true);
    const result = rewindConversationHistory({ state, abort: idleAbort }, 4);
    expect(result.rewound).toBe(false);
    expect(result.reason).toBe('session-closed');
    expect(state.messages).toHaveLength(8); // untouched
  });

  it('no-ops when a turn is in flight (idle interlock)', () => {
    const state = makeState(sampleHistory());
    const result = rewindConversationHistory({ state, abort: busyAbort }, 4);
    expect(result.rewound).toBe(false);
    expect(result.reason).toBe('turn-in-flight');
    expect(state.messages).toHaveLength(8);
  });

  it('rejects an out-of-range index', () => {
    const state = makeState(sampleHistory());
    for (const bad of [-1, 8, 99, 1.5]) {
      const result = rewindConversationHistory({ state, abort: idleAbort }, bad);
      expect(result.rewound).toBe(false);
      expect(result.reason).toBe('invalid-target');
    }
    expect(state.messages).toHaveLength(8);
  });

  it('rejects a non-user-turn target (assistant / tool_result)', () => {
    const state = makeState(sampleHistory());
    // 3 = assistant, 2 = tool_result user message.
    expect(rewindConversationHistory({ state, abort: idleAbort }, 3).reason).toBe('invalid-target');
    expect(rewindConversationHistory({ state, abort: idleAbort }, 2).reason).toBe('invalid-target');
    expect(state.messages).toHaveLength(8);
  });

  // Regression: on resume, fromJournalMessages merges consecutive same-role
  // user messages, so the steering text (pushed as a separate text-only user
  // message by inter-round.ts in live sessions) gets merged into the preceding
  // tool_result carrier. The fix preserves the boundary, keeping the steering
  // message visible in the rewind picker.
  it('lists a text-only user message after a tool-result carrier as a rewind target (resume case)', () => {
    // This simulates what fromJournalMessages produces when a live session with
    // mid-turn steering is resumed: the steering message survives as a separate
    // message (the journal-adapter fix preserves the boundary).
    const messages: MessageParam[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: toolUse('t1') },
      { role: 'user', content: toolResult('t1') },  // index 2: carrier (excluded)
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'actually, cancel that' },  // index 4: steering (included)
    ];
    const targets = listUserTurns(messages);
    expect(targets.map((t) => t.turnIndex)).toEqual([4, 0]);
    expect(targets.map((t) => t.preview)).toEqual(['actually, cancel that', 'first question']);
  });
});

describe('rewind strips drained framework preamble', () => {
  const pre = '[placeholder-prevent] Prefer running commands yourself with your tools.\n\nwhat the user typed';
  it('preview and reloadText carry only the user text', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: pre },
      { role: 'assistant', content: 'ok' },
    ];
    expect(listUserTurns(messages).map((t) => t.preview)).toEqual(['what the user typed']);
    const state = makeState(messages);
    expect(rewindConversationHistory({ state, abort: idleAbort }, 0).reloadText).toBe('what the user typed');
  });
});
