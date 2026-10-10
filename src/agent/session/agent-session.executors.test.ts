/**
 * #3442: SDK opt-in executors on `AgentSession` (`AgentConfig.executors`).
 *
 * Covers: default bare session exposes no agent/skill/compose schemas and
 * reports `missingExecutors`; executors expose schemas on anthropic-direct and
 * openai-compatible, and survive a cross-family swap; executors + provider /
 * providerFactory throws; bind-once; close drains; tree budget abort.
 * Template: provider-switch.test.ts (both SDKs mocked at the client boundary).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type OpenAI from 'openai';
import { AgentSession } from './agent-session.js';
import { __setAnthropicClientFactory } from '../providers/anthropic-direct/index.js';
import { __setOpenAIClientFactory } from '../providers/openai-compatible/query.js';
import { AnthropicDirectProvider } from '../providers/anthropic-direct/index.js';
import { resetSlotBindings } from './model-slots.js';
import { registerSkill, _resetRegistry } from '../../skills/skill-registry.js';
import { createSessionBindSlot, type SessionExecutors } from './session-executors.js';
import { resetMissingExecutorsWarningForTests } from './session-setup.missing-executors.js';
import { InMemoryTraceWriter } from '../trace/index.js';
import { BudgetExceededError } from '../../utils/errors.js';
import type { Surface } from '../awareness/types.js';
import { deriveOrigin } from './session-identity.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn(), isDebugEnabled: () => false }));

const anthropicCreateMock = vi.fn();
class MockAnthropic { public messages = { create: anthropicCreateMock }; }
async function* fromArray<T>(arr: T[]): AsyncIterable<T> { for (const x of arr) yield x; }
function anthropicTextStream(text: string): RawMessageStreamEvent[] {
  return [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-4-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] as unknown as RawMessageStreamEvent[];
}
const openaiCreateMock = vi.fn();
function openaiChunks(text: string): unknown[] {
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
  ];
}

/** Fake bundle: stub executors with just the surface providers touch. */
function fakeExecutors(): SessionExecutors & { drain: ReturnType<typeof vi.fn>; bindSpy: ReturnType<typeof vi.fn> } {
  const slot = createSessionBindSlot();
  const bindSpy = vi.fn((s: Parameters<SessionExecutors['bind']>[0]) => slot.bind(s));
  const common = { setCwd: vi.fn() };
  return {
    subagentExecutor: { ...common, getSubagentsLite: () => ({ active: [], backgroundJobs: [] }) } as never,
    skillExecutor: { ...common, getManifestScope: () => ({}) } as never,
    composeExecutor: { ...common } as never,
    bind: bindSpy,
    bindSpy,
    drain: vi.fn(async () => undefined),
  };
}

function anthropicToolNames(): string[] {
  const req = anthropicCreateMock.mock.calls[0]?.[0] as { tools?: Array<{ name: string }> } | undefined;
  return (req?.tools ?? []).map((t) => t.name);
}
function openaiToolNames(): string[] {
  const req = openaiCreateMock.mock.calls[0]?.[0] as { tools?: Array<{ function: { name: string } }> } | undefined;
  return (req?.tools ?? []).map((t) => t.function.name);
}

