// Orphan tool_use prevention regression tests for loop.ts runTurn.
// Split out of loop.test.ts (#370) — bodies moved verbatim.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawMessageStreamEvent, MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import type { AnthropicClientLike, ToolDispatcherLike } from './types.js';
import {
  fromArray,
  collect,
  ctx,
  baseUsage,
  makeTextStream,
  makeToolUseStream,
  makeClient,
  makeDispatcher,
  makeBatchDispatcher,
} from './loop.test-helpers.js';

// ─── Regression: orphan tool_use prevention ────────────────────────────────────
//
// Anthropic Messages API rejects any user-turn submit whose prior assistant
// message contains a `tool_use` block not immediately followed by a user
// message of matching `tool_result` blocks:
//
//   400 messages.N: `tool_use` ids were found without `tool_result` blocks
//   immediately after: toolu_XXX
//
// runTurn must never leave history in that shape. These tests pin the two
// codepaths that historically did:
//
//   1. stopReason != 'tool_use' but assistantBlocks contains a tool_use block
//      (e.g. `max_tokens` truncated the message after the tool_use opened).
//      Pre-fix: the tool_use block was pushed verbatim — instant orphan.
//      Post-fix: tool_use blocks are filtered from the pushed assistant turn.
//
//   2. stopReason == 'tool_use' but the dispatcher throws synchronously
//      OUTSIDE the dispatcher's own try/catch (e.g. accessor on
//      `input.toolDispatcher` throws). Pre-fix: assistant tool_use push
//      remained in history. Post-fix: rollback splices it back out.

