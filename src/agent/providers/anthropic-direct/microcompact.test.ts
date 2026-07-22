/**
 * Anthropic-specific tool-result microcompaction tests.
 *
 * Verifies the `anthropicMicrocompactOps` handle the real Anthropic message
 * shape correctly (tool_result blocks nested in role:'user' messages, string
 * AND array content) and — the KEY case this feature exists for — that a
 * single-fresh-user-turn message array full of large tool_results is reclaimed
 * by microcompaction even though `findCompactionBoundary` returns -1 for it
 * (turn-granular summarization cannot reach inside the one kept turn).
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import {
  findCompactionBoundary,
  isFreshUserTurn,
  microcompactToolResults,
} from './compact.js';
import { isMicrocompactPlaceholder } from '../shared/compaction.js';

/** Build a user message carrying a single tool_result of `bytes` chars. */
function toolResultTurn(id: string, bytes: number, fill = 'x'): MessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: fill.repeat(bytes) }],
  };
}
/** Build an assistant message with a single tool_use block. */
function toolUseTurn(id: string, name = 'read_file'): MessageParam {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] };
}

/** Extract every tool_result block's content string (for assertions). */
function toolResultContents(messages: MessageParam[]): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as ContentBlockParam[]) {
      if ((block as { type?: string }).type === 'tool_result') {
        const c = (block as { content?: unknown }).content;
        out.push(typeof c === 'string' ? c : JSON.stringify(c));
      }
    }
  }
  return out;
}

/** Collect all tool_use ids and tool_result ids to assert pairing is intact. */
function pairingIds(messages: MessageParam[]): { uses: string[]; results: string[] } {
  const uses: string[] = [];
  const results: string[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as ContentBlockParam[]) {
      const t = (block as { type?: string }).type;
      if (t === 'tool_use') uses.push((block as { id: string }).id);
      if (t === 'tool_result') results.push((block as { tool_use_id: string }).tool_use_id);
    }
  }
  return { uses, results };
}

