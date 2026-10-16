/**
 * Regression: Stop-hook continuation must carry earlier segments' usage
 * forward so the turn.completed event reports the SUM of all segments.
 *
 * Issue #3930: `accumulatedUsage` was reset at the top of each outer-loop
 * iteration, causing earlier segments' tokens to drop out of the turn's
 * billing rollup when a blocking Stop hook returned `continueWith`.
 *
 * Fix: hoist a `turnUsage` accumulator outside the outer loop and fold each
 * segment into it before looping or before emitting `turn.completed`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../../provider.js';
import { __setOpenAIClientFactory, OpenAICompatibleQuery, type OpenAIClientFactory } from '../query.js';
import type { AgentConfig } from '../../../types/config-types.js';
import type { OpenAIChunk } from '../translate.js';

// ---- minimal mock client --------------------------------------------------

type ScriptedTurn = { chunks: OpenAIChunk[] };
let scriptedTurns: ScriptedTurn[] = [];
let scriptedTurnIndex = 0;

function installScriptedClient(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (args: { stream?: boolean }) => {
            if (!args.stream) throw new Error('mock: streaming only');
            const script = scriptedTurns[scriptedTurnIndex++];
            if (!script) throw new Error(`scripted turn ${scriptedTurnIndex - 1} not defined`);
            const chunks = script.chunks.slice();
            return (async function* () {
              for (const c of chunks) yield c;
            })();
          },
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

beforeEach(() => {
  scriptedTurns = [];
  scriptedTurnIndex = 0;
  installScriptedClient();
});

afterEach(() => {
  __setOpenAIClientFactory(null as never);
});

// ---- helpers --------------------------------------------------------------

async function collect(q: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of q) out.push(ev);
  return out;
}

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

function baseConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: 'gpt-4o-mini',
    apiKey: 'sk-test-key',
    ...over,
  } as AgentConfig;
}

/** Minimal stop-chunk (finish_reason='stop') with usage. */
function stopChunk(promptTokens: number, completionTokens: number, text = ''): OpenAIChunk[] {
  return [
    ...(text ? [{ choices: [{ delta: { content: text } }] } as OpenAIChunk] : []),
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    } as OpenAIChunk,
  ];
}

// ---- tests ----------------------------------------------------------------

describe('stop-hook continuation usage accumulation (#3930)', () => {
  it('turn.completed usage equals sum of both segments when Stop hook fires once', async () => {
    // Segment 1: model responds normally (10 in, 5 out → stop).
    // Stop hook fires → continueWith.
    // Segment 2: model responds again (12 in, 8 out → stop).
    // Expected total: inputTokens = 22, outputTokens = 13.

    scriptedTurns = [
      { chunks: stopChunk(10, 5, 'segment one') },   // segment 1
      { chunks: stopChunk(12, 8, 'segment two') },   // segment 2 (after continuation)
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk-test-key', source: 'api-key' } as never,
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'test-session',
      promptStream: singleInput('go'),
      config: baseConfig(),
    });

    let callCount = 0;
    q.setBeforeTurnEnd(async (_continuation) => {
      callCount += 1;
      if (callCount === 1) {
        // First natural end: tell the turn to continue.
        return { continueWith: 'please continue' };
      }
      // Second natural end: let the turn finish.
      return undefined;
    });

    const events = await collect(q);
    const terminal = events.find((e) => e.type === 'turn.completed');
    expect(terminal?.type).toBe('turn.completed');
    if (terminal?.type === 'turn.completed') {
      // Pre-fix: inputTokens=12, outputTokens=8 (only segment 2 counted).
      // Post-fix: inputTokens=22, outputTokens=13 (both segments summed).
      expect(terminal.usage.inputTokens).toBe(22);
      expect(terminal.usage.outputTokens).toBe(13);
      expect(terminal.usage.totalTokens).toBe(35);
    }
    expect(callCount).toBe(2);
  });

  it('turn.completed usage is unchanged (single segment, no continuation)', async () => {
    // Baseline: no stop-hook continuation; behaviour must not regress.
    scriptedTurns = [
      { chunks: stopChunk(10, 5, 'hello') },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk-test-key', source: 'api-key' } as never,
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'test-session',
      promptStream: singleInput('hi'),
      config: baseConfig(),
    });

    q.setBeforeTurnEnd(async () => undefined);

    const events = await collect(q);
    const terminal = events.find((e) => e.type === 'turn.completed');
    expect(terminal?.type).toBe('turn.completed');
    if (terminal?.type === 'turn.completed') {
      expect(terminal.usage.inputTokens).toBe(10);
      expect(terminal.usage.outputTokens).toBe(5);
    }
  });
});
