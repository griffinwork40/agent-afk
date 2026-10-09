/**
 * Delivery tests for the per-round `[vitals]` note: WHERE each provider puts
 * it. The builder's content is covered by vitals.test.ts; these pin the
 * placement contract documented in vitals.ts (module Invariant):
 *   - anthropic-direct: a trailing sibling text block in the tool_result user
 *     turn, after any queued harness note, never inside tool_result content and
 *     never as a separate user turn.
 *   - openai-compatible: appended to the round's LAST `role:'tool'` message,
 *     never a separate `role:'user'` message (compaction boundary / rewind).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from '../anthropic-direct/loop.js';
import {
  collect,
  ctx,
  fromArray,
  makeClient,
  makeDispatcher,
  makeTextStream,
  makeToolUseStream,
} from '../anthropic-direct/loop.test-helpers.js';
import type { ToolCall, ToolDispatcher, ToolResult } from '../anthropic-direct/types.js';
import { dispatchAndAppendToolCalls } from '../openai-compatible/query/dispatch-append.js';
import { createStreamState } from '../openai-compatible/translate.js';
import type { OpenAIMessage } from '../openai-compatible/messages.js';
import { VITALS_PREFIX } from './vitals.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function anthropicRound(result: ToolResult): Promise<MessageParam[]> {
  let callIdx = 0;
  const client = makeClient(() => {
    callIdx += 1;
    return callIdx === 1
      ? fromArray(makeToolUseStream('toolu_1', 'agent', '{}'))
      : fromArray(makeTextStream('done'));
  });
  const messages: MessageParam[] = [{ role: 'user', content: 'start' }];
  await collect(
    runTurn({
      client,
      messages,
      system: null,
      tools: [{ name: 'agent', input_schema: { type: 'object' } }],
      toolDispatcher: makeDispatcher(async () => result),
      model: 'claude-test',
      maxTokens: 1024,
      headers: {},
      signal: new AbortController().signal,
      ctx,
    }),
  );
  return messages;
}

describe('anthropic-direct vitals delivery', () => {
  it('appends the note as the trailing text block of the tool_result turn', async () => {
    const messages = await anthropicRound({
      content: 'tool says hi',
      harnessUserMessage: { kind: 'queued_user_message', text: 'queued directive' },
    });
    // user, assistant{tool_use}, user{tool_result + notes}, assistant{text}:
    // no extra user turn was introduced.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const blocks = messages[2]!.content as ContentBlockParam[];
    expect(blocks[0]).toMatchObject({ type: 'tool_result', content: 'tool says hi' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'queued directive' });
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toMatchObject({ type: 'text' });
    expect((blocks[2] as { text: string }).text.startsWith(`${VITALS_PREFIX} `)).toBe(true);
  });

  it('adds nothing when AFK_VITALS=0', async () => {
    vi.stubEnv('AFK_VITALS', '0');
    const messages = await anthropicRound({ content: 'tool says hi' });
    const blocks = messages[2]!.content as ContentBlockParam[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'tool_result' });
  });
});

async function openAIRound(vitalsNote: string | undefined): Promise<OpenAIMessage[]> {
  const state = createStreamState();
  state.toolCallsByIndex.set(0, { index: 0, id: 'call_a', name: 'tool_a', argumentsRaw: '{}', startEmitted: true });
  state.toolCallsByIndex.set(1, { index: 1, id: 'call_b', name: 'tool_b', argumentsRaw: '{}', startEmitted: true });
  const dispatcher: ToolDispatcher = {
    execute: async (call: ToolCall): Promise<ToolResult> => ({ content: `out ${call.name}` }),
  };
  const priorTurns: OpenAIMessage[] = [{ role: 'user', content: 'go' } as OpenAIMessage];
  const gen = dispatchAndAppendToolCalls({
    state,
    signal: new AbortController().signal,
    vision: false,
    toolDispatcher: dispatcher,
    traceWriter: undefined,
    priorTurns,
    sessionId: 'sess_vitals',
    vitalsNote,
  });
  for (;;) if ((await gen.next()).done) break;
  return priorTurns;
}

describe('openai-compatible vitals delivery', () => {
  it('appends the note to the last tool message, not as a user message', async () => {
    const note = `${VITALS_PREFIX} Fri 2026-10-09 14:32 EDT · turn 5s`;
    const turns = await openAIRound(note);
    expect(turns.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect((turns[2] as { content: string }).content).toBe('out tool_a');
    expect((turns[3] as { content: string }).content).toBe(`out tool_b\n\n${note}`);
  });

  it('leaves tool content untouched without a note', async () => {
    const turns = await openAIRound(undefined);
    expect((turns[3] as { content: string }).content).toBe('out tool_b');
  });
});
