// Witness-layer trace emission + render-only diff sidecar tests for loop.ts
// runTurn. Split out of loop.test.ts (#370) — bodies moved verbatim.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import type { AnthropicClientLike, ToolResult } from './types.js';
import {
  fromArray,
  collect,
  ctx,
  makeTextStream,
  makeToolUseStream,
  makeClient,
  makeDispatcher,
} from './loop.test-helpers.js';

// ---------------------------------------------------------------------------
// Witness-layer trace emission (PR #2 commit 2)
// ---------------------------------------------------------------------------

describe('loop.ts runTurn — witness-layer tool_call emission', () => {
  // Import dynamically inside the describe to avoid forcing an eager
  // import at module top when the rest of the file does not need it.
  it('emits tool_call.started before dispatch and tool_call.completed after', async () => {
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();

    // Two streams: first emits a tool_use, second emits final text.
    let callIdx = 0;
    const streams = [
      () => fromArray(makeToolUseStream('tu_1', 'search', '{"q":"hello"}')),
      () => fromArray(makeTextStream('done', 'end_turn')),
    ];
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => streams[callIdx++ % streams.length]!()),
      },
    };
    const dispatcher = makeDispatcher(async () => ({
      content: 'search result',
      isError: false,
    }));
    const messages: MessageParam[] = [{ role: 'user', content: 'search please' }];
    const ac = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'search', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: ac.signal,
        ctx,
        traceWriter: writer,
      }),
    );

    // Drain microtasks so the fire-and-forget emit calls settle.
    await new Promise((resolve) => setImmediate(resolve));

    const toolCalls = writer.events.filter((e) => e.kind === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    if (toolCalls[0]?.kind !== 'tool_call' || toolCalls[1]?.kind !== 'tool_call') {
      throw new Error('unreachable');
    }
    expect(toolCalls[0].payload.phase).toBe('started');
    expect(toolCalls[1].payload.phase).toBe('completed');
    if (toolCalls[0].payload.phase !== 'started') throw new Error('unreachable');
    if (toolCalls[1].payload.phase !== 'completed') throw new Error('unreachable');
    expect(toolCalls[0].payload.toolUseId).toBe('tu_1');
    expect(toolCalls[0].payload.name).toBe('search');
    expect(toolCalls[0].payload.inputBytes).toBeGreaterThan(0);
    expect(toolCalls[1].payload.toolUseId).toBe('tu_1');
    expect(toolCalls[1].payload.name).toBe('search');
    expect(toolCalls[1].payload.resultBytes).toBe(Buffer.byteLength('search result'));
    expect(toolCalls[1].payload.isError).toBe(false);
    expect(toolCalls[1].payload.truncated).toBe(false);
    expect(toolCalls[1].payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits exactly one model_ttfb session_phase on the first streamed event', async () => {
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();

    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => fromArray(makeTextStream('hi', 'end_turn'))),
      },
    };
    const messages: MessageParam[] = [{ role: 'user', content: 'hello' }];
    const ac = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [],
        toolDispatcher: makeDispatcher(async () => ({ content: '', isError: false })),
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: ac.signal,
        ctx,
        traceWriter: writer,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const ttfb = writer.events.filter(
      (e) =>
        e.kind === 'session_phase' &&
        (e.payload as { phase: string }).phase === 'model_ttfb',
    );
    // Single text-stream turn => exactly one model API call => one TTFB.
    expect(ttfb).toHaveLength(1);
    const payload = ttfb[0]!.payload as { durationMs?: number; resolvedModel?: string };
    expect(payload.durationMs).toBeTypeOf('number');
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    // model_ttfb carries the resolved wire id for THIS call (input.model).
    expect(payload.resolvedModel).toBe('claude-test');
  });

  it('records isError=true and truncated=true based on tool result content', async () => {
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();

    let callIdx = 0;
    const streams = [
      () => fromArray(makeToolUseStream('tu_err', 'bash', '{}')),
      () => fromArray(makeTextStream('done', 'end_turn')),
    ];
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => streams[callIdx++ % streams.length]!()),
      },
    };
    const dispatcher = makeDispatcher(async () => ({
      content: 'partial...[output truncated — exceeded 100KB]',
      isError: true,
    }));

    await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'run' }],
        system: null,
        tools: [{ name: 'bash', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        traceWriter: writer,
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));

    const completed = writer.events.find(
      (e) => e.kind === 'tool_call' && e.payload.phase === 'completed',
    );
    expect(completed?.kind).toBe('tool_call');
    if (completed?.kind !== 'tool_call' || completed.payload.phase !== 'completed') {
      throw new Error('unreachable');
    }
    expect(completed.payload.isError).toBe(true);
    expect(completed.payload.truncated).toBe(true);
  });

  // Regression: prefer the structured `ToolResult.truncated` flag over the
  // in-band sentinel string. Before this flag existed, the trace writer
  // sniffed `result.content.includes('[output truncated')` — fragile
  // because it relied on a particular sentinel literal staying in content
  // and because external (third-party) handlers had no clean way to mark
  // overflow. The dispatcher in this test returns truncated:true with NO
  // sentinel in content; both the trace and the `tool.output` event must
  // still reflect truncation.
  it('propagates ToolResult.truncated=true to trace and tool.output event without sentinel', async () => {
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();

    let callIdx = 0;
    const streams = [
      () => fromArray(makeToolUseStream('tu_t', 'bash', '{}')),
      () => fromArray(makeTextStream('done', 'end_turn')),
    ];
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => streams[callIdx++ % streams.length]!()),
      },
    };
    // Notably: content has no `[output truncated …]` sentinel string.
    // Detection must come from the structured flag alone.
    const dispatcher = makeDispatcher(async () => ({
      content: 'some legitimate-looking output with no sentinel',
      truncated: true,
    }));

    const events = await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'run' }],
        system: null,
        tools: [{ name: 'bash', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        traceWriter: writer,
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));

    // Trace records the structured flag.
    const completed = writer.events.find(
      (e) => e.kind === 'tool_call' && e.payload.phase === 'completed',
    );
    if (completed?.kind !== 'tool_call' || completed.payload.phase !== 'completed') {
      throw new Error('unreachable');
    }
    expect(completed.payload.truncated).toBe(true);

    // The tool.output ProviderEvent carries the flag through to downstream
    // consumers (stream-consumer → ToolResultChunk → subagent trace).
    const toolOutput = events.find((e) => e.type === 'tool.output');
    if (toolOutput?.type !== 'tool.output') {
      throw new Error('expected tool.output event');
    }
    expect(toolOutput.truncated).toBe(true);
  });

  it('emits no tool_call events when traceWriter is absent', async () => {
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();

    let callIdx = 0;
    const streams = [
      () => fromArray(makeToolUseStream('tu_q', 'search', '{}')),
      () => fromArray(makeTextStream('done', 'end_turn')),
    ];
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => streams[callIdx++ % streams.length]!()),
      },
    };
    const dispatcher = makeDispatcher(async () => ({ content: 'r', isError: false }));

    await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'x' }],
        system: null,
        tools: [{ name: 'search', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        // traceWriter omitted intentionally
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(writer.events).toHaveLength(0);
  });
});