describe('AgentSession — opt-in executors (#3442)', () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    resetSlotBindings();
    resetMissingExecutorsWarningForTests();
    anthropicCreateMock.mockReset();
    openaiCreateMock.mockReset();
    anthropicCreateMock.mockImplementation(() => fromArray(anthropicTextStream('a')));
    openaiCreateMock.mockImplementation(() => fromArray(openaiChunks('o')));
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
    __setOpenAIClientFactory(() => ({ chat: { completions: { create: openaiCreateMock } } }) as unknown as OpenAI);
    savedKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-openai-test';
  });
  afterEach(() => {
    __setAnthropicClientFactory(null);
    __setOpenAIClientFactory(null);
    if (savedKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = savedKey;
    resetSlotBindings();
    _resetRegistry();
    vi.restoreAllMocks();
  });

  it('default session: no agent/skill/compose schemas and missingExecutors when skills exist', async () => {
    registerSkill({ name: 'probe-3442', description: 'probe', handler: vi.fn() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test' });
    const second = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test' });
    try {
      expect(session.getSessionMetadata().missingExecutors).toEqual(['agent', 'skill', 'compose']);
      await session.sendMessage('hi');
      const names = anthropicToolNames();
      expect(names.length).toBeGreaterThan(0); // non-vacuous: other tools present
      expect(names).not.toContain('agent');
      expect(names).not.toContain('skill');
      expect(names).not.toContain('compose');
      // One-time process warning, not one per session.
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('without executors'))).toHaveLength(1);
    } finally {
      await session.close();
      await second.close();
    }
  });

  it('no missingExecutors when no skills are registered or a provider is injected', async () => {
    _resetRegistry();
    const bare = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test' });
    registerSkill({ name: 'probe-3442', description: 'probe', handler: vi.fn() });
    const injected = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'k', provider: new AnthropicDirectProvider() });
    try {
      expect(bare.getSessionMetadata().missingExecutors).toBeUndefined();
      expect(injected.getSessionMetadata().missingExecutors).toBeUndefined();
    } finally {
      await bare.close();
      await injected.close();
    }
  });

  it('anthropic-direct: executors expose agent/skill/compose; bind called once before init', async () => {
    const ex = fakeExecutors();
    const session = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test', executors: ex });
    try {
      expect(ex.bindSpy).toHaveBeenCalledTimes(1);
      expect(ex.bindSpy.mock.calls[0]?.[0]).toBe(session);
      expect(session.getSessionMetadata().missingExecutors).toBeUndefined();
      await session.sendMessage('hi');
      expect(anthropicToolNames()).toEqual(expect.arrayContaining(['agent', 'skill', 'compose']));
    } finally {
      await session.close();
    }
  });

  it('openai-compatible: executors expose agent/skill/compose', async () => {
    const ex = fakeExecutors();
    const session = new AgentSession({ model: 'gpt-4o-mini', apiKey: 'sk-openai-test', executors: ex });
    try {
      await session.sendMessage('hi');
      expect(openaiToolNames()).toEqual(expect.arrayContaining(['agent', 'skill', 'compose']));
    } finally {
      await session.close();
    }
  });

  it('providers rebuilt by a cross-family model swap keep the executors', async () => {
    const ex = fakeExecutors();
    const session = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test', executors: ex });
    try {
      await session.sendMessage('first');
      expect(anthropicToolNames()).toContain('agent');
      await session.setModel('gpt-4o-mini');
      await session.sendMessage('second');
      expect(openaiCreateMock).toHaveBeenCalledTimes(1);
      expect(openaiToolNames()).toEqual(expect.arrayContaining(['agent', 'skill', 'compose']));
      expect(ex.bindSpy).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });

  it('throws when executors is combined with provider or providerFactory', () => {
    expect(() => new AgentSession({ model: 'haiku', executors: fakeExecutors(), provider: new AnthropicDirectProvider() }))
      .toThrow(/cannot be combined with `provider`/);
    expect(() => new AgentSession({ model: 'haiku', executors: fakeExecutors(), providerFactory: () => new AnthropicDirectProvider() }))
      .toThrow(/cannot be combined with `providerFactory`/);
  });

  it('a bundle binds to exactly one session; a second session throws', async () => {
    const ex = fakeExecutors();
    const first = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test', executors: ex });
    try {
      expect(() => new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test', executors: ex }))
        .toThrow(/already bound/);
    } finally {
      await first.close();
    }
  });

  it('close() calls executors.drain AND config.drainSubagents', async () => {
    const ex = fakeExecutors();
    const drainSubagents = vi.fn(async () => undefined);
    const session = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test', executors: ex, drainSubagents });
    await session.waitForInitialization();
    await session.close();
    expect(ex.drain).toHaveBeenCalledTimes(1);
    expect(drainSubagents).toHaveBeenCalledTimes(1);
    expect(ex.drain.mock.calls[0]?.[0]).toBe(drainSubagents.mock.calls[0]?.[0]);
  });

  it('tree budget: subagent cost counts toward maxBudgetUsd and aborts with BudgetExceededError', async () => {
    const trace = new InMemoryTraceWriter();
    const session = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test', maxBudgetUsd: 1, traceWriter: trace });
    try {
      session.recordSubagentCompletion(undefined, 0.4);
      expect(session.abortSignal.aborted).toBe(false);
      session.recordSubagentCompletion({ inputTokens: 10 }, 0.7);
      expect(session.abortSignal.aborted).toBe(true);
      const reason = session.abortSignal.reason as BudgetExceededError;
      expect(reason).toBeInstanceOf(BudgetExceededError);
      expect(reason.runningCostUsd).toBeCloseTo(1.1);
      expect(reason.maxBudgetUsd).toBe(1);
      await new Promise((r) => setTimeout(r, 0));
      const budget = trace.events.filter((e) => e.kind === 'budget');
      expect(budget).toHaveLength(1);
      expect((budget[0]?.payload as { runningCostUsd: number }).runningCostUsd).toBeCloseTo(1.1);
    } finally {
      await session.close();
    }
  });

  it('tree budget: the per-turn gate is seeded with completed-subagent spend', async () => {
    const trace = new InMemoryTraceWriter();
    // Mock provider turns cost $0.001; 0.9 of subagent spend + one turn crosses 0.9005.
    const session = new AgentSession({ model: 'claude-haiku-4-5', provider: createMockProvider(), maxBudgetUsd: 0.9005, traceWriter: trace });
    try {
      await session.waitForInitialization();
      session.recordSubagentCompletion(undefined, 0.9);
      expect(session.abortSignal.aborted).toBe(false);
      await session.sendMessage('hi').catch(() => undefined);
      expect(session.abortSignal.reason).toBeInstanceOf(BudgetExceededError);
      await new Promise((r) => setTimeout(r, 0));
      expect(trace.events.filter((e) => e.kind === 'budget')).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it('tree budget is inert without maxBudgetUsd', async () => {
    const session = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test' });
    try {
      session.recordSubagentCompletion(undefined, 1000);
      expect(session.abortSignal.aborted).toBe(false);
    } finally {
      await session.close();
    }
  });

  it("Surface 'sdk' is accepted and maps to the unknown origin", () => {
    const s: Surface = 'sdk';
    expect(deriveOrigin(s)).toBe('unknown');
  });
});
