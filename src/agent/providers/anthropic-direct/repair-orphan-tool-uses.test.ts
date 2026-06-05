/**
 * Unit tests for `repairOrphanToolUses` — the self-healing guard that runs
 * before every new user-turn append in `query.ts`.
 *
 * The Anthropic Messages API rejects any request whose history contains an
 * assistant `tool_use` block not immediately followed by a user `tool_result`
 * block covering its id:
 *
 *   400 messages.N: `tool_use` ids were found without `tool_result` blocks
 *   immediately after: toolu_XXX
 *
 * Causes encountered in the wild:
 *   1. User typed mid-stream → interrupt raced past loop.ts's rollback gate.
 *   2. A persisted session JSON written by an older AFK build (before the
 *      rollback existed) is loaded via `initialMessages` and the orphan rides
 *      through to the first request.
 *
 * This helper is the second layer of defense — loop.ts's rollback is the
 * primary defense for live turns; this guard recovers anything that made it
 * past the rollback or arrived from disk.
 */

import { describe, it, expect } from 'vitest';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import { repairOrphanToolUses } from './query/repair-orphan-tool-uses.js';

describe('repairOrphanToolUses', () => {
  it('is a no-op on empty history', () => {
    const messages: MessageParam[] = [];
    repairOrphanToolUses(messages);
    expect(messages).toEqual([]);
  });

  it('is a no-op when the last message is a user message', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    repairOrphanToolUses(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('is a no-op when the last assistant message has only text blocks', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello back' }] as ContentBlockParam[],
      },
    ];
    repairOrphanToolUses(messages);
    expect(messages).toHaveLength(2);
  });

  it('is a no-op when the assistant content is a plain string', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'plain string response' },
    ];
    repairOrphanToolUses(messages);
    expect(messages).toHaveLength(2);
  });

  it('inserts a synthetic tool_result repair when the last assistant message has an unmatched tool_use', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'do a thing' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure, calling tool' },
          {
            type: 'tool_use',
            id: 'toolu_orphan',
            name: 'read_file',
            input: { file: 'a.ts' },
          },
        ] as ContentBlockParam[],
      },
    ];

    repairOrphanToolUses(messages);

    expect(messages).toHaveLength(3);
    const repair = messages[2]!;
    expect(repair.role).toBe('user');
    expect(typeof repair.content).not.toBe('string');
    const repairBlocks = repair.content as ContentBlockParam[];
    expect(repairBlocks).toHaveLength(1);
    const tr = repairBlocks[0] as {
      type: string;
      tool_use_id: string;
      is_error: boolean;
      content: string;
    };
    expect(tr.type).toBe('tool_result');
    expect(tr.tool_use_id).toBe('toolu_orphan');
    expect(tr.is_error).toBe(true);
    expect(typeof tr.content).toBe('string');
    expect(tr.content.length).toBeGreaterThan(0);
  });

  it('covers every orphan tool_use in a single repair message when multiple are present', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'do many things' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_a',
            name: 'read_file',
            input: { file: 'a.ts' },
          },
          {
            type: 'tool_use',
            id: 'toolu_b',
            name: 'read_file',
            input: { file: 'b.ts' },
          },
        ] as ContentBlockParam[],
      },
    ];

    repairOrphanToolUses(messages);

    expect(messages).toHaveLength(3);
    const repair = messages[2]!;
    const blocks = repair.content as ContentBlockParam[];
    const ids = blocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b as { tool_use_id: string }).tool_use_id);
    expect(ids).toEqual(['toolu_a', 'toolu_b']);
  });

  it('does NOT double-repair: a second invocation after repair is a no-op', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_x',
            name: 'read_file',
            input: {},
          },
        ] as ContentBlockParam[],
      },
    ];
    repairOrphanToolUses(messages);
    expect(messages).toHaveLength(3);
    repairOrphanToolUses(messages);
    // The second call should observe that the tail is now a user message
    // (the repair we just inserted) and do nothing.
    expect(messages).toHaveLength(3);
  });
});