describe('loop.ts runTurn — render-only diff sidecar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits tool.diff event when handler returns render.diff', async () => {
    // First iteration: tool_use. Second iteration: end_turn (to terminate the loop).
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) return fromArray(makeToolUseStream('tu_diff', 'edit_file', '{}'));
      return fromArray(makeTextStream('done', 'end_turn'));
    });

    const dispatcher = makeDispatcher(() =>
      Promise.resolve({
        content: 'Replaced 1 occurrence in /tmp/x.ts',
        render: {
          diff: {
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [{ kind: '-' as const, text: 'a' }, { kind: '+' as const, text: 'b' }],
              },
            ],
            addedLines: 1,
            removedLines: 1,
          },
        },
      }),
    );

    const events = await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'edit it' }],
        system: null,
        tools: [{ name: 'edit_file', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
      }),
    );

    // Find tool.output and tool.diff for the same toolUseId.
    const output = events.find((e) => e.type === 'tool.output');
    const diff = events.find((e) => e.type === 'tool.diff');
    expect(output).toBeDefined();
    expect(diff).toBeDefined();
    if (output?.type === 'tool.output' && diff?.type === 'tool.diff') {
      expect(diff.toolUseId).toBe(output.toolUseId);
      expect(diff.diff.addedLines).toBe(1);
      expect(diff.diff.removedLines).toBe(1);
    }

    // Order invariant: tool.diff arrives AFTER tool.output for the same id.
    const outputIdx = events.findIndex((e) => e.type === 'tool.output');
    const diffIdx = events.findIndex((e) => e.type === 'tool.diff');
    expect(diffIdx).toBeGreaterThan(outputIdx);
  });

  it('does NOT emit tool.diff when handler omits render', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) return fromArray(makeToolUseStream('tu_no_diff', 'read_file', '{}'));
      return fromArray(makeTextStream('done', 'end_turn'));
    });
    const dispatcher = makeDispatcher(() =>
      Promise.resolve({ content: 'file contents' }),
    );

    const events = await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'read it' }],
        system: null,
        tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
      }),
    );

    expect(events.some((e) => e.type === 'tool.output')).toBe(true);
    expect(events.some((e) => e.type === 'tool.diff')).toBe(false);
  });

  it('does NOT include render.diff in the model-facing tool_result block', async () => {
    // Structural correctness check: the messages array (which is what's
    // sent back to the model on the next iteration) must contain only the
    // result.content string — never the diff payload. This is the central
    // invariant the render channel exists to enforce.
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) return fromArray(makeToolUseStream('tu_leak', 'edit_file', '{}'));
      return fromArray(makeTextStream('done', 'end_turn'));
    });
    const dispatcher = makeDispatcher(() =>
      Promise.resolve({
        content: 'Replaced 1 occurrence',
        render: {
          diff: {
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [
                  { kind: '-' as const, text: 'SECRET_BEFORE' },
                  { kind: '+' as const, text: 'SECRET_AFTER' },
                ],
              },
            ],
            addedLines: 1,
            removedLines: 1,
          },
        },
      }),
    );

    const messages: MessageParam[] = [{ role: 'user', content: 'edit it' }];
    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'edit_file', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
      }),
    );

    // The loop pushes a `tool_result` MessageParam after dispatching tools.
    // Walk every tool_result block in the final messages array and assert
    // that no diff-payload sentinel ever appears in the content the model
    // would see.
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('SECRET_BEFORE');
    expect(serialized).not.toContain('SECRET_AFTER');
    expect(serialized).not.toContain('"hunks"');
    expect(serialized).not.toContain('"addedLines"');

    // And the model's tool_result content should be the one-line summary only.
    let found = false;
    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block &&
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'tool_result'
          ) {
            found = true;
            expect((block as { content: unknown }).content).toBe('Replaced 1 occurrence');
          }
        }
      }
    }
    expect(found).toBe(true);
  });
});
