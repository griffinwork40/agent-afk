/**
 * Fork-layer test for the default-tier model fallback: drives the REAL
 * `SubagentManager.forkSubagent` → `SubagentHandleImpl.run()` path with only
 * the child `AgentSession` replaced by a scripted fake, so the choke point
 * every caller (agent tool, background agent, skill forks, compose nodes,
 * /mint phases) shares is what is under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig, OutputEvent } from '../types.js';
import { ModelRejectedError } from '../providers/shared/model-rejected-error.js';

const constructed: AgentConfig[] = [];
const scripts: Array<() => AsyncGenerator<OutputEvent>> = [];

vi.mock('../session.js', () => ({
  AgentSession: class {
    sessionId = 'child';
    state = 'idle';
    abortSignal = new AbortController().signal;
    private readonly script: () => AsyncGenerator<OutputEvent>;
    constructor(cfg: AgentConfig) {
      constructed.push(cfg);
      this.script = scripts.shift() ?? (async function* () { /* empty */ });
    }
    sendMessageStream() { return this.script(); }
    async interrupt() {}
    async close() {}
    getHistory() { return []; }
    getInputStreamRef() { return { pushUserMessage: () => {} }; }
  },
}));

import { SubagentManager } from '../subagent.js';
import { InMemoryTraceWriter } from '../trace/index.js';
import { defaultTierModelFallback } from './resolve-child-model.js';

const reject = (model: string) => async function* (): AsyncGenerator<OutputEvent> {
  yield { type: 'error', error: new ModelRejectedError(`rejected ${model}`, model, 400, 'openai-compatible') } as OutputEvent;
};
const answer = (text: string) => async function* (): AsyncGenerator<OutputEvent> {
  yield { type: 'message', message: { role: 'assistant', content: text, timestamp: new Date() } } as OutputEvent;
  yield { type: 'done', stopReason: 'end_turn' } as unknown as OutputEvent;
};

beforeEach(() => { constructed.length = 0; scripts.length = 0; });

async function fork(modelFallback: { model: string } | undefined, trace = new InMemoryTraceWriter()) {
  const manager = new SubagentManager({ traceWriter: trace, apiKey: 'sk-ant-parent' });
  const handle = await manager.forkSubagent({
    parent: { sessionId: 'p' },
    config: { model: 'q36-hf', systemPrompt: 'x' },
    agentType: 'agent',
    ...(modelFallback !== undefined ? { modelFallback } : {}),
  });
  return { handle, trace };
}

describe('forkSubagent — default-tier model fallback (single choke point)', () => {
  it('default-tier child rejected with zero progress re-runs on the parent model with the parent credential', async () => {
    scripts.push(reject('q36-hf'), answer('done on opus'));
    const resolved = defaultTierModelFallback({ model: 'q36-hf', source: 'default' }, 'claude-opus-4-1');
    const { handle, trace } = await fork(resolved);
    const result = await handle.runToResult('task');
    expect(result.status).toBe('succeeded');
    expect(result.message?.content).toMatch(/^\[model-fallback\] default subagent model "q36-hf" was rejected/);
    expect(result.message?.content).toContain('done on opus');
    expect(constructed.map((c) => c.model)).toEqual(['q36-hf', 'claude-opus-4-1']);
    // Retry inherits the fork's abort signal (same controller → same abort graph / budget).
    expect(constructed[1]!.abortSignal).toBe(constructed[0]!.abortSignal);
    // The Anthropic fallback child resolves the parent's Anthropic credential
    // through the same anti-leak gate as a normal fork (child-credential.ts).
    expect(constructed[1]!.apiKey).toBe('sk-ant-parent');
    const phases = trace.events.filter((e) => e.kind === 'session_phase').map((e) => (e.payload as { phase: string }).phase);
    expect(phases).toContain('subagent_model_fallback');
  });

  it('explicit-model child (no modelFallback) fails loudly', async () => {
    scripts.push(reject('q36-hf'));
    const resolved = defaultTierModelFallback({ model: 'q36-hf', source: 'callSite' }, 'claude-opus-4-1');
    expect(resolved).toBeUndefined();
    const { handle } = await fork(resolved);
    const result = await handle.runToResult('task');
    expect(result.status).toBe('failed');
    expect(constructed).toHaveLength(1);
  });

  it('fallback equal to the failed model is never armed', async () => {
    expect(defaultTierModelFallback({ model: 'q36-hf', source: 'default' }, 'q36-hf')).toBeUndefined();
    scripts.push(reject('q36-hf'));
    const { handle } = await fork({ model: 'q36-hf' });
    expect((await handle.runToResult('task')).status).toBe('failed');
    expect(constructed).toHaveLength(1);
  });

  it('defaultTierModelFallback: only default/floor tiers with a different, known parent model', () => {
    expect(defaultTierModelFallback({ model: 'a', source: 'floor' }, 'b')).toEqual({ model: 'b' });
    expect(defaultTierModelFallback({ model: 'a', source: 'namedAgent' }, 'b')).toBeUndefined();
    expect(defaultTierModelFallback({ model: 'a', source: 'parent' }, 'b')).toBeUndefined();
    expect(defaultTierModelFallback({ model: 'a', source: 'default' }, undefined)).toBeUndefined();
  });
});
