/**
 * #3442: `createWiredExecutors` — the SDK factory for the agent/skill/compose
 * executor bundle. Covers fail-closed hooks, toggles, allowlist plumbing,
 * ignored-config warnings, bind-once, dispose idempotence, and an end-to-end
 * session where a model `skill` tool call routes into the SkillExecutor and
 * the result is fed back to the model (same flow as the REPL).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWiredExecutors } from './create-wired-executors.js';
import { AgentSession } from './agent-session.js';
import { queryText } from '../query.js';
import { __setAnthropicClientFactory } from '../providers/anthropic-direct/index.js';
import { createHookRegistry } from '../hook-registry.js';
import { registerSkill, _resetRegistry } from '../../skills/skill-registry.js';
import { resetSlotBindings } from './model-slots.js';
import type { AgentConfig } from '../types.js';
import type { SessionExecutorsBindTarget } from './session-executors.js';
import { SubagentManager } from '../subagent.js';
import { ComposeExecutor } from '../tools/compose-executor.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn(), isDebugEnabled: () => false }));

const createMock = vi.fn();
class MockAnthropic { public messages = { create: createMock }; }
async function* fromArray<T>(arr: T[]): AsyncIterable<T> { for (const x of arr) yield x; }

const usage = { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
function start(): RawMessageStreamEvent {
  return { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-4-5', stop_reason: null, stop_sequence: null, usage } } as unknown as RawMessageStreamEvent;
}
function textRound(text: string): RawMessageStreamEvent[] {
  return [
    start(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] as unknown as RawMessageStreamEvent[];
}
function toolRound(id: string, name: string, input: Record<string, unknown>): RawMessageStreamEvent[] {
  return [
    start(),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] as unknown as RawMessageStreamEvent[];
}
function requestTools(callIndex: number): string[] {
  const req = createMock.mock.calls[callIndex]?.[0] as { tools?: Array<{ name: string }> } | undefined;
  return (req?.tools ?? []).map((t) => t.name);
}

function fakeTarget(): SessionExecutorsBindTarget & { recordSubagentCompletion: ReturnType<typeof vi.fn> } {
  return {
    sessionId: 's-1',
    abortSignal: new AbortController().signal,
    hookRegistry: undefined,
    messageJournal: undefined,
    getInputStreamRef: () => ({ pushUserMessage: () => {} }),
    recordSubagentCompletion: vi.fn(),
  };
}

describe('createWiredExecutors (#3442)', () => {
  let cwd: string;
  let savedHome: string | undefined;
  let base: AgentConfig;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), 'afk-cwe-'));
    savedHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = path.join(cwd, '.afk-home');
    resetSlotBindings();
    createMock.mockReset();
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
    base = { model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test', cwd };
  });
  afterEach(() => {
    __setAnthropicClientFactory(null);
    if (savedHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedHome;
    _resetRegistry();
    resetSlotBindings();
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('fails closed without a hook registry or unattended', () => {
    expect(() => createWiredExecutors(base)).toThrow(/no hook registry/);
    expect(() => createWiredExecutors(base, { agent: true })).toThrow(/unattended: true/);
  });

  it('accepts unattended:true, opts.hookRegistry, or config.hookRegistry', async () => {
    const a = createWiredExecutors(base, { unattended: true, agent: true });
    const b = createWiredExecutors(base, { hookRegistry: createHookRegistry(), agent: true });
    const c = createWiredExecutors({ ...base, hookRegistry: createHookRegistry() }, { agent: true });
    for (const w of [a, b, c]) expect(w.executors.subagentExecutor).toBeDefined();
    await Promise.all([a.dispose(), b.dispose(), c.dispose()]);
  });

  it('toggles: opts object => omitted toggle is off; skill:false omits skillExecutor', async () => {
    const w = createWiredExecutors(base, { unattended: true, agent: true, compose: true, skill: false });
    expect(w.executors.subagentExecutor).toBeDefined();
    expect(w.executors.composeExecutor).toBeDefined();
    expect(w.executors.skillExecutor).toBeUndefined();
    const none = createWiredExecutors(base, { unattended: true });
    expect(none.executors.subagentExecutor).toBeUndefined();
    expect(none.executors.skillExecutor).toBeUndefined();
    expect(none.executors.composeExecutor).toBeUndefined();
    await Promise.all([w.dispose(), none.dispose()]);
  });

  it('opts omitted => all three executors (hook registry from config)', async () => {
    const w = createWiredExecutors({ ...base, hookRegistry: createHookRegistry() });
    expect(w.executors.subagentExecutor).toBeDefined();
    expect(w.executors.skillExecutor).toBeDefined();
    expect(w.executors.composeExecutor).toBeDefined();
    expect(w.executors.skillExecutor?.getManifestScope()).toEqual({ pluginConfigs: [] });
    await w.dispose();
  });

  it('skill string[] => allowlist reaches SkillExecutor.getManifestScope(); pluginConfigs default []', async () => {
    const w = createWiredExecutors(base, { unattended: true, skill: ['alpha', 'plugin:beta'] });
    expect(w.executors.skillExecutor?.getManifestScope()).toEqual({
      pluginConfigs: [],
      skillAllowlist: ['alpha', 'plugin:beta'],
    });
    await w.dispose();
  });

  it('warns once each for config.agents and config.mcpServers; default warn is silent', async () => {
    const warn = vi.fn();
    const cfg: AgentConfig = { ...base, agents: {}, mcpServers: {} };
    const w = createWiredExecutors(cfg, { unattended: true, agent: true, warn });
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs.filter((m) => m.includes('`config.agents` is ignored'))).toHaveLength(1);
    expect(msgs.filter((m) => m.includes('`config.mcpServers` is ignored') && m.includes('mcpManager'))).toHaveLength(1);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const silent = createWiredExecutors(cfg, { unattended: true, agent: true });
    expect(stderr.mock.calls.filter((c) => String(c[0]).includes('ignored on the SDK'))).toHaveLength(0);
    await Promise.all([w.dispose(), silent.dispose()]);
  });

  it('bind wires the subagent-success rollup and throws on a second bind', async () => {
    const mgrSpy = vi.spyOn(SubagentManager.prototype, 'setOnSubagentSucceeded');
    const composeSpy = vi.spyOn(ComposeExecutor.prototype, 'setOnSubagentSucceeded');
    const w = createWiredExecutors(base, { unattended: true, agent: true, compose: true });
    // Deferred proxy: unbound reads are safe, bound reads resolve to the target.
    const parent = (w.executors.subagentExecutor as unknown as { ctx: { parentSession: { sessionId: string | undefined } } }).ctx.parentSession;
    expect(parent.sessionId).toBeUndefined();
    const target = fakeTarget();
    w.executors.bind(target);
    expect(parent.sessionId).toBe('s-1');
    expect(mgrSpy).toHaveBeenCalledTimes(1);
    expect(composeSpy).toHaveBeenCalledTimes(1);
    mgrSpy.mock.calls[0]?.[0]({ inputTokens: 3 }, 0.25);
    composeSpy.mock.calls[0]?.[0](undefined, 0.5);
    expect(target.recordSubagentCompletion.mock.calls).toEqual([[{ inputTokens: 3 }, 0.25], [undefined, 0.5]]);
    expect(() => w.executors.bind(fakeTarget())).toThrow(/already bound/);
    expect(mgrSpy).toHaveBeenCalledTimes(1); // second bind rejected before rewiring
    await w.dispose();
  });

  it('dispose and drain are idempotent, before and after a session closes', async () => {
    const w = createWiredExecutors(base, { unattended: true, agent: true });
    await w.dispose();
    await w.dispose();
    await expect(w.executors.drain('close')).resolves.toEqual({ drained: 0, timedOut: false });
    const w2 = createWiredExecutors(base, { unattended: true, agent: true, skill: true, compose: true });
    const session = new AgentSession({ ...base, executors: w2.executors });
    await session.close();
    await w2.dispose();
    await w2.dispose();
  });

  it('end-to-end: session exposes agent/skill/compose and a skill tool call routes into SkillExecutor', async () => {
    const handler = vi.fn(async () => 'PROBE_SKILL_OUTPUT');
    registerSkill({ name: 'probe-cwe', description: 'probe', handler });
    createMock
      .mockImplementationOnce(() => fromArray(toolRound('tu_1', 'skill', { name: 'probe-cwe' })))
      .mockImplementationOnce(() => fromArray(textRound('done')));
    const cfg: AgentConfig = { ...base, hookRegistry: createHookRegistry() };
    const w = createWiredExecutors(cfg);
    const execSpy = vi.spyOn(w.executors.skillExecutor!, 'execute');
    const session = new AgentSession({ ...cfg, executors: w.executors });
    try {
      const msg = await session.sendMessage('run the probe skill');
      expect(msg.content).toContain('done');
      expect(requestTools(0)).toEqual(expect.arrayContaining(['agent', 'skill', 'compose']));
      expect(execSpy).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
      const second = JSON.stringify(createMock.mock.calls[1]?.[0]);
      expect(second).toContain('tu_1');
      expect(second).toContain('PROBE_SKILL_OUTPUT');
    } finally {
      await session.close();
    }
  });

  it('end-to-end: allowlisted bundle refuses a skill outside the list', async () => {
    const handler = vi.fn(async () => 'SHOULD_NOT_RUN');
    registerSkill({ name: 'probe-denied', description: 'probe', handler });
    createMock
      .mockImplementationOnce(() => fromArray(toolRound('tu_2', 'skill', { name: 'probe-denied' })))
      .mockImplementationOnce(() => fromArray(textRound('ok')));
    const w = createWiredExecutors(base, { unattended: true, skill: ['other'] });
    const session = new AgentSession({ ...base, executors: w.executors });
    try {
      await session.sendMessage('go');
      expect(requestTools(0)).toContain('skill');
      expect(requestTools(0)).not.toContain('agent');
      expect(handler).not.toHaveBeenCalled();
      expect(JSON.stringify(createMock.mock.calls[1]?.[0])).toContain('is not allowed in this session');
    } finally {
      await session.close();
    }
  });

  it('queryText with executors closes the session and drains the bundle', async () => {
    createMock.mockImplementationOnce(() => fromArray(textRound('answer')));
    const w = createWiredExecutors(base, { unattended: true, agent: true, compose: true });
    const drainSpy = vi.spyOn(w.executors, 'drain');
    const text = await queryText('hi', { ...base, executors: w.executors });
    expect(text).toContain('answer');
    expect(requestTools(0)).toEqual(expect.arrayContaining(['agent', 'compose']));
    expect(requestTools(0)).not.toContain('skill');
    expect(drainSpy).toHaveBeenCalledTimes(1);
    await w.dispose();
  });
});
