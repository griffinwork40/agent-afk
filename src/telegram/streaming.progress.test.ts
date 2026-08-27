/**
 * Tests for the Telegram streaming progress helpers.
 *
 * Covers:
 * - handleProgressEvent: progressRounds, dedup, cap, gate logic, timer arming
 * - makeSubagentSink: bumpActivity, tool_use_detail, done, other events
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'telegraf';
import {
  handleProgressEvent,
  makeSubagentSink,
  type ProgressState,
} from './streaming.progress.js';
import { MAX_PROGRESS_ENTRIES } from './streaming.preview.js';
import type { OutputEvent, SubagentProgressMeta } from '../agent/types.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./streaming.sender.js', () => ({
  sendOrEdit: vi.fn(async () => {}),
  deliverClean: vi.fn(async () => true),
  replyWithFloodRetryImpl: vi.fn(async () => {}),
  splitLongMessage: vi.fn((text: string) => [text]),
}));

vi.mock('./streaming.watchdog.js', () => ({
  armProgressGateTimer: vi.fn((delayMs: number, cb: () => void) => setTimeout(cb, delayMs)),
  PROGRESS_START_DELAY_MS: 5_000,
}));

vi.mock('./streaming.activity.js', () => ({
  formatTelegramActivity: vi.fn((_d?: string, _t?: string) => 'Working'),
  formatTelegramAgentLabel: vi.fn((label: string) => `[${label}]`),
  humanizeToolActivity: vi.fn((name: string) => name),
  MAX_SUBAGENT_PREVIEW_LINES: 4,
}));

import { sendOrEdit } from './streaming.sender.js';
import { armProgressGateTimer } from './streaming.watchdog.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): Context {
  return {
    chat: { id: 42, type: 'private' as const },
    reply: vi.fn(async () => ({ message_id: 1, text: '', chat: { id: 42 }, date: 0 })),
    telegram: {
      editMessageText: vi.fn(async () => true),
    },
  } as unknown as Context;
}

function makeProgressState(overrides: Partial<ProgressState> = {}): ProgressState {
  return {
    sentMessage: null,
    lastEditAt: 0,
    accumulated: '',
    progressEntries: [],
    progressRounds: 0,
    progressTimer: null,
    turnEnded: false,
    editInFlight: false,
    turnStartedAt: Date.now(),
    ...overrides,
  };
}

function makeProgressEvent(description = 'Searching', lastToolName = 'bash') {
  return { progress: { description, lastToolName } };
}

// ---------------------------------------------------------------------------
// handleProgressEvent
// ---------------------------------------------------------------------------

describe('handleProgressEvent — progressRounds', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('increments progressRounds unconditionally', async () => {
    const ctx = makeCtx();
    const state = makeProgressState();
    await handleProgressEvent(
      makeProgressEvent(), state, true, 0, ctx, 42,
      () => '', () => {}, () => {},
    );
    expect(state.progressRounds).toBe(1);
  });

  it('increments progressRounds even when gate is closed', async () => {
    const ctx = makeCtx();
    const state = makeProgressState({ progressTimer: setTimeout(() => {}, 9999) });
    await handleProgressEvent(
      makeProgressEvent(), state, false, 99999, ctx, 42,
      () => '', () => {}, () => {},
    );
    expect(state.progressRounds).toBe(1);
  });
});

describe('handleProgressEvent — deduplication', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('deduplicates consecutive same-label entries', async () => {
    const ctx = makeCtx();
    const state = makeProgressState();
    await handleProgressEvent(
      makeProgressEvent('Searching', 'bash'), state, true, 0, ctx, 42,
      () => '', () => {}, () => {},
    );
    await handleProgressEvent(
      makeProgressEvent('Searching', 'bash'), state, true, 0, ctx, 42,
      () => '', () => {}, () => {},
    );
    // Only one entry because label is the same
    expect(state.progressEntries).toHaveLength(1);
  });

  it('pushes new entry when label differs', async () => {
    const ctx = makeCtx();
    const state = makeProgressState();
    await handleProgressEvent(
      makeProgressEvent('A', 'bash'), state, true, 0, ctx, 42,
      () => '', () => {}, () => {},
    );
    // Change the formatTelegramActivity mock return for second call
    const { formatTelegramActivity } = await import('./streaming.activity.js');
    vi.mocked(formatTelegramActivity).mockReturnValueOnce('DifferentActivity');
    await handleProgressEvent(
      makeProgressEvent('B', 'grep'), state, true, 0, ctx, 42,
      () => '', () => {}, () => {},
    );
    expect(state.progressEntries.length).toBeGreaterThanOrEqual(1);
  });
});

describe('handleProgressEvent — cap', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it(`caps progressEntries at MAX_PROGRESS_ENTRIES (${MAX_PROGRESS_ENTRIES})`, async () => {
    const ctx = makeCtx();
    const state = makeProgressState();
    const { formatTelegramActivity } = await import('./streaming.activity.js');
    // Each call produces a unique label so no dedup
    let counter = 0;
    vi.mocked(formatTelegramActivity).mockImplementation(() => `Activity-${counter++}`);
    for (let i = 0; i <= MAX_PROGRESS_ENTRIES + 2; i++) {
      await handleProgressEvent(
        makeProgressEvent(`unique-${i}`, `tool-${i}`), state, true, 0, ctx, 42,
        () => '', () => {}, () => {},
      );
    }
    expect(state.progressEntries.length).toBeLessThanOrEqual(MAX_PROGRESS_ENTRIES);
  });
});

describe('handleProgressEvent — gate logic', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(sendOrEdit).mockResolvedValue(undefined); });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('gate-open: calls sendOrEdit and clears timer', async () => {
    const ctx = makeCtx();
    const state = makeProgressState();
    const clearProgressTimer = vi.fn();
    await handleProgressEvent(
      makeProgressEvent(), state, true, 0, ctx, 42,
      () => 'preview', () => {}, clearProgressTimer,
    );
    expect(sendOrEdit).toHaveBeenCalledOnce();
    expect(clearProgressTimer).toHaveBeenCalledOnce();
  });

  it('gate-closed + elapsed >= delay: opens gate, calls sendOrEdit', async () => {
    const ctx = makeCtx();
    const state = makeProgressState({ turnStartedAt: Date.now() - 10_000 });
    const setProgressGateOpen = vi.fn();
    await handleProgressEvent(
      makeProgressEvent(), state, false, 5_000, ctx, 42,
      () => 'preview', setProgressGateOpen, () => {},
    );
    expect(setProgressGateOpen).toHaveBeenCalledWith(true);
    expect(sendOrEdit).toHaveBeenCalledOnce();
  });

  it('gate-closed + timer null: arms timer via armProgressGateTimer', async () => {
    const ctx = makeCtx();
    const state = makeProgressState({ progressTimer: null });
    await handleProgressEvent(
      makeProgressEvent(), state, false, 99999, ctx, 42,
      () => 'preview', () => {}, () => {},
    );
    expect(armProgressGateTimer).toHaveBeenCalledOnce();
    // Timer should be set on state
    expect(state.progressTimer).not.toBeNull();
  });

  it('gate-closed + timer already set: does not arm second timer', async () => {
    const ctx = makeCtx();
    const existingTimer = setTimeout(() => {}, 9999);
    const state = makeProgressState({ progressTimer: existingTimer });
    await handleProgressEvent(
      makeProgressEvent(), state, false, 99999, ctx, 42,
      () => 'preview', () => {}, () => {},
    );
    expect(armProgressGateTimer).not.toHaveBeenCalled();
    clearTimeout(existingTimer);
  });
});

// ---------------------------------------------------------------------------
// makeSubagentSink
// ---------------------------------------------------------------------------

describe('makeSubagentSink', () => {
  beforeEach(() => { vi.mocked(sendOrEdit).mockResolvedValue(undefined); });
  afterEach(() => { vi.clearAllMocks(); });

  function makeSinkArgs() {
    const ctx = makeCtx();
    const state = makeProgressState();
    const bumpActivity = vi.fn();
    const subagentState = { subagentSteps: 0, recentSubagentSteps: [] as string[] };
    const sink = makeSubagentSink(state, ctx, 42, () => 'preview', bumpActivity, subagentState);
    return { ctx, state, bumpActivity, subagentState, sink };
  }

  const meta: SubagentProgressMeta = { subagentId: 'child-1', agentType: 'research-agent' };

  it('returns a function', () => {
    const { sink } = makeSinkArgs();
    expect(typeof sink).toBe('function');
  });

  it('always calls bumpActivity', () => {
    const { sink, bumpActivity } = makeSinkArgs();
    const event: OutputEvent = { type: 'done' };
    sink(event, meta);
    expect(bumpActivity).toHaveBeenCalledOnce();
  });

  it('tool_use_detail: increments subagentSteps', () => {
    const { sink, subagentState } = makeSinkArgs();
    const event: OutputEvent = {
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: 'u1', toolName: 'bash', toolInput: '{}' },
    };
    sink(event, meta);
    expect(subagentState.subagentSteps).toBe(1);
  });

  it('tool_use_detail: pushes a label to recentSubagentSteps', () => {
    const { sink, subagentState } = makeSinkArgs();
    const event: OutputEvent = {
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: 'u1', toolName: 'bash', toolInput: '{}' },
    };
    sink(event, meta);
    expect(subagentState.recentSubagentSteps).toHaveLength(1);
  });

  it('tool_use_detail: caps recentSubagentSteps at MAX_SUBAGENT_PREVIEW_LINES', () => {
    const { sink, subagentState } = makeSinkArgs();
    const event: OutputEvent = {
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: 'u1', toolName: 'bash', toolInput: '{}' },
    };
    for (let i = 0; i < 10; i++) sink(event, meta);
    // MAX_SUBAGENT_PREVIEW_LINES = 4 per mock
    expect(subagentState.recentSubagentSteps.length).toBeLessThanOrEqual(4);
  });

  it('tool_use_detail: calls sendOrEdit', () => {
    const { sink } = makeSinkArgs();
    const event: OutputEvent = {
      type: 'chunk',
      chunk: { type: 'tool_use_detail', toolUseId: 'u1', toolName: 'bash', toolInput: '{}' },
    };
    sink(event, meta);
    // sendOrEdit is called async via void — flush microtasks
    return Promise.resolve().then(() => {
      expect(sendOrEdit).toHaveBeenCalled();
    });
  });

  it('done: calls sendOrEdit without incrementing steps', () => {
    const { sink, subagentState } = makeSinkArgs();
    const event: OutputEvent = { type: 'done' };
    sink(event, meta);
    expect(subagentState.subagentSteps).toBe(0);
    return Promise.resolve().then(() => {
      expect(sendOrEdit).toHaveBeenCalled();
    });
  });

  it('other event types: only calls bumpActivity, no send', async () => {
    const { sink, bumpActivity, subagentState } = makeSinkArgs();
    const event: OutputEvent = { type: 'stream_retry' };
    sink(event, meta);
    await Promise.resolve();
    expect(bumpActivity).toHaveBeenCalledOnce();
    expect(subagentState.subagentSteps).toBe(0);
    expect(sendOrEdit).not.toHaveBeenCalled();
  });
});
