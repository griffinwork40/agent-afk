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
});
