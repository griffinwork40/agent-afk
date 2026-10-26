import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStats, recordTurn } from '../../cli/slash/session-stats.js';
import { HookBlockedError, AbortError } from '../../utils/errors.js';
import { FastModeController } from '../fast-mode.js';
import { setSlotBindings } from '../session/model-slots.js';
import {
  clearConversation, compactConversation, setSessionModel, setSessionName,
  getSessionThinking, setSessionThinking, readSessionFast, setSessionFast,
} from './index.js';
import type { AgentSession } from '../session.js';

const { persist } = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock('../../cli/session-store.js', () => ({ saveSession: persist }));

beforeEach(() => {
  persist.mockReset();
  setSlotBindings(undefined);
});

describe('clearConversation', () => {
  it('resets provider, stats and ledger in order, preserving user preferences', async () => {
    const stats = createSessionStats('sonnet');
    stats.permissionMode = 'autonomous';
    stats.thinkingUi = 'digest';
    stats.cwd = '/project';
    recordTurn(stats, 'old', 'answer', { sessionId: 'old-session', totalCostUsd: 2 });
    const oldCosts = stats.turnCosts;
    const oldTurns = stats.turns;
    const events: string[] = [];
    const session = { reset: vi.fn(async () => {
      expect(stats.totalTurns).toBe(1);
      events.push('reset');
    }) };
    await clearConversation(session, stats, { clear: () => {
      expect(stats.totalTurns).toBe(0);
      events.push('ledger');
    } });
    expect(events).toEqual(['reset', 'ledger']);
    expect(stats).toMatchObject({
      totalTurns: 0, totalTokens: 0, totalCostUsd: 0, unpricedTurns: 0,
      totalDurationMs: 0, model: 'sonnet', permissionMode: 'autonomous', thinkingUi: 'digest', cwd: '/project',
    });
    expect(stats.sessionId).toBeUndefined();
    expect(stats.name).toBeUndefined();
    expect(stats.turnCosts).toBe(oldCosts);
    expect(stats.turns).toBe(oldTurns);
    expect(stats.turns).toEqual([]);
  });

  it('works without ledger, and does not mutate metadata when reset fails', async () => {
    const stats = createSessionStats('sonnet');
    await clearConversation({ reset: vi.fn().mockResolvedValue(undefined) }, stats);
    stats.name = 'keep';
    stats.totalTurns = 7;
    const clear = vi.fn();
    await expect(clearConversation({ reset: vi.fn().mockRejectedValue(new Error('busy')) }, stats, { clear })).rejects.toThrow('busy');
    expect(stats).toMatchObject({ name: 'keep', totalTurns: 7 });
    expect(clear).not.toHaveBeenCalled();
  });
});

function compactSession() {
  return {
    sessionId: 'session',
    hookRegistry: { dispatch: vi.fn().mockResolvedValue(undefined) },
    compact: vi.fn().mockResolvedValue({ compacted: true, messagesBefore: 20, messagesAfter: 3, tokensSavedEstimate: 42 }),
    listRewindTargets: vi.fn().mockReturnValueOnce([{}, {}, {}]).mockReturnValue([{}]),
  };
}

