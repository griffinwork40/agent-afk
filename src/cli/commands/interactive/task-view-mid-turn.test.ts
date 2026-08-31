import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTaskViewHandler } from './task-view-mid-turn.js';
import type { TurnHandles } from './shared.js';

// ---------------------------------------------------------------------------
// createTaskViewHandler
// ---------------------------------------------------------------------------

describe('createTaskViewHandler', () => {
  it('returns null when getCompositor returns null (non-TTY)', () => {
    const h: Pick<TurnHandles, 'getCompositor' | 'setTaskViewHandler'> = {
      getCompositor: () => null,
      setTaskViewHandler: vi.fn(),
    };
    expect(createTaskViewHandler(h)).toBeNull();
  });

  it('returns null when getCompositor is undefined', () => {
    const h: Pick<TurnHandles, 'getCompositor' | 'setTaskViewHandler'> = {
      setTaskViewHandler: vi.fn(),
    };
    expect(createTaskViewHandler(h)).toBeNull();
  });

  it('returns a function when compositor is available', () => {
    const compositor = { stdout: process.stdout } as never;
    const h: Pick<TurnHandles, 'getCompositor' | 'setTaskViewHandler'> = {
      getCompositor: () => compositor,
      setTaskViewHandler: vi.fn(),
    };
    const handler = createTaskViewHandler(h);
    expect(handler).toBeTypeOf('function');
  });

  it('handler is a no-op when tasks manager is not wired', () => {
    const compositor = {
      stdout: process.stdout,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    } as never;
    const h: Pick<TurnHandles, 'getCompositor' | 'setTaskViewHandler'> = {
      getCompositor: () => compositor,
      setTaskViewHandler: vi.fn(),
    };
    const handler = createTaskViewHandler(h)!;
    // Should not throw when tasks manager is not registered.
    expect(() => handler()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tab dispatch integration (KeyDispatchHost.onTaskView)
// ---------------------------------------------------------------------------

describe('Tab dispatch integration', () => {
  let dispatchKey: typeof import('../../terminal-compositor.input-dispatch.js').dispatchKey;

  beforeEach(async () => {
    ({ dispatchKey } = await import('../../terminal-compositor.input-dispatch.js'));
  });

  it('fires onTaskView in streaming mode when Tab is pressed', () => {
    const onTaskView = vi.fn();
    const host = makeHost({ inputMode: 'streaming', onTaskView });
    dispatchKey(host, '\t', { name: 'tab', sequence: '\t' } as never);
    expect(onTaskView).toHaveBeenCalledOnce();
  });

  it('does not fire onTaskView in idle mode', () => {
    const onTaskView = vi.fn();
    const host = makeHost({ inputMode: 'idle', onTaskView });
    dispatchKey(host, '\t', { name: 'tab', sequence: '\t' } as never);
    expect(onTaskView).not.toHaveBeenCalled();
  });

  it('does not fire onTaskView when handler is not wired', () => {
    const host = makeHost({ inputMode: 'streaming' });
    // Should not throw — Tab falls through to ghost-accept.
    expect(() =>
      dispatchKey(host, '\t', { name: 'tab', sequence: '\t' } as never),
    ).not.toThrow();
  });

  it('dropdown takes priority over onTaskView in streaming mode', () => {
    const onTaskView = vi.fn();
    const host = makeHost({
      inputMode: 'streaming',
      onTaskView,
      applyDropdownSelection: () => true, // dropdown consumed Tab
    });
    dispatchKey(host, '\t', { name: 'tab', sequence: '\t' } as never);
    expect(onTaskView).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeHost(
  overrides: Partial<import('../../terminal-compositor.input-dispatch.js').KeyDispatchHost> & {
    inputMode?: string;
    onTaskView?: () => void;
  } = {},
): import('../../terminal-compositor.input-dispatch.js').KeyDispatchHost {
  return {
    armed: true,
    input: { buffer: '', cursor: 0 } as never,
    queued: false,
    pendingSubmissions: [],
    inputMode: (overrides.inputMode ?? 'idle') as never,
    pickerController: null,
    pasting: false,
    pasteStartBufferLen: 0,
    pasteStartCursor: 0,
    pasteRegistry: new Map(),
    clipboardInFlight: false,
    clipboardFailureMsg: null,
    attachments: [],
    softStopped: false,
    lastIdleEscAt: 0,
    postEscCoalesce: false,
    postEscPayload: null,
    canceled: false,
    backgrounded: false,
    paused: false,
    repaint: vi.fn(),
    scheduleRepaint: vi.fn(),
    clearScreen: vi.fn(),
    applyEdit: vi.fn(() => true),
    updateAutocomplete: vi.fn(),
    updateGhost: vi.fn(),
    dismissPromptGhost: vi.fn(() => false),
    applyDropdownSelection: overrides.applyDropdownSelection ?? vi.fn(() => false),
    applyGhostAccept: vi.fn(),
    ...overrides,
  } as never;
}
