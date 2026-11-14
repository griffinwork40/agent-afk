// Wire-projection tests for the tool definitions the turn loop sends to
// `messages.create`. Before the loop split `toWireTool` had ZERO direct
// coverage — it was exported from loop.ts and imported by nothing, exercised
// only incidentally through full runTurn integration tests. The projection
// guards a real 400 (`tools.0.custom.<field>: Extra inputs are not permitted`),
// so it is pinned directly here.

import { describe, it, expect } from 'vitest';
import { toWireTool, buildRoundParams } from './round-request.js';
import type { AnthropicToolDef } from '../types.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources';

const SCHEMA = {
  type: 'object' as const,
  properties: { path: { type: 'string' } },
  required: ['path'],
};

describe('toWireTool', () => {
  it('strips every internal classification field the wire rejects', () => {
    const internal: AnthropicToolDef = {
      name: 'read_file',
      description: 'Read a file',
      input_schema: SCHEMA,
      category: 'read',
      concurrencySafe: true,
      riskClass: 'safe',
    };

    const wire = toWireTool(internal);

    expect(wire).toEqual({
      name: 'read_file',
      description: 'Read a file',
      input_schema: SCHEMA,
    });
    // Belt-and-braces: assert absence explicitly, since toEqual ignores
    // properties whose value is undefined.
    expect(Object.keys(wire)).not.toContain('category');
    expect(Object.keys(wire)).not.toContain('concurrencySafe');
    expect(Object.keys(wire)).not.toContain('riskClass');
  });

  it('OMITS description entirely when undefined rather than emitting the key', () => {
    const wire = toWireTool({ name: 'noop', input_schema: SCHEMA });

    expect(Object.keys(wire)).toEqual(['name', 'input_schema']);
    expect('description' in wire).toBe(false);
  });

  it('passes input_schema through by reference without cloning or reshaping', () => {
    const internal: AnthropicToolDef = { name: 't', input_schema: SCHEMA };
    expect(toWireTool(internal).input_schema).toBe(SCHEMA);
  });

  it('does not mutate the source definition', () => {
    const internal: AnthropicToolDef = {
      name: 'bash',
      input_schema: SCHEMA,
      category: 'execute',
      concurrencySafe: false,
    };
    const snapshot = structuredClone(internal);

    toWireTool(internal);

    expect(internal).toEqual(snapshot);
  });
});

const MESSAGES: MessageParam[] = [{ role: 'user', content: 'hi' }];

// ---------------------------------------------------------------------------
// openRound — orphan_repair trace event
// ---------------------------------------------------------------------------

import { vi, afterEach } from 'vitest';
import { openRound } from './round-request.js';
import { TurnAccumulator } from './turn-accumulator.js';
import { RoundRetryBudget } from './retry-budget.js';
import { InMemoryTraceWriter } from '../../../trace/writer.js';
import type { RunTurnInput } from '../types.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

afterEach(() => vi.restoreAllMocks());

/** Minimal async iterable that yields a message_stop event then ends. */
async function* minimalStream(): AsyncIterable<unknown> {
  yield { type: 'message_stop' };
}

/** Build a minimal RunTurnInput. Only fields consumed by openRound are set. */
function makeInput(overrides: { messages: MessageParam[]; traceWriter?: InMemoryTraceWriter }): RunTurnInput {
  const controller = new AbortController();
  return {
    client: {
      messages: {
        create: () => Promise.resolve(minimalStream()),
      },
    },
    messages: overrides.messages,
    system: null,
    tools: null,
    toolDispatcher: {} as RunTurnInput['toolDispatcher'],
    model: 'claude-test',
    maxTokens: 1024,
    headers: {},
    signal: controller.signal,
    ctx: { sessionId: 'test-session' },
    traceWriter: overrides.traceWriter,
  } as unknown as RunTurnInput;
}

/** Drain an AsyncGenerator fully, returning all yielded values. */
async function drainGen<T>(gen: AsyncGenerator<T, unknown, void>): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) break;
    out.push(step.value);
  }
  return out;
}

