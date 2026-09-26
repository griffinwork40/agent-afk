/**
 * Unit tests for `resumeHistoryToMessages` in `resolve-params.ts`.
 *
 * Documents the passthrough contract introduced by PR #1996: orphan `tool_use`
 * blocks in `assistantContentBlocks` are forwarded unchanged to the caller.
 * Mid-history pairing validation is the caller's responsibility — performed
 * by `repairOrphanToolUses` in `query-turn-driver.ts` (issue #2007).
 */

import { describe, it, expect } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { resumeHistoryToMessages } from './resolve-params.js';
import type { ResumeHistoryTurn } from '../../types/config-types.js';

// ---------------------------------------------------------------------------
// resumeHistoryToMessages
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<ResumeHistoryTurn> = {}): ResumeHistoryTurn {
  return {
    user: 'hello',
    assistant: 'world',
    ...overrides,
  };
}

describe('resumeHistoryToMessages', () => {
  it('returns undefined for undefined history', () => {
    expect(resumeHistoryToMessages(undefined)).toBeUndefined();
  });

  it('returns undefined for empty history array', () => {
    expect(resumeHistoryToMessages([])).toBeUndefined();
  });

  it('uses text fallback when no content blocks are present', () => {
    const result = resumeHistoryToMessages([makeTurn({ user: 'hi', assistant: 'there' })]);
    expect(result).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'there' },
    ]);
  });

  it('uses structured blocks over text fallback when both are present', () => {
    const userBlocks: ContentBlockParam[] = [{ type: 'text', text: 'from user' }];
    const assistantBlocks: ContentBlockParam[] = [
      { type: 'text', text: 'from assistant' },
    ];
    const result = resumeHistoryToMessages([
      makeTurn({ userContentBlocks: userBlocks, assistantContentBlocks: assistantBlocks }),
    ]);
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({ role: 'user', content: userBlocks });
    expect(result![1]).toEqual({ role: 'assistant', content: assistantBlocks });
  });

  it('handles multi-turn history correctly', () => {
    const turn1: ResumeHistoryTurn = { user: 'q1', assistant: 'a1' };
    const turn2: ResumeHistoryTurn = {
      user: 'q2',
      assistant: 'a2',
      userContentBlocks: [{ type: 'text', text: 'q2 blocks' }],
      assistantContentBlocks: [{ type: 'text', text: 'a2 blocks' }],
    };
    const result = resumeHistoryToMessages([turn1, turn2]);
    expect(result).toHaveLength(4);
    expect(result![0]).toEqual({ role: 'user', content: 'q1' });
    expect(result![1]).toEqual({ role: 'assistant', content: 'a1' });
    expect(result![2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'q2 blocks' }],
    });
    expect(result![3]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'a2 blocks' }],
    });
  });

  it('returns undefined when all turns produce no messages', () => {
    const result = resumeHistoryToMessages([{ user: '', assistant: '' }]);
    expect(result).toBeUndefined();
  });

  it('handles empty content-block arrays the same as absent (falls back to text)', () => {
    const result = resumeHistoryToMessages([
      makeTurn({
        user: 'fallback',
        assistant: 'fallback2',
        userContentBlocks: [],
        assistantContentBlocks: [],
      }),
    ]);
    expect(result).toEqual([
      { role: 'user', content: 'fallback' },
      { role: 'assistant', content: 'fallback2' },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Passthrough contract — issue #2007 / PR #1996
  //
  // PR #1996 removed `hasValidToolUsePairing` from `resumeHistoryToMessages`.
  // Orphan `tool_use` blocks in `assistantContentBlocks` now pass through
  // unchanged; the caller (`repairOrphanToolUses` in query-turn-driver.ts) is
  // responsible for detecting and patching any pairing gaps before the next API
  // request.  This test documents that intentional contract shift so any future
  // re-introduction of a pairing guard here fails loudly.
  // ---------------------------------------------------------------------------

  it('passes through assistantContentBlocks containing an orphan tool_use with no matching tool_result', () => {
    // A turn where the assistant emits a tool_use block, but no corresponding
    // tool_result is present anywhere in the history.  Under the old guard
    // (hasValidToolUsePairing) this turn would have been stripped or truncated.
    // With the guard removed, resumeHistoryToMessages must pass it through
    // as-is so repairOrphanToolUses can handle it later.
    const assistantBlocks: ContentBlockParam[] = [
      { type: 'text', text: 'About to call a tool' },
      { type: 'tool_use', id: 'toolu_orphan_resume', name: 'bash', input: { cmd: 'ls' } },
    ];
    const result = resumeHistoryToMessages([
      makeTurn({
        user: 'do the thing',
        userContentBlocks: [{ type: 'text', text: 'do the thing' }],
        assistantContentBlocks: assistantBlocks,
      }),
    ]);

    expect(result).toBeDefined();
    // Exactly two messages: user + assistant.
    expect(result).toHaveLength(2);
    const assistantMsg = result!.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    // Both blocks must be present — the orphan tool_use is NOT stripped.
    expect(assistantMsg!.content).toHaveLength(2);
    const blocks = assistantMsg!.content as ContentBlockParam[];
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'About to call a tool' });
    expect(blocks[1]).toMatchObject({ type: 'tool_use', id: 'toolu_orphan_resume', name: 'bash' });
  });

  it('passes through multi-turn history where a middle turn has orphan tool_use blocks', () => {
    // Two turns: the first has an orphan tool_use (no matching tool_result in
    // the next user turn), the second is a clean text exchange.  Both should
    // pass through unchanged.
    const turn1AssistantBlocks: ContentBlockParam[] = [
      { type: 'tool_use', id: 'toolu_mid_orphan', name: 'read_file', input: { path: '/tmp/f' } },
    ];
    const turn2AssistantBlocks: ContentBlockParam[] = [
      { type: 'text', text: 'final answer' },
    ];
    const result = resumeHistoryToMessages([
      {
        user: 'turn 1 user',
        assistant: 'turn 1 assistant',
        userContentBlocks: [{ type: 'text', text: 'turn 1 user' }],
        assistantContentBlocks: turn1AssistantBlocks,
      },
      {
        user: 'turn 2 user',
        assistant: 'turn 2 assistant',
        userContentBlocks: [{ type: 'text', text: 'turn 2 user' }],
        assistantContentBlocks: turn2AssistantBlocks,
      },
    ]);

    expect(result).toBeDefined();
    // 4 messages total (user + assistant per turn).
    expect(result).toHaveLength(4);
    // Turn 1 assistant — orphan tool_use passed through as-is.
    const t1Assistant = result![1]!;
    expect(t1Assistant.role).toBe('assistant');
    expect(t1Assistant.content).toHaveLength(1);
    const orphanBlock = (t1Assistant.content as ContentBlockParam[])[0]!;
    expect(orphanBlock.type).toBe('tool_use');
    expect((orphanBlock as { id: string }).id).toBe('toolu_mid_orphan');
    // Turn 2 user — the gap-filler message is NOT here; resumeHistoryToMessages
    // never inserts synthetic tool_result blocks.  That is repairOrphanToolUses'
    // responsibility.
    const t2User = result![2]!;
    expect(t2User.role).toBe('user');
    expect(t2User.content).toEqual([{ type: 'text', text: 'turn 2 user' }]);
  });

  // ---------------------------------------------------------------------------
  // Skip-guard — issue #2112 (defense-in-depth: no silent user-message skip)
  //
  // When both `filterContentBlocks(turn.userContentBlocks)` and `turn.user`
  // are empty, the user turn would previously be silently skipped.  If the
  // assistant side of that same TurnRecord produces content this creates
  // consecutive assistant messages that violate the Anthropic API's
  // role-alternation contract.  The `else` fallback in resumeHistoryToMessages
  // emits a minimal `{ role: 'user', content: '[resumed]' }` placeholder to
  // prevent this.
  // ---------------------------------------------------------------------------

  it('emits a [resumed] placeholder when user is empty but assistant has text', () => {
    // A turn with empty user text and no userContentBlocks, but a non-empty
    // assistant text.  The skip-guard must emit '[resumed]' so the assistant
    // message does not follow another assistant message.
    const result = resumeHistoryToMessages([{ user: '', assistant: 'hello from assistant' }]);
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({ role: 'user', content: '[resumed]' });
    expect(result![1]).toEqual({ role: 'assistant', content: 'hello from assistant' });
  });

  it('emits a [resumed] placeholder when user is empty but assistant has structured blocks', () => {
    // A turn with empty user fields, but assistantContentBlocks is non-empty.
    // The skip-guard must fire when the assistant *blocks* would produce content,
    // not only when the legacy text string is non-empty.
    const assistantBlocks: ContentBlockParam[] = [{ type: 'text', text: 'block answer' }];
    const result = resumeHistoryToMessages([
      { user: '', assistant: '', assistantContentBlocks: assistantBlocks },
    ]);
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({ role: 'user', content: '[resumed]' });
    expect(result![1]).toEqual({ role: 'assistant', content: assistantBlocks });
  });

  it('produces nothing when both user and assistant are empty (no consecutive-message violation)', () => {
    // When the assistant side is also empty, skipping the user message is safe
    // because no assistant message follows.  Both sides skip; the turn vanishes.
    const result = resumeHistoryToMessages([{ user: '', assistant: '' }]);
    expect(result).toBeUndefined();
  });

  it('does not produce consecutive assistant messages in a multi-turn history with one empty-user turn', () => {
    // Three turns: a normal turn, a turn whose user is empty but assistant is
    // non-empty, and another normal turn.  The skip-guard must fire on the middle
    // turn so the output role sequence is: user, assistant, user, assistant,
    // user, assistant — never assistant, assistant.
    const result = resumeHistoryToMessages([
      { user: 'first question', assistant: 'first answer' },
      { user: '', assistant: 'middle answer' },
      { user: 'third question', assistant: 'third answer' },
    ]);

    expect(result).toBeDefined();
    expect(result).toHaveLength(6);

    const roles = result!.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);

    // The '[resumed]' placeholder must be at index 2 (the middle user slot).
    expect(result![2]).toEqual({ role: 'user', content: '[resumed]' });

    // No consecutive same-role pairs anywhere in the sequence.
    for (let i = 0; i < roles.length - 1; i++) {
      expect(roles[i]).not.toBe(roles[i + 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// filterResumeMessages (Task 2c)
// ---------------------------------------------------------------------------

import { filterResumeMessages } from './resolve-params.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources';

describe('filterResumeMessages', () => {
  it('returns [] for non-array input', () => {
    expect(filterResumeMessages(null)).toEqual([]);
    expect(filterResumeMessages(undefined)).toEqual([]);
    expect(filterResumeMessages('string')).toEqual([]);
    expect(filterResumeMessages(42)).toEqual([]);
  });

  it('returns [] for empty array', () => {
    expect(filterResumeMessages([])).toEqual([]);
  });

  it('drops entries with invalid roles', () => {
    const raw = [
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'hello' },
      { role: 'invalid', content: 'bad' },
      { role: null, content: 'also bad' },
    ];
    const result = filterResumeMessages(raw);
    expect(result).toHaveLength(1);
    expect((result[0] as MessageParam).role).toBe('user');
    expect((result[0] as MessageParam).content).toBe('hello');
  });

  it('drops non-object entries (null, arrays, primitives)', () => {
    const raw = [
      null,
      42,
      'string',
      [],
      { role: 'user', content: 'valid' },
    ];
    const result = filterResumeMessages(raw);
    expect(result).toHaveLength(1);
    expect((result[0] as MessageParam).content).toBe('valid');
  });

  it('drops messages whose content is empty string after filtering', () => {
    const raw = [
      { role: 'user', content: '' },
      { role: 'assistant', content: 'answer' },
    ];
    const result = filterResumeMessages(raw);
    expect(result).toHaveLength(1);
    expect((result[0] as MessageParam).role).toBe('assistant');
  });

  it('passes through string content unchanged', () => {
    const raw = [
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'hi back' },
    ];
    const result = filterResumeMessages(raw);
    expect(result).toHaveLength(2);
    expect((result[0] as MessageParam).content).toBe('hello there');
    expect((result[1] as MessageParam).content).toBe('hi back');
  });

  it('strips thinking and redacted_thinking blocks from array content', () => {
    const raw = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private thoughts' },
          { type: 'text', text: 'visible reply' },
          { type: 'redacted_thinking', data: 'encrypted' },
        ],
      },
    ];
    const result = filterResumeMessages(raw);
    expect(result).toHaveLength(1);
    const content = (result[0] as MessageParam).content as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('drops unknown block types from array content', () => {
    const raw = [
      {
        role: 'user',
        content: [
          { type: 'unknown_future_block', data: 'something' },
          { type: 'text', text: 'my question' },
        ],
      },
    ];
    const result = filterResumeMessages(raw);
    expect(result).toHaveLength(1);
    const content = (result[0] as MessageParam).content as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
  });

  it('drops messages left empty after filtering (all blocks stripped)', () => {
    const raw = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'only thinking, no text' },
          { type: 'redacted_thinking', data: 'enc' },
        ],
      },
      { role: 'user', content: 'still here' },
    ];
    const result = filterResumeMessages(raw);
    expect(result).toHaveLength(1);
    expect((result[0] as MessageParam).role).toBe('user');
  });

  it('preserves a realistic multi-round tool loop verbatim and in order', () => {
    // user text → assistant [text, tool_use] → user [tool_result, text] →
    // assistant [tool_use] → user [tool_result] → assistant text
    const raw: unknown[] = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will run bash.' },
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'file.ts\nother.ts' },
          { type: 'text', text: 'thanks' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'read_file', input: { file_path: 'file.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'export const x = 1;' },
        ],
      },
      { role: 'assistant', content: 'Done reading.' },
    ];

    const result = filterResumeMessages(raw);
    expect(result).toHaveLength(6);

    // Roles in correct order.
    expect(result.map((m) => (m as MessageParam).role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
    ]);

    // Turn 0: plain user text preserved.
    expect((result[0] as MessageParam).content).toBe('run it');

    // Turn 1: text + tool_use both preserved, in order.
    const t1 = (result[1] as MessageParam).content as Array<{ type: string; text?: string; id?: string }>;
    expect(t1).toHaveLength(2);
    expect(t1[0]!.type).toBe('text');
    expect(t1[0]!.text).toBe('I will run bash.');
    expect(t1[1]!.type).toBe('tool_use');
    expect(t1[1]!.id).toBe('tu_1');

    // Turn 2: tool_result + text in FULL (content string preserved verbatim).
    const t2 = (result[2] as MessageParam).content as Array<{ type: string; content?: string; tool_use_id?: string }>;
    expect(t2).toHaveLength(2);
    expect(t2[0]!.type).toBe('tool_result');
    expect(t2[0]!.tool_use_id).toBe('tu_1');
    expect(t2[0]!.content).toBe('file.ts\nother.ts');

    // Turn 3: single tool_use preserved.
    const t3 = (result[3] as MessageParam).content as Array<{ type: string; id?: string }>;
    expect(t3).toHaveLength(1);
    expect(t3[0]!.type).toBe('tool_use');
    expect(t3[0]!.id).toBe('tu_2');

    // Turn 4: tool_result preserved.
    const t4 = (result[4] as MessageParam).content as Array<{ type: string; tool_use_id?: string }>;
    expect(t4).toHaveLength(1);
    expect(t4[0]!.type).toBe('tool_result');
    expect(t4[0]!.tool_use_id).toBe('tu_2');

    // Turn 5: plain assistant text preserved.
    expect((result[5] as MessageParam).content).toBe('Done reading.');
  });
});