describe('loop.ts runTurn — orphan tool_use prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips tool_use blocks when stopReason is not tool_use (max_tokens truncation)', async () => {
    // Stream: a tool_use block opens AND closes, but message_delta carries
    // stop_reason='max_tokens' (model ran out of budget before the model would
    // have actually requested a dispatch). assistantBlocks contains the
    // tool_use block; runTurn must NOT leak it into history.
    const truncatedToolUseStream: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_truncate',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: baseUsage(),
        },
      } as unknown as RawMessageStreamEvent,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_orphan', name: 'read_file', input: {} },
      } as unknown as RawMessageStreamEvent,
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file":"a.ts"}' },
      } as unknown as RawMessageStreamEvent,
      {
        type: 'content_block_stop',
        index: 0,
      } as unknown as RawMessageStreamEvent,
      {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
        usage: { output_tokens: 4 },
      } as unknown as RawMessageStreamEvent,
      { type: 'message_stop' } as unknown as RawMessageStreamEvent,
    ];

    const client = makeClient(() => fromArray(truncatedToolUseStream));
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'never called' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'do a thing' }];
    const abortController = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // History invariant: no message ends in an unmatched tool_use block.
    // Equivalent: no assistant message anywhere carries tool_use without a
    // following user message of tool_result blocks. With this stream we
    // expect the assistant turn to be either skipped entirely (no usable
    // content) or to contain only non-tool_use blocks. The tool_use must
    // NOT appear in history.
    const flatTooluses: string[] = [];
    for (const m of messages) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content as ContentBlockParam[]) {
        if (b.type === 'tool_use') flatTooluses.push((b as { id: string }).id);
      }
    }
    expect(flatTooluses).not.toContain('toolu_orphan');
  });

  it('rolls back the assistant tool_use push when the dispatcher accessor throws', async () => {
    // Build a dispatcher whose `executeBatch` is a getter that throws on
    // access. This simulates a throw between "tool_use is committed to
    // history" and "tool_result is committed to history" that NOT absorbed
    // by the existing executeBatch try/catch (which only catches when the
    // function call itself throws, after access succeeds).
    const dispatcher: ToolDispatcherLike = {
      execute: vi.fn(() => Promise.reject(new Error('should use batch'))),
    };
    Object.defineProperty(dispatcher, 'executeBatch', {
      get() {
        throw new Error('synthetic mid-turn failure');
      },
    });

    const stream = makeToolUseStream('toolu_will_orphan', 'read_file', '{"file":"a.ts"}');
    const client = makeClient(() => fromArray(stream));
    const messages: MessageParam[] = [{ role: 'user', content: 'do it' }];
    const initialLength = messages.length;
    const abortController = new AbortController();

    let caught: Error | null = null;
    try {
      await collect(
        runTurn({
          client,
          messages,
          system: null,
          tools: null,
          toolDispatcher: dispatcher,
          model: 'claude-test',
          maxTokens: 1024,
          headers: {},
          signal: abortController.signal,
          ctx,
        }),
      );
    } catch (err) {
      caught = err as Error;
    }

    // The throw is intentional — runTurn re-throws after rolling back. The
    // invariant under test is: history does NOT carry the orphan tool_use.
    expect(caught).toBeInstanceOf(Error);
    expect(messages.length).toBe(initialLength);
    for (const m of messages) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content as ContentBlockParam[]) {
        expect(b.type).not.toBe('tool_use');
      }
    }
  });

  it('leaves history matched (tool_use + tool_result) on the normal dispatch path', async () => {
    // Sanity guard: the rollback wrapper must not corrupt the happy path.
    // After one tool_use round + dispatch, history should contain exactly
    // the assistant tool_use turn followed by the user tool_result turn.
    const stream = makeToolUseStream('toolu_ok', 'read_file', '{"file":"a.ts"}');
    const client = makeClient(() =>
      // After the dispatch turn, the model would emit a follow-up — but we
      // only need one round, so the second call gets an end_turn text stream.
      fromArray(stream),
    );
    // Replace the create mock with a sequence: first call returns the tool_use
    // stream, second call returns an end_turn text stream.
    let callIdx = 0;
    client.messages.create = vi.fn(() => {
      callIdx++;
      return callIdx === 1
        ? fromArray(stream)
        : fromArray(makeTextStream('done', 'end_turn'));
    });

    const dispatcher = makeBatchDispatcher(async (calls) =>
      calls.map(() => ({ content: 'file contents', isError: false as const })),
    );
    const messages: MessageParam[] = [{ role: 'user', content: 'read it' }];
    const abortController = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Find the assistant tool_use message and verify the very next message
    // is a user message whose content covers the same tool_use_id.
    let toolUseIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role !== 'assistant' || typeof m.content === 'string') continue;
      for (const b of m.content as ContentBlockParam[]) {
        if (b.type === 'tool_use') {
          toolUseIdx = i;
          break;
        }
      }
      if (toolUseIdx >= 0) break;
    }
    expect(toolUseIdx).toBeGreaterThanOrEqual(0);
    const next = messages[toolUseIdx + 1];
    expect(next?.role).toBe('user');
    expect(typeof next?.content).not.toBe('string');
    const nextBlocks = next!.content as ContentBlockParam[];
    expect(nextBlocks.some((b) => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === 'toolu_ok')).toBe(true);
  });

  // Regression: the Anthropic Messages API rejects extra fields on custom
  // tool definitions with 400 `tools.0.custom.category: Extra inputs are
  // not permitted`. AnthropicToolDef carries internal classification
  // metadata (`category`, `concurrencySafe`, `riskClass`) that must be
  // stripped before send. `toWireTool` projects to the wire-safe shape;
  // this test pins the contract.
  it('strips internal classification metadata (category, concurrencySafe, riskClass) before sending tools to the API', async () => {
    let captured: { tools?: unknown } | undefined;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((params: unknown) => {
          captured = params as { tools?: unknown };
          return fromArray(makeTextStream('hi'));
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));

    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [
          {
            name: 'bash',
            description: 'run a shell command',
            input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
            category: 'shell',
            concurrencySafe: false,
            riskClass: 'destructive',
          },
        ],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    expect(captured).toBeDefined();
    const sentTools = (captured!.tools as Array<Record<string, unknown>> | undefined) ?? [];
    expect(sentTools).toHaveLength(1);
    const sent = sentTools[0]!;
    // wire-safe fields preserved
    expect(sent['name']).toBe('bash');
    expect(sent['description']).toBe('run a shell command');
    expect(sent['input_schema']).toBeDefined();
    // internal metadata MUST be stripped — these caused the 400
    expect(sent).not.toHaveProperty('category');
    expect(sent).not.toHaveProperty('concurrencySafe');
    expect(sent).not.toHaveProperty('riskClass');
    // exhaustive: only the three wire-safe keys leave the boundary
    expect(Object.keys(sent).sort()).toEqual(['description', 'input_schema', 'name']);
  });

  it('omits `description` when not provided (does not emit `description: undefined`)', async () => {
    let captured: { tools?: unknown } | undefined;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((params: unknown) => {
          captured = params as { tools?: unknown };
          return fromArray(makeTextStream('hi'));
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));

    await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'hi' }],
        system: null,
        tools: [{ name: 'no_desc', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
      }),
    );

    const sentTools = (captured!.tools as Array<Record<string, unknown>>);
    expect(Object.keys(sentTools[0]!).sort()).toEqual(['input_schema', 'name']);
  });
});