describe('openRound — orphan_repair trace event', () => {
  it('emits orphan_repair phase event when the history has an orphaned tool_use', async () => {
    const writer = new InMemoryTraceWriter();
    const messages: MessageParam[] = [
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_orphan_x', name: 'bash', input: {} },
        ] as ContentBlockParam[],
      },
      // Intentionally missing the user tool_result — this is the orphan.
    ];
    const input = makeInput({ messages, traceWriter: writer });
    const turn = new TurnAccumulator();
    const retry = new RoundRetryBudget();

    await drainGen(openRound({ input, turn, retry, ttfbTimeoutMs: 10_000, stallTimeoutMs: 30_000 }));

    // Wait a tick for the fire-and-forget write to settle.
    await new Promise((r) => setTimeout(r, 0));

    const phaseEvents = writer.events.filter(
      (e) => e.kind === 'session_phase' && e.payload.phase === 'orphan_repair',
    );
    expect(phaseEvents).toHaveLength(1);
    const meta = phaseEvents[0]!.payload.metadata as Record<string, string | number | boolean>;
    expect(meta.orphanIds).toContain('toolu_orphan_x');
    expect(meta.messageCount).toBe(2);
    // shapeBefore must be present and non-empty
    expect(typeof meta.shapeBefore).toBe('string');
    expect((meta.shapeBefore as string).length).toBeGreaterThan(0);
  });

  it('does NOT emit orphan_repair when history is healthy', async () => {
    const writer = new InMemoryTraceWriter();
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_ok', name: 'bash', input: {} },
        ] as ContentBlockParam[],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_ok', content: 'done' },
        ] as ContentBlockParam[],
      },
    ];
    const input = makeInput({ messages, traceWriter: writer });
    const turn = new TurnAccumulator();
    const retry = new RoundRetryBudget();

    await drainGen(openRound({ input, turn, retry, ttfbTimeoutMs: 10_000, stallTimeoutMs: 30_000 }));

    await new Promise((r) => setTimeout(r, 0));

    const phaseEvents = writer.events.filter(
      (e) => e.kind === 'session_phase' && e.payload.phase === 'orphan_repair',
    );
    expect(phaseEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// wind-down rounds keep the tools array (#4072)
// ---------------------------------------------------------------------------

describe('openRound — tools array on wind-down rounds', () => {
  it('sends the identical tools array when windDownReason is set (main request path)', async () => {
    const capturedParams: unknown[] = [];
    const controller = new AbortController();
    const tools: AnthropicToolDef[] = [
      { name: 'bash', description: 'Run a command', input_schema: SCHEMA },
      { name: 'read_file', description: 'Read a file', input_schema: SCHEMA },
    ];
    const input: RunTurnInput = {
      client: {
        messages: {
          create: (params: unknown) => {
            capturedParams.push(params);
            return Promise.resolve(minimalStream());
          },
        },
      },
      messages: [{ role: 'user', content: 'hi' }],
      system: null,
      tools,
      toolDispatcher: {} as RunTurnInput['toolDispatcher'],
      model: 'claude-test',
      maxTokens: 1024,
      headers: {},
      signal: controller.signal,
      ctx: { sessionId: 'test-session' },
    } as unknown as RunTurnInput;

    const turn = new TurnAccumulator();
    turn.windDownReason = 'tool_use_loop_capped';
    const retry = new RoundRetryBudget();

    await drainGen(openRound({ input, turn, retry, ttfbTimeoutMs: 10_000, stallTimeoutMs: 30_000 }));

    expect(capturedParams).toHaveLength(1);
    const params = capturedParams[0] as Record<string, unknown>;
    // Tools must be present and non-empty — not null, not undefined, not [].
    expect(Array.isArray(params['tools'])).toBe(true);
    expect((params['tools'] as unknown[]).length).toBe(2);
    // Wire names must match — confirms the array is the SAME definitions.
    const names = (params['tools'] as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('read_file');
  });

  it('sends the identical tools array when windDownReason is null (normal round)', async () => {
    const capturedParams: unknown[] = [];
    const controller = new AbortController();
    const tools: AnthropicToolDef[] = [
      { name: 'bash', description: 'Run a command', input_schema: SCHEMA },
    ];
    const input: RunTurnInput = {
      client: {
        messages: {
          create: (params: unknown) => {
            capturedParams.push(params);
            return Promise.resolve(minimalStream());
          },
        },
      },
      messages: [{ role: 'user', content: 'hi' }],
      system: null,
      tools,
      toolDispatcher: {} as RunTurnInput['toolDispatcher'],
      model: 'claude-test',
      maxTokens: 1024,
      headers: {},
      signal: controller.signal,
      ctx: { sessionId: 'test-session' },
    } as unknown as RunTurnInput;

    const turn = new TurnAccumulator();
    // windDownReason === null — normal round
    const retry = new RoundRetryBudget();

    await drainGen(openRound({ input, turn, retry, ttfbTimeoutMs: 10_000, stallTimeoutMs: 30_000 }));

    expect(capturedParams).toHaveLength(1);
    const params = capturedParams[0] as Record<string, unknown>;
    expect(Array.isArray(params['tools'])).toBe(true);
    expect((params['tools'] as unknown[]).length).toBe(1);
  });
});

describe('buildRoundParams', () => {
  it('includes temperature in the wire request when set', () => {
    const params = buildRoundParams({
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4096,
      messages: MESSAGES,
      system: null,
      tools: null,
      temperature: 0.3,
    });
    expect(params.temperature).toBe(0.3);
  });

  it('omits temperature from the wire request when undefined', () => {
    const params = buildRoundParams({
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4096,
      messages: MESSAGES,
      system: null,
      tools: null,
    });
    expect('temperature' in params).toBe(false);
  });

  // ── Fable 5.1 drop_block / block_binding wiring ──────────────────────────
  // thinking.block_binding.prefix_mismatch_behavior:'drop_block' tells the
  // Anthropic API to drop stale thinking blocks instead of returning HTTP 400.
  // It requires the thinking-binding-controls-2026-08-01 beta header and is
  // injected by resolve-params.ts for Fable 5.1 sessions.

  it('wires thinking.block_binding.prefix_mismatch_behavior:"drop_block" when thinkingBlockBinding is set (Fable 5.1)', () => {
    const params = buildRoundParams({
      model: 'claude-fable-5-1',
      maxTokens: 128_000,
      messages: MESSAGES,
      system: null,
      tools: null,
      thinking: { type: 'adaptive' },
      thinkingBlockBinding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(params.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
  });

  it('omits thinking.block_binding when thinkingBlockBinding is absent (non-Fable models)', () => {
    const params = buildRoundParams({
      model: 'claude-sonnet-4-20250514',
      maxTokens: 16_000,
      messages: MESSAGES,
      system: null,
      tools: null,
      thinking: { type: 'enabled', budget_tokens: 8_000 },
      // thinkingBlockBinding intentionally absent
    });
    // block_binding must not appear on the wire
    expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 8_000 });
    expect((params.thinking as Record<string, unknown>)['block_binding']).toBeUndefined();
  });

  it('omits thinking entirely when neither thinking nor thinkingBlockBinding is set', () => {
    const params = buildRoundParams({
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4096,
      messages: MESSAGES,
      system: null,
      tools: null,
    });
    expect('thinking' in params).toBe(false);
  });

  // ITEM 1: When thinking is undefined but thinkingBlockBinding IS defined (e.g.
  // daemon/Telegram sessions where no explicit thinking config is set but the
  // Fable 5.1 drop_block beta header was requested), buildRoundParams must
  // synthesize an adaptive thinking object with the block_binding wired.
  // Without this fix the beta header is sent with no drop_block policy → HTTP 400.
  it('synthesizes adaptive thinking with block_binding when thinkingBlockBinding is set but thinking is undefined (daemon/Telegram path)', () => {
    const params = buildRoundParams({
      model: 'claude-fable-5-1',
      maxTokens: 128_000,
      messages: MESSAGES,
      system: null,
      tools: null,
      // thinking intentionally absent — simulates daemon/Telegram session
      thinkingBlockBinding: { prefix_mismatch_behavior: 'drop_block' },
    });
    // Must produce a synthesized adaptive thinking object with block_binding
    expect(params.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    // Confirm the thinking key is actually present
    expect('thinking' in params).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// openRound — per-image pixel ceiling: notice, journal invalidation, trace
// ---------------------------------------------------------------------------

function pngB64(width: number, height: number): string {
  const buf = Buffer.alloc(29);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

function imageTurn(id: string, width: number, height: number): MessageParam[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'shot', input: {} }] as ContentBlockParam[] },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64(width, height) } }],
      }] as ContentBlockParam[],
    },
  ];
}

