/**
 * Regression: a busy gpt-* subagent on ChatGPT-subscription auth was killed by
 * the subagent idle watchdog at exactly its window (8 min in production) with
 * `last event: none`, despite dozens of completed tool rounds.
 *
 * Root cause: `wrapTurnWithOAuthRefresh` (query/token-refresh.ts) buffered the
 * ENTIRE turn for `auth.source === 'chatgpt-oauth'` sessions and flushed only
 * when the turn ended, so the provider yielded zero events mid-turn. The idle
 * watchdog (subagent/idle-watchdog.ts) is fed exclusively by those events, so
 * it never re-armed and fired on its initial window no matter how busy the
 * child was. API-key sessions (`source: 'env'`) pass straight through and were
 * unaffected — the control case below.
 *
 * The test drives the REAL chain short of the session plumbing (which is a
 * pass-through, session/turn-stream-runner.ts): OpenAICompatibleQuery with a
 * scripted multi-round Responses-wire model and a real SessionToolDispatcher →
 * transformProviderEvent → IdleWatchdog.onEvent, on fake timers. Each model
 * round takes 600ms against a 1000ms idle window; five rounds = 3s total.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { Message, SessionMetadata } from '../../types.js';
import type { OutputEvent } from '../../types/session-types.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import type { ToolHandler } from '../../tools/types.js';
import { __setOpenAIClientFactory, OpenAICompatibleQuery, type OpenAIClientFactory } from './query.js';
import type { ResponsesStreamEvent } from './responses-translate.js';
import type { OpenAIAuthResolution } from './auth.js';
import { transformProviderEvent, type TransformDeps } from '../../session/stream-consumer.js';
import { IdleWatchdog } from '../../subagent/idle-watchdog.js';
import { IdleWatchdogError } from '../../../utils/errors.js';

const ROUND_LATENCY_MS = 600;
const IDLE_WINDOW_MS = 1_000;
const TOOL_ROUNDS = 4;

function toolRound(i: number): ResponsesStreamEvent[] {
  return [
    { type: 'response.created' },
    { type: 'response.output_text.delta', delta: `step ${i} ` },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: `fi_${i}`, call_id: `call_${i}`, name: 'echo', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 1,
      item_id: `fi_${i}`,
      arguments: `{"msg":"r${i}"}`,
    },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
  ] as unknown as ResponsesStreamEvent[];
}

const finalRound = [
  { type: 'response.created' },
  { type: 'response.output_text.delta', delta: 'all done' },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
] as unknown as ResponsesStreamEvent[];

/** Scripted Responses client: every round waits ROUND_LATENCY_MS (model think time) before streaming. */
function installSlowScriptedClient(): void {
  const script = [...Array.from({ length: TOOL_ROUNDS }, (_, i) => toolRound(i)), finalRound];
  let idx = 0;
  const factory: OpenAIClientFactory = () =>
    ({
      responses: {
        create: async () => {
          const events = script[idx++];
          if (!events) throw new Error(`no scripted round at ${idx - 1}`);
          await new Promise((r) => setTimeout(r, ROUND_LATENCY_MS));
          return (async function* () {
            for (const e of events) yield e;
          })();
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

function echoDispatcher(): SessionToolDispatcher {
  const echo: ToolHandler = async (input) => ({ content: `echoed ${JSON.stringify(input)}` });
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([['echo', echo]]),
    schemas: [{ name: 'echo', description: 'Echo', input_schema: { type: 'object', properties: { msg: { type: 'string' } } } }],
    hookRegistry: undefined,
  });
}

function transformDeps(): TransformDeps {
  let meta: SessionMetadata = { sessionId: 's', model: 'gpt-5', permissionMode: 'default' };
  const history: Message[] = [];
  return {
    conversationHistory: history,
    getSessionMetadata: () => meta,
    setSessionMetadata: (u) => { meta = u(meta); },
    updateSessionIdentity: vi.fn(),
    resolveInitialization: vi.fn(),
    setLastResponseMetadata: vi.fn(),
    _runningCostUsd: 0,
  };
}

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

interface RunResult {
  fired: boolean;
  lastEventType: string | undefined;
  /** Output events the watchdog observed BEFORE the turn's terminal event. */
  observedBeforeDone: number;
  sawDone: boolean;
}

/** Drive one busy multi-round turn through provider → transform → IdleWatchdog. */
async function runBusyTurn(auth: OpenAIAuthResolution): Promise<RunResult> {
  installSlowScriptedClient();
  const controller = new AbortController();
  let lastEventType: string | undefined;
  const watchdog = new IdleWatchdog(controller, IDLE_WINDOW_MS, 'gpt-child', (info) => {
    lastEventType = info.lastEventType;
  });
  const query = new OpenAICompatibleQuery({
    auth,
    model: 'gpt-5',
    synthesizedSessionId: 'sess-wd',
    promptStream: singleInput('grind through the task'),
    config: { model: 'gpt-5', systemPrompt: 'sys' } as unknown as AgentConfig,
    toolDispatcher: echoDispatcher(),
    useResponsesApi: true, // same wire for both auth sources; chatgpt-oauth forces it anyway
  });
  // A fresh OpenAICompatibleQuery reads `_authDeps` only on a 401 — keep it hermetic anyway.
  query._authDeps = { readEnv: () => undefined, readFile: () => null };

  const deps = transformDeps();
  let observedBeforeDone = 0;
  let sawDone = false;
  // Mirrors handle.streaming.ts: the watchdog's abort is the consumer's stop signal.
  controller.signal.addEventListener('abort', () => { void query.interrupt(); query.close(); });

  const consume = (async () => {
    for await (const ev of query as AsyncIterable<ProviderEvent>) {
      if (ev.type === 'session.init') continue; // consumed by session init, not the turn stream
      const out: OutputEvent | null = transformProviderEvent(ev, deps);
      if (!out) continue;
      watchdog.onEvent(out);
      if (out.type === 'done') { sawDone = true; break; }
      observedBeforeDone++;
      if (out.type === 'error') break;
    }
  })();

  // Total model latency is (TOOL_ROUNDS + 1) * ROUND_LATENCY_MS = 3s — 3× the idle window.
  for (let t = 0; t < (TOOL_ROUNDS + 2) * ROUND_LATENCY_MS && !sawDone && !controller.signal.aborted; t += 100) {
    await vi.advanceTimersByTimeAsync(100);
  }
  await Promise.race([consume, vi.advanceTimersByTimeAsync(5_000)]);
  watchdog.dispose();
  query.close();
  return {
    fired: controller.signal.reason instanceof IdleWatchdogError,
    lastEventType,
    observedBeforeDone,
    sawDone,
  };
}

describe('openai-compatible → subagent idle watchdog: progress is yielded incrementally', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_VITALS', '0');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    __setOpenAIClientFactory(null);
  });

  it('control: API-key auth streams every round, so a busy multi-round child is never cut off', async () => {
    const r = await runBusyTurn({ apiKey: 'sk-x', source: 'env' });
    expect(r.fired).toBe(false);
    expect(r.sawDone).toBe(true);
    expect(r.observedBeforeDone).toBeGreaterThan(TOOL_ROUNDS * 2);
  });

  it('chatgpt-oauth auth (gpt-* subscription models) also streams every round — watchdog never fires', async () => {
    const r = await runBusyTurn({ apiKey: 'tok', source: 'chatgpt-oauth', accountId: 'acct' });
    // Pre-fix: fired at the first idle window with lastEventType 'none' — the
    // exact production signature — because the OAuth-refresh wrapper held
    // every event until the turn ended.
    expect(r.lastEventType).toBeUndefined();
    expect(r.fired).toBe(false);
    expect(r.sawDone).toBe(true);
    expect(r.observedBeforeDone).toBeGreaterThan(TOOL_ROUNDS * 2);
  });
});
