import { describe, it, expect, vi } from 'vitest';
import type { IAgentSession, OutputEvent } from '../types.js';
import { SubagentHandleImpl } from './handle.js';
import { AbortGraph } from '../abort-graph.js';
import { ModelRejectedError } from '../providers/shared/model-rejected-error.js';
import { InMemoryTraceWriter } from '../trace/index.js';
import { MODEL_FALLBACK_WARNING_PREFIX, type HandleModelFallback } from './handle.model-fallback.js';

type Script = (signal: AbortSignal) => AsyncGenerator<OutputEvent>;

function session(script: Script, close = vi.fn(async () => {})): IAgentSession {
  const ac = new AbortController();
  return {
    sessionId: 's', state: 'idle', abortSignal: ac.signal,
    sendMessageStream: () => script(ac.signal),
    interrupt: async () => {}, close,
    getHistory: () => [],
    getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
  } as unknown as IAgentSession;
}

const rejected = (): Error => new ModelRejectedError('ChatGPT/Codex backend rejected model "q36-hf" (HTTP 400).', 'q36-hf', 400, 'openai-compatible');
const ok = (text: string): Script => async function* () {
  yield { type: 'message', message: { role: 'assistant', content: text, timestamp: new Date() } } as OutputEvent;
  yield { type: 'done', stopReason: 'end_turn' } as unknown as OutputEvent;
};
const fail = (err: Error, before: OutputEvent[] = []): Script => async function* () {
  for (const e of before) yield e;
  yield { type: 'error', error: err } as OutputEvent;
};

function makeHandle(first: IAgentSession, fallback?: Partial<HandleModelFallback> & { second?: IAgentSession }) {
  const graph = new AbortGraph();
  const controller = new AbortController();
  graph.register('h', controller);
  const trace = new InMemoryTraceWriter();
  const onTerminal = vi.fn();
  const handle = new SubagentHandleImpl('h', first, controller, graph, undefined, 5000, undefined, onTerminal, undefined, undefined, 'agent', undefined, undefined, trace);
  const createSession = vi.fn(() => fallback?.second ?? session(ok('fallback answer')));
  if (fallback !== undefined) {
    handle._modelFallback = { fromModel: fallback.fromModel ?? 'q36-hf', toModel: fallback.toModel ?? 'claude-opus-4', createSession };
  }
  return { handle, controller, trace, createSession, onTerminal };
}

const fallbackEvents = (trace: InMemoryTraceWriter) =>
  trace.events.filter((e) => e.kind === 'session_phase' && (e.payload as { phase?: string }).phase === 'subagent_model_fallback');

describe('SubagentHandleImpl — default-tier model fallback', () => {
  it('zero-progress model rejection re-runs once on the parent model, warns, and traces', async () => {
    const firstClose = vi.fn(async () => {});
    const { handle, trace, createSession, onTerminal } = makeHandle(session(fail(rejected()), firstClose), {});
    const result = await handle.runToResult('go');
    expect(result.status).toBe('succeeded');
    expect(result.message?.content.startsWith(MODEL_FALLBACK_WARNING_PREFIX)).toBe(true);
    expect(result.message?.content).toContain('"q36-hf"');
    expect(result.message?.content).toContain('"claude-opus-4"');
    expect(result.message?.content).toContain('fallback answer');
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(firstClose).toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledTimes(1); // single terminal → budget released once
    const ev = fallbackEvents(trace);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ metadata: { fromModel: 'q36-hf', toModel: 'claude-opus-4', subagentId: 'h' } });
  });

  it('no fallback configured (explicit model) → rejection surfaces unchanged', async () => {
    const { handle, trace } = makeHandle(session(fail(rejected())));
    const result = await handle.runToResult('go');
    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(ModelRejectedError);
    expect(fallbackEvents(trace)).toHaveLength(0);
  });

  it('rejection AFTER progress (streamed text) does not re-run', async () => {
    const partial = { type: 'chunk', chunk: { type: 'content', content: 'half an answer' } } as unknown as OutputEvent;
    const { handle, createSession } = makeHandle(session(fail(rejected(), [partial])), {});
    const result = await handle.runToResult('go');
    expect(result.status).toBe('failed');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejection AFTER a tool call does not re-run', async () => {
    const tool = { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'bash', toolInput: '{}' } } as unknown as OutputEvent;
    const { handle, createSession } = makeHandle(session(fail(rejected(), [tool])), {});
    const result = await handle.runToResult('go');
    expect(handle._currentTrace.toolCalls.length + handle._lastStreamedContent.length).toBeGreaterThan(0);
    expect(result.status).toBe('failed');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('fallback model equal to the failed model does not re-run', async () => {
    const { handle, createSession } = makeHandle(session(fail(rejected())), { fromModel: 'same', toModel: 'same' });
    expect((await handle.runToResult('go')).status).toBe('failed');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('non-model errors (429-shaped, generic 400) do not re-run', async () => {
    const e429 = Object.assign(new Error('rate limited'), { status: 429 });
    const { handle, createSession } = makeHandle(session(fail(e429)), {});
    expect((await handle.runToResult('go')).status).toBe('failed');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('a second rejection on the fallback model fails (one-shot, no chain)', async () => {
    const { handle, createSession } = makeHandle(session(fail(rejected())), { second: session(fail(rejected())) });
    const result = await handle.runToResult('go');
    expect(result.status).toBe('failed');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('parent abort during the retry aborts the retry (same controller)', async () => {
    let release: () => void = () => {};
    const hang: Script = async function* (signal) {
      await new Promise<void>((r) => { release = r; signal.addEventListener('abort', () => r(), { once: true }); });
      throw new DOMException('Aborted', 'AbortError');
    };
    const ctx = makeHandle(session(fail(rejected())), { second: session(hang) });
    const p = ctx.handle.runToResult('go');
    await vi.waitFor(() => expect(ctx.createSession).toHaveBeenCalled());
    ctx.controller.abort('parent');
    release();
    const result = await p;
    expect(result.status).toBe('cancelled');
  });
});