describe('compactConversation', () => {
  it('runs PreCompact before progress, snapshots prompts, preserves provider fields', async () => {
    const session = compactSession();
    const progress = vi.fn((phase: string) => {
      expect(session.hookRegistry.dispatch).toHaveBeenCalledWith({ event: 'PreCompact', sessionId: 'session', trigger: 'manual' });
      if (phase === 'start') expect(session.compact).not.toHaveBeenCalled();
    });
    const result = await compactConversation(session as unknown as AgentSession, progress);
    expect(result).toEqual({ compacted: true, messagesBefore: 20, messagesAfter: 3, tokensSavedEstimate: 42, promptsBefore: 3, promptsAfter: 1 });
    expect(progress.mock.calls.map(([phase]) => phase)).toEqual(['start', 'end']);
  });

  it('does no work or progress when a hook blocks', async () => {
    const session = compactSession();
    const error = new HookBlockedError('blocked', 'PreCompact', 'policy');
    session.hookRegistry.dispatch.mockRejectedValue(error);
    const progress = vi.fn();
    await expect(compactConversation(session as unknown as AgentSession, progress)).rejects.toBe(error);
    expect(session.compact).not.toHaveBeenCalled();
    expect(session.listRewindTargets).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  it.each(['session-busy', 'not-supported', 'aborted', 'microcompacted'])('preserves %s no-op; busy handling belongs to caller', async (reason) => {
    const session = compactSession();
    session.compact.mockResolvedValue({ compacted: false, reason, messagesBefore: 0, messagesAfter: 0 });
    const result = await compactConversation(session as unknown as AgentSession);
    expect(result).toMatchObject({ compacted: false, reason, promptsBefore: 3, promptsAfter: 1 });
  });

  it('closes progress and propagates abort/error, without sampling an after state', async () => {
    const session = compactSession();
    const error = new AbortError('cancel');
    session.compact.mockRejectedValue(error);
    const progress = vi.fn();
    await expect(compactConversation(session as unknown as AgentSession, progress)).rejects.toBe(error);
    expect(progress.mock.calls).toEqual([['start'], ['end']]);
    expect(session.listRewindTargets).toHaveBeenCalledTimes(1);
  });

  it('supports sessions without hooks', async () => {
    const { hookRegistry: _hooks, ...session } = compactSession();
    await expect(compactConversation(session as unknown as AgentSession)).resolves.toMatchObject({ compacted: true });
  });
});

describe('setSessionModel', () => {
  it('validates typos and unconfigured tiers without touching state', async () => {
    const stats = createSessionStats('sonnet');
    const setModel = vi.fn();
    expect(await setSessionModel({ setModel }, stats, 'sonnnet')).toMatchObject({ ok: false, message: expect.stringContaining('Unknown model') });
    setSlotBindings({ local: { id: '' }, small: { id: 'haiku' }, medium: { id: 'sonnet' }, large: { id: 'opus' }, subagent: { id: '' } });
    expect(await setSessionModel({ setModel }, stats, 'local')).toMatchObject({ ok: false });
    expect(setModel).not.toHaveBeenCalled();
    expect(stats.model).toBe('sonnet');
  });

  it('normalizes known aliases case-insensitively', async () => {
    const stats = createSessionStats('sonnet');
    const setModel = vi.fn().mockResolvedValue(undefined);
    expect(await setSessionModel({ setModel }, stats, ' HAIKU ')).toEqual({ ok: true, model: 'haiku' });
    expect(setModel).toHaveBeenCalledWith('haiku');
  });

  it('updates stats after provider success and preserves legacy full-ID lowercasing', async () => {
    const stats = createSessionStats('sonnet');
    const setModel = vi.fn(async () => { expect(stats.model).toBe('sonnet'); });
    expect(await setSessionModel({ setModel }, stats, '  org/Qwen-Model  ')).toEqual({ ok: true, model: 'org/qwen-model' });
    expect(setModel).toHaveBeenCalledWith('org/qwen-model');
    expect(stats.model).toBe('org/qwen-model');
    await expect(setSessionModel({ setModel: vi.fn().mockRejectedValue(new Error('offline')) }, stats, 'haiku')).rejects.toThrow('offline');
    expect(stats.model).toBe('org/qwen-model');
  });
});

describe('setSessionName', () => {
  it('rejects invalid names without notifications or mutation', () => {
    const stats = createSessionStats('sonnet');
    stats.name = 'keep';
    const onName = vi.fn();
    expect(setSessionName(stats, '!!!', { onName })).toEqual({ ok: false });
    expect(stats.name).toBe('keep');
    expect(onName).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('slugifies and notifies; saves only after first turn via canonical store', () => {
    const stats = createSessionStats('sonnet');
    const onName = vi.fn();
    expect(setSessionName(stats, 'My Name', { onName })).toEqual({ ok: true, name: 'name', saved: false });
    expect(onName).toHaveBeenCalledWith('name');
    expect(stats.nameExplicit).toBe(true); // /name is shown verbatim by surfaces
    expect(persist).not.toHaveBeenCalled();
    stats.totalTurns = 1;
    expect(setSessionName(stats, 'new')).toEqual({ ok: true, name: 'new', saved: true });
    expect(persist).toHaveBeenCalledWith(stats);
  });

  it('returns a save failure without undoing successful in-memory rename', () => {
    const stats = createSessionStats('sonnet');
    stats.totalTurns = 1;
    const error = new Error('disk');
    const result = setSessionName(stats, 'renamed', { persist: () => { throw error; } });
    expect(result).toEqual({ ok: true, name: 'renamed', saved: false, saveError: error });
    expect(stats.name).toBe('renamed');
  });
});

describe('thinking and fast preferences', () => {
  it('defaults thinking to live; accepts all modes, rejects invalid without mutation', () => {
    const stats = createSessionStats('sonnet');
    delete stats.thinkingUi;
    expect(getSessionThinking(stats)).toBe('live');
    for (const mode of ['summary', 'live', 'digest', 'off'] as const) {
      expect(setSessionThinking(stats, ` ${mode.toUpperCase()} `)).toEqual({ ok: true, mode });
      expect(getSessionThinking(stats)).toBe(mode);
    }
    expect(setSessionThinking(stats, 'invalid')).toEqual({ ok: false });
    expect(getSessionThinking(stats)).toBe('off');
  });

  it('mutates the shared fast controller, while status reports actual eligibility', () => {
    const controller = new FastModeController();
    const context = { resolvedModelId: 'claude-opus-5', providerFamily: 'anthropic-direct', hasCustomEndpoint: false, executionPath: 'top-level' as const };
    expect(readSessionFast(controller, context)).toMatchObject({ preference: 'off', effective: false });
    expect(setSessionFast(controller, ' ON ')).toEqual({ ok: true, preference: 'on' });
    expect(readSessionFast(controller, context)).toEqual({ preference: 'on', effective: true });
    expect(readSessionFast(controller, { ...context, hasCustomEndpoint: true })).toMatchObject({ effective: false, reason: 'custom-endpoint' });
    expect(setSessionFast(controller, 'maybe')).toEqual({ ok: false });
    expect(controller.getPreference()).toBe('on');
    expect(setSessionFast(controller, 'off')).toEqual({ ok: true, preference: 'off' });
  });
});