function fakeJournalSync(): { invalidateFrom: ReturnType<typeof vi.fn>; sync: ReturnType<typeof vi.fn>; order: string[] } {
  const order: string[] = [];
  return {
    order,
    invalidateFrom: vi.fn((i: number) => { order.push(`invalidate:${i}`); }),
    sync: vi.fn(() => { order.push('sync'); }),
  };
}

describe('openRound — per-image pixel ceiling', () => {
  it('yields exactly one notice, invalidates the journal from the earliest mutated index, and traces the real ceiling', async () => {
    const writer = new InMemoryTraceWriter();
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      ...imageTurn('tu_a', 100, 100), // indices 1,2 — fine
      ...imageTurn('tu_b', 3456, 14002), // indices 3,4 — oversized
      ...imageTurn('tu_c', 9000, 10), // indices 5,6 — oversized
    ];
    const input = makeInput({ messages, traceWriter: writer });
    const journal = fakeJournalSync();
    (input as unknown as { journalSync: unknown }).journalSync = journal;

    const events = await drainGen(openRound({ input, turn: new TurnAccumulator(), retry: new RoundRetryBudget(), ttfbTimeoutMs: 10_000, stallTimeoutMs: 30_000 }));
    await new Promise((r) => setTimeout(r, 0));

    const notices = events.filter((e) => e.type === 'notice');
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    if (notice.type !== 'notice') throw new Error('unreachable');
    expect(notice.kind).toBe('image-omitted');
    expect(notice.text).toContain('2 images');
    expect(notice.text).toContain('3456x14002');
    expect(notice.text).toContain('9000x10');
    expect(notice.text).toContain('8000px');

    expect(journal.invalidateFrom).toHaveBeenCalledTimes(1);
    expect(journal.invalidateFrom).toHaveBeenCalledWith(4);
    expect(journal.order.slice(0, 2)).toEqual(['invalidate:4', 'sync']);

    const phases = writer.events.filter((e) => e.kind === 'session_phase' && e.payload.phase === 'many_image_degraded');
    expect(phases).toHaveLength(1);
    const evt = phases[0]!;
    if (evt.kind !== 'session_phase') throw new Error('unreachable');
    const meta = evt.payload.metadata as Record<string, unknown>;
    expect(meta['degradedCount']).toBe(2);
    expect(meta['imageCount']).toBe(3);
    expect(meta['maxDimension']).toBe(8000);
    expect(meta['manyImage']).toBe(false);
  });

  it('yields no notice and requests no invalidation when every image is within the limit', async () => {
    const writer = new InMemoryTraceWriter();
    const messages: MessageParam[] = [{ role: 'user', content: 'go' }, ...imageTurn('tu_ok', 8000, 8000)];
    const input = makeInput({ messages, traceWriter: writer });
    const journal = fakeJournalSync();
    (input as unknown as { journalSync: unknown }).journalSync = journal;

    const events = await drainGen(openRound({ input, turn: new TurnAccumulator(), retry: new RoundRetryBudget(), ttfbTimeoutMs: 10_000, stallTimeoutMs: 30_000 }));
    await new Promise((r) => setTimeout(r, 0));

    expect(events.filter((e) => e.type === 'notice')).toHaveLength(0);
    expect(journal.invalidateFrom).not.toHaveBeenCalled();
    expect(journal.sync).toHaveBeenCalledTimes(1);
    expect(writer.events.filter((e) => e.kind === 'session_phase' && e.payload.phase === 'many_image_degraded')).toHaveLength(0);
  });
});
