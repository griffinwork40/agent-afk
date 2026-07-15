import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { OpenAIChunk } from './translate.js';
import type { ToolCall, ToolResult } from '../anthropic-direct/types.js';
import { __setOpenAIClientFactory, OpenAICompatibleQuery, type OpenAIClientFactory } from './query.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { builtinToolSchemas } from '../../tools/schemas.js';
import { createHookRegistry } from '../../hooks.js';
import type { ToolHandler } from '../../tools/types.js';
import { DenialCircuitBreakerError } from '../../../utils/errors.js';
import {
  DENIAL_BREAKER_FAILURE_CLASS,
  DENIAL_CIRCUIT_BREAKER_THRESHOLD,
} from '../../tools/denial-circuit-breaker.js';

// #546: the openai-compatible provider is the SECOND half wired for the denial
// circuit breaker (query.ts + query/dispatch-append.ts). When the dispatcher
// tags a tool result `failureClass: 'denial-breaker'`, dispatchAndAppend hands
// the tripping ToolResult back up through its widened generator return type
// (`AsyncGenerator<ProviderEvent, ToolResult | undefined>`, read via the nested
// `{ call, result }` shape), and query.ts surfaces a LOUD terminal `error`
// event (→ DenialCircuitBreakerError), nulls its abortController, and STOPS the
// loop — never looping to the wall-clock budget, never a silent success. This
// file is the openai analog of anthropic-direct/loop.denial-breaker.test.ts and
// additionally proves the REAL dispatcher trips end-to-end through this loop.

// ---- minimal scripted-client harness (mirrors query.test.ts) --------------

let createCalls: Array<{ args: unknown }> = [];
let scriptedTurns: Array<{ chunks: OpenAIChunk[] }> = [];
let scriptedTurnIndex = 0;

function installScriptedClient(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (args: { stream?: boolean }) => {
            createCalls.push({ args });
            if (!args.stream) throw new Error('test mock only supports streaming');
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

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

function baseConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return { model: 'gpt-4o-mini', apiKey: 'sk-test-key', ...over } as AgentConfig;
}

/** One scripted round in which the model issues a single read_file tool call. */
function readRound(id: string, filePath: string): { chunks: OpenAIChunk[] } {
  return {
    chunks: [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: 'function',
                  function: { name: 'read_file', arguments: JSON.stringify({ file_path: filePath }) },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      },
    ],
  };
}

/** A trailing text round the loop must NEVER reach once the breaker trips. */
const NEVER_REACHED_TEXT_ROUND: { chunks: OpenAIChunk[] } = {
  chunks: [
    {
      choices: [{ delta: { content: 'this round must never run' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ],
};

const DENIAL_MSG =
  'Denial circuit breaker: this forked sub-agent hit 5 consecutive path-approval read denials';

beforeEach(() => {
  createCalls = [];
  scriptedTurns = [];
  scriptedTurnIndex = 0;
  installScriptedClient();
});

afterEach(() => {
  __setOpenAIClientFactory(null);
});

// ---------------------------------------------------------------------------

describe('openai-compatible query.ts — denial circuit breaker fail-loud', () => {
  it('yields a terminal DenialCircuitBreakerError and STOPS the loop on a denial-breaker result', async () => {
    // Round 1: model issues a read; the dispatcher tags it denial-breaker.
    // Round 2 (text) must NEVER be requested — tripping ends the turn.
    scriptedTurns = [readRound('r1', '/out-of-scope/x.ts'), NEVER_REACHED_TEXT_ROUND];

    // A dispatcher that returns a denial-breaker result (like the real one on the
    // Nth consecutive fork read denial). Implements both entry points because
    // dispatchAndAppend prefers executeBatch, falling back to execute.
    const denialDispatcher = {
      execute: async (): Promise<ToolResult> => ({
        content: DENIAL_MSG,
        isError: true,
        failureClass: DENIAL_BREAKER_FAILURE_CLASS,
      }),
      executeBatch: async (calls: ToolCall[]): Promise<ToolResult[]> =>
        calls.map(() => ({
          content: DENIAL_MSG,
          isError: true,
          failureClass: DENIAL_BREAKER_FAILURE_CLASS,
        })),
    };

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('read a bunch of files'),
      config: baseConfig(),
      toolDispatcher: denialDispatcher,
    });
    const events = await collect(q);

    // 1. A loud error event carrying the actionable message.
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error).toBeInstanceOf(DenialCircuitBreakerError);
      expect(errorEvent.error.message).toContain('Denial circuit breaker');
    }

    // 2. The loop STOPPED — only round 1 was requested; the wall-clock burn #546
    //    kills never happens (round 2's text turn is never consumed).
    expect(createCalls).toHaveLength(1);

    // 3. Fail LOUD, not silent success: no clean turn.completed after the trip.
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false);
  });

  it('trips end-to-end through the REAL dispatcher + openai loop on the Nth fork read denial', async () => {
    // THRESHOLD rounds, each issuing a DISTINCT out-of-scope read (so the
    // byte-identical repeat breaker never fires — only THIS breaker can catch
    // it), plus a trailing text round that must never be requested.
    scriptedTurns = [
      ...Array.from({ length: DENIAL_CIRCUIT_BREAKER_THRESHOLD }, (_, i) =>
        readRound(`rr${i}`, `/out-of-scope/f${i}.ts`),
      ),
      NEVER_REACHED_TEXT_ROUND,
    ];

    // Real path-approval-style PreToolUse hook: auto-denies fork reads with the
    // genuine containment reason (the prefix the breaker gates on).
    const hookRegistry = createHookRegistry();
    hookRegistry.register('PreToolUse', async (ctx) => {
      if (ctx.event === 'PreToolUse' && ctx.toolName === 'read_file') {
        const filePath = (ctx.input as { file_path?: string }).file_path ?? '<unknown>';
        return {
          decision: 'block' as const,
          reason: `Sub-agent path access denied: ${filePath} is outside the session's granted read roots.`,
        };
      }
      return {};
    });
    const dispatcher = new SessionToolDispatcher({
      handlers: new Map<string, ToolHandler>(),
      schemas: [...builtinToolSchemas],
      permissions: { allowedTools: ['read_file'] },
      hookRegistry,
      parentSessionId: 'parent-e2e', // wired like a forked child
    });

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('read files'),
      config: baseConfig(),
      toolDispatcher: dispatcher,
    });
    const events = await collect(q);

    // The real dispatcher tripped and the loop surfaced it loudly.
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.type).toBe('error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error).toBeInstanceOf(DenialCircuitBreakerError);
      // Actionable: the accumulated denied paths are named in the message.
      expect(errorEvent.error.message).toContain('/out-of-scope/f0.ts');
    }

    // Exactly THRESHOLD rounds were requested — the Nth tripped, so the trailing
    // text round was never reached (no wall-clock burn).
    expect(createCalls).toHaveLength(DENIAL_CIRCUIT_BREAKER_THRESHOLD);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false);
  });
});