describe('anthropic microcompactToolResults', () => {
  it('clears a large tool_result content in place, preserving the block + tool_use_id', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'do a thing' },
      toolUseTurn('t1'),
      toolResultTurn('t1', 5000),
      toolUseTurn('t2'),
      toolResultTurn('t2', 6000),
    ];
    const before = pairingIds(msgs);
    const r = microcompactToolResults(msgs, { thresholdBytes: 1000, keepLast: 0 });

    expect(r.blocksCleared).toBe(2);
    expect(r.bytesReclaimed).toBeGreaterThan(9000);

    // PAIRING: same number of tool_use and tool_result blocks, same ids/positions.
    const after = pairingIds(msgs);
    expect(after.uses).toEqual(before.uses);
    expect(after.results).toEqual(before.results); // tool_use_id preserved on every result
    expect(after.uses).toEqual(after.results); // each tool_use still has a paired result

    // Both results are now placeholders that name their reclaimed byte count.
    const contents = toolResultContents(msgs);
    expect(contents.every((c) => isMicrocompactPlaceholder(c))).toBe(true);
    expect(contents[0]).toContain('5000');
    expect(contents[1]).toContain('6000');

    // No message removed.
    expect(msgs).toHaveLength(5);
  });

  it('handles ARRAY tool_result content (text blocks) — measures and clears it', () => {
    const arrayResult: MessageParam = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: 'z'.repeat(4000) }],
        },
      ],
    };
    const msgs: MessageParam[] = [toolUseTurn('t1'), arrayResult];
    const r = microcompactToolResults(msgs, { thresholdBytes: 1000, keepLast: 0 });
    expect(r.blocksCleared).toBe(1);
    const contents = toolResultContents(msgs);
    expect(isMicrocompactPlaceholder(contents[0]!)).toBe(true);
    expect(contents[0]).toContain('4000');
  });

  it('IDEMPOTENT: a second Anthropic pass clears nothing', () => {
    const msgs: MessageParam[] = [
      toolUseTurn('t1'),
      toolResultTurn('t1', 5000),
      toolUseTurn('t2'),
      toolResultTurn('t2', 6000),
    ];
    const first = microcompactToolResults(msgs, { thresholdBytes: 1000, keepLast: 0 });
    expect(first.blocksCleared).toBe(2);
    const snapshot = toolResultContents(msgs);
    const second = microcompactToolResults(msgs, { thresholdBytes: 1000, keepLast: 0 });
    expect(second.blocksCleared).toBe(0);
    expect(second.bytesReclaimed).toBe(0);
    expect(toolResultContents(msgs)).toEqual(snapshot);
  });

  it('keeps the most-recent K tool_results intact', () => {
    const msgs: MessageParam[] = [
      toolUseTurn('t1'),
      toolResultTurn('t1', 5000, 'a'),
      toolUseTurn('t2'),
      toolResultTurn('t2', 5000, 'b'),
      toolUseTurn('t3'),
      toolResultTurn('t3', 5000, 'c'),
    ];
    const r = microcompactToolResults(msgs, { thresholdBytes: 1000, keepLast: 2 });
    expect(r.blocksCleared).toBe(1); // only the oldest (t1)
    const contents = toolResultContents(msgs);
    expect(isMicrocompactPlaceholder(contents[0]!)).toBe(true);
    expect(contents[1]).toBe('b'.repeat(5000)); // kept
    expect(contents[2]).toBe('c'.repeat(5000)); // kept
  });

  it('ignores non-user messages and does not touch tool_use blocks', () => {
    const msgs: MessageParam[] = [
      { role: 'assistant', content: 'x'.repeat(9000) }, // assistant text — not a tool_result
      toolUseTurn('t1'),
      toolResultTurn('t1', 5000),
    ];
    microcompactToolResults(msgs, { thresholdBytes: 1000, keepLast: 0 });
    // assistant text untouched.
    expect(msgs[0]!.content).toBe('x'.repeat(9000));
    // tool_use block still present and unchanged.
    const useBlock = (msgs[1]!.content as ContentBlockParam[])[0] as { type: string; id: string };
    expect(useBlock.type).toBe('tool_use');
    expect(useBlock.id).toBe('t1');
  });

  describe('THE KEY CASE — single-turn-but-full session', () => {
    // A single fresh user turn (index 0), then one long tool-use/result exchange
    // in the SAME turn window. findCompactionBoundary keeps the last N=2 fresh
    // user turns; there is only ONE fresh user turn, so it returns -1 —
    // turn-granular summarization is powerless. Microcompaction still reclaims
    // the tool_result bytes that filled the window.
    function singleTurnFull(): MessageParam[] {
      return [
        { role: 'user', content: 'read these three files and summarize' },
        toolUseTurn('t1'),
        toolResultTurn('t1', 20000, 'a'),
        toolUseTurn('t2'),
        toolResultTurn('t2', 20000, 'b'),
        toolUseTurn('t3'),
        toolResultTurn('t3', 20000, 'c'),
      ];
    }

    it('findCompactionBoundary returns -1 (nothing summarizable) for this shape', () => {
      const msgs = singleTurnFull();
      // Only one fresh user turn → fewer than keepLastN=2 → -1.
      expect(msgs.filter((m) => isFreshUserTurn(m))).toHaveLength(1);
      expect(findCompactionBoundary(msgs, 2)).toBe(-1);
    });

    it('microcompaction reclaims bytes where summarization cannot', () => {
      const msgs = singleTurnFull();
      const totalBefore = toolResultContents(msgs).reduce((n, c) => n + c.length, 0);
      expect(totalBefore).toBeGreaterThan(50000);

      // keepLast=1 protects the freshest result; the two older 20KB results clear.
      const r = microcompactToolResults(msgs, { thresholdBytes: 1000, keepLast: 1 });
      expect(r.blocksCleared).toBe(2);
      expect(r.bytesReclaimed).toBeGreaterThan(35000);

      const totalAfter = toolResultContents(msgs).reduce((n, c) => n + c.length, 0);
      expect(totalAfter).toBeLessThan(totalBefore); // bytes dropped — the whole point

      // Structure fully intact: 7 messages, every tool_use still paired.
      expect(msgs).toHaveLength(7);
      const ids = pairingIds(msgs);
      expect(ids.uses).toEqual(ids.results);
    });
  });
});
