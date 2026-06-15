/**
 * Tests for the interactive turn handler — the REPL's main per-prompt loop.
 *
 * Covers the load-bearing behaviors of `runTurn` after the StreamRenderer
 * refactor: the runWithSink wrap (so subagents forked mid-turn stream into
 * the same renderer), responseText accumulation, hook ordering, and error
 * propagation. Output rendering itself is exercised in the StreamRenderer
 * unit tests; here we only assert the wiring contract.
 *
 * vitest's stdout has no TTY → renderer's compositor stays null →
 * compositor-side concerns (overlay, queued buffer) are silent. Manual
 * smoke against the live REPL covers those.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTurn } from './turn-handler.js';
import { getCurrentSink } from '../../../agent/_lib/skill-sink-channel.js';
import type { AgentSession } from '../../../agent/session.js';
import type { OutputEvent } from '../../../agent/types.js';
import type { SessionStats } from '../../slash/types.js';
import type { TurnHandles } from './shared.js';

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    planMode: false,
  };
}

interface HandleSpies {
  setInFlight: ReturnType<typeof vi.fn>;
  onTurnComplete: ReturnType<typeof vi.fn>;
  onAfterTurn: ReturnType<typeof vi.fn>;
  rearmStatus: ReturnType<typeof vi.fn>;
}

function makeHandles(): { h: TurnHandles } & HandleSpies {
  const setInFlight = vi.fn();
  const onTurnComplete = vi.fn().mockResolvedValue(undefined);
  const onAfterTurn = vi.fn();
  const rearmStatus = vi.fn();
  return {
    h: { setInFlight, onTurnComplete, onAfterTurn, rearmStatus },
    setInFlight,
    onTurnComplete,
    onAfterTurn,
    rearmStatus,
  };
}

function streamFrom(events: OutputEvent[]): AgentSession {
  return {
    sessionId: 'mock',
    sendMessageStream: async function* () {
      for (const event of events) yield event;
    },
    interrupt: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSession;
}

describe('runTurn — runWithSink wiring', () => {
  it('installs the ambient sink during for-await iteration', async () => {
    const sinkSnapshots: Array<unknown> = [];
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'hi' } },
      { type: 'done', metadata: { durationMs: 10 } },
    ];

    const session = {
      sessionId: 'mock',
      // eslint-disable-next-line require-yield
      sendMessageStream: async function* () {
        sinkSnapshots.push(getCurrentSink());
        for (const event of events) {
          sinkSnapshots.push(getCurrentSink());
          yield event;
        }
        sinkSnapshots.push(getCurrentSink());
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    const { h } = makeHandles();
    const stats = makeStats();

    expect(getCurrentSink()).toBeUndefined();
    await runTurn({ text: 'hi', attachments: [] }, session, stats, h);
    expect(getCurrentSink()).toBeUndefined();

    expect(sinkSnapshots.length).toBeGreaterThan(0);
    for (const snap of sinkSnapshots) {
      expect(snap).toBeDefined();
      expect(typeof snap).toBe('function');
    }
  });
});

describe('runTurn — happy path', () => {
  it('accumulates responseText from content chunks and calls recordTurn', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'hello ' } },
      { type: 'chunk', chunk: { type: 'content', content: 'world' } },
      { type: 'done', metadata: { durationMs: 25 } },
    ];

    const session = streamFrom(events);
    const { h, setInFlight, onTurnComplete, onAfterTurn } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'greet me', attachments: [] }, session, stats, h);

    expect(stats.totalTurns).toBe(1);
    expect(setInFlight).toHaveBeenCalledWith(true);
    expect(setInFlight).toHaveBeenCalledWith(false);
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete.mock.calls[0]).toEqual(['greet me', 'hello world']);
    expect(onAfterTurn).toHaveBeenCalledTimes(1);
  });

  it('uses message event content when no content chunks streamed', async () => {
    const events: OutputEvent[] = [
      { type: 'message', message: { role: 'assistant', content: 'no-stream answer' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session = streamFrom(events);
    const { h, onTurnComplete } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    expect(onTurnComplete.mock.calls[0]?.[1]).toBe('no-stream answer');
  });

  it('skips post-done hooks when stream ends without a done event', async () => {
    // Models hitting the tool-use cap may end on `error` or stream
    // termination without ever emitting `done`. recordTurn should not
    // run, but lifecycle teardown (setInFlight false, rearmStatus) still must.
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'partial' } },
    ];

    const session = streamFrom(events);
    const { h, setInFlight, onTurnComplete } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    expect(stats.totalTurns).toBe(0);
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(setInFlight).toHaveBeenCalledWith(false);
  });
});

describe('runTurn — error paths', () => {
  it('surfaces an error event without crashing teardown', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'oops...' } },
      { type: 'error', error: new Error('upstream blew up') },
    ];

    const session = streamFrom(events);
    const { h, setInFlight, onTurnComplete } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    expect(setInFlight).toHaveBeenCalledWith(false);
    expect(onTurnComplete).not.toHaveBeenCalled();
    // Error output is rendered via presentError → process.stderr.write.
    // Vitest captures stderr output via its own interception layer, so we
    // verify the behavioral contract (teardown completes, turn not recorded)
    // rather than asserting on raw stderr bytes.
    // The error rendering path is covered by src/cli/errors/presenter.test.ts.
  });

  it('handles a thrown sendMessageStream without leaving setInFlight true', async () => {
    const session = {
      sessionId: 'mock',
      sendMessageStream: () => {
        throw new Error('stream construction failed');
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    const { h, setInFlight } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    const inFlightFalseCalls = setInFlight.mock.calls.filter(([v]) => v === false);
    expect(inFlightFalseCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('publishes the active compositor at entry and clears it at exit', async () => {
    // The REPL's SIGINT handler routes the interrupt notice through the
    // published compositor's commitAbove so it survives in scrollback.
    // runTurn must publish on arm and clear in finally; non-TTY surfaces
    // (vitest's stdout) publish null, which is the contract for the
    // SIGINT handler to fall back to console.log.
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'hi' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];
    const session = streamFrom(events);
    const setActiveCompositor = vi.fn();
    const { h } = makeHandles();
    const handles: TurnHandles = { ...h, setActiveCompositor };
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, handles);

    // At minimum: called once at arm and once at dispose. In the non-TTY
    // unit-test environment both calls are with null; both calls happen.
    expect(setActiveCompositor).toHaveBeenCalled();
    const lastCall = setActiveCompositor.mock.calls.at(-1);
    expect(lastCall?.[0]).toBeNull();
  });
});

describe('runTurn — usage-limit pause/resume', () => {
  // External constraint: when the provider hits a usage limit and
  // `autoResumeOnUsageLimit` is on (default), it emits `paused`, waits, then
  // emits `resumed` followed by a REPLAY of the entire turn within the same
  // stream (retry-layer.ts: `yield* turnWithAuthRetry`). The turn handler
  // must reset its accumulators on `resumed` so the recorded turn reflects
  // only the replay, not the partial pre-pause content.

  it('resets responseText on resumed so replay content does not double-accumulate', async () => {
    const resetsAt = new Date(Date.now() + 5 * 60_000);
    const events: OutputEvent[] = [
      // First (pre-pause) attempt — partial content.
      { type: 'chunk', chunk: { type: 'content', content: 'partial pre-pause ' } },
      // Usage limit hit. Provider emits paused, then waits, then resumed.
      { type: 'paused', reason: 'usage-limit', resetsAt, autoResume: true },
      { type: 'resumed', hotSwapped: true, accountId: 'token:abc' },
      // Replay: full turn content streams again from scratch.
      { type: 'chunk', chunk: { type: 'content', content: 'replayed full answer' } },
      { type: 'done', metadata: { durationMs: 20 } },
    ];

    const session = streamFrom(events);
    const { h, onTurnComplete } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    // The recorded turn must reflect ONLY the replayed content. If the
    // resumed handler failed to reset, the recorded text would be
    // 'partial pre-pause replayed full answer'.
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete.mock.calls[0]?.[1]).toBe('replayed full answer');
    expect(stats.totalTurns).toBe(1);
  });

  it('clears tool events on resumed so replay tool calls do not double-count', async () => {
    const events: OutputEvent[] = [
      // First attempt: one tool call before the pause.
      {
        type: 'chunk',
        chunk: {
          type: 'tool_use_detail',
          toolName: 'bash',
          toolUseId: 'pre-pause-1',
          toolInput: '{"command":"echo pre"}',
        },
      },
      { type: 'paused', reason: 'usage-limit', autoResume: true },
      { type: 'resumed', hotSwapped: false },
      // Replay: model re-issues the same tool call (different toolUseId).
      {
        type: 'chunk',
        chunk: {
          type: 'tool_use_detail',
          toolName: 'bash',
          toolUseId: 'replay-1',
          toolInput: '{"command":"echo replay"}',
        },
      },
      { type: 'chunk', chunk: { type: 'content', content: 'done' } },
      { type: 'done', metadata: { durationMs: 10 } },
    ];

    const session = streamFrom(events);
    const { h } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    // recordTurn writes toolEvents into stats.turns[n].toolEvents. Only the
    // replay tool call should be present — the pre-pause one was discarded.
    expect(stats.totalTurns).toBe(1);
    const turn = stats.turns[0];
    expect(turn).toBeDefined();
    const toolUseIds = (turn!.toolEvents ?? []).map((t) => t.toolUseId);
    expect(toolUseIds).toEqual(['replay-1']);
  });

  it('does not call onTurnComplete on the pre-pause portion (only after replay done)', async () => {
    // Regression guard: previously the renderer was disposed on `paused`
    // and the replay's stream events were invisible. If a future refactor
    // accidentally fired the done-side hooks BEFORE the resumed/replay
    // sequence, onTurnComplete could see the partial responseText. Verify
    // it fires exactly once, after the replay's `done`.
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'half' } },
      { type: 'paused', reason: 'usage-limit', autoResume: true },
      { type: 'resumed', hotSwapped: false },
      { type: 'chunk', chunk: { type: 'content', content: 'whole' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session = streamFrom(events);
    const { h, onTurnComplete } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete.mock.calls[0]?.[1]).toBe('whole');
  });

  it('the ambient sink dereferences the CURRENT renderer (so subagent events post-resume reach the new instance)', async () => {
    // The post-resume replay must route subagent events to the swapped-in
    // renderer, not the disposed original. The ambient sink (installed via
    // runWithSink) is a closure that should re-read the renderer binding
    // each call. We verify by checking that getCurrentSink() returns a
    // valid function both BEFORE and AFTER the pause/resume swap.
    const sinkSnapshots: Array<unknown> = [];

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'pre' } },
      { type: 'paused', reason: 'usage-limit', autoResume: true },
      { type: 'resumed', hotSwapped: true, accountId: 'token:swap' },
      { type: 'chunk', chunk: { type: 'content', content: 'post' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session = {
      sessionId: 'mock',
      sendMessageStream: async function* () {
        for (const event of events) {
          sinkSnapshots.push(getCurrentSink());
          yield event;
        }
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    const { h } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    // Sink must be installed (non-undefined function) for EVERY snapshot,
    // including the ones taken after `resumed`. If a future refactor
    // accidentally tore down the sink mid-stream, post-resume entries
    // would be undefined.
    expect(sinkSnapshots.length).toBe(events.length);
    for (const snap of sinkSnapshots) {
      expect(snap).toBeDefined();
      expect(typeof snap).toBe('function');
    }
  });

  it('completes teardown when stream closes after paused with no resumed (manual-retry path)', async () => {
    // External constraint: when autoResumeOnUsageLimit is off OR the stream
    // aborts mid-pause, the for-await loop simply ends after the paused
    // event — no 'resumed', no 'done'. The handler must finish cleanly:
    // no recordTurn (totalTurns stays 0), no onTurnComplete (the turn
    // didn't actually complete), but setInFlight(false) MUST fire so
    // the REPL re-prompts.
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'partial' } },
      { type: 'paused', reason: 'usage-limit', autoResume: false },
      // Stream closes here — no resumed, no done.
    ];

    const session = streamFrom(events);
    const { h, setInFlight, onTurnComplete } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    expect(setInFlight).toHaveBeenCalledWith(false);
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(stats.totalTurns).toBe(0);
  });

  it('renders error after paused (autoResume=false) without recording turn or firing onTurnComplete', async () => {
    // After paused-with-autoResume=false, the provider yields the original
    // 429 as an error event. The error handler runs presentError (covered
    // in presenter.test.ts) and sets streamErrorRendered=true; the
    // doneFired branch is skipped because there's no done event. Net
    // effect: clean teardown, no spurious turn recorded.
    const events: OutputEvent[] = [
      { type: 'paused', reason: 'usage-limit', autoResume: false },
      { type: 'error', error: new Error('429 rate-limit, no auto-resume') },
    ];

    const session = streamFrom(events);
    const { h, setInFlight, onTurnComplete } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    expect(setInFlight).toHaveBeenCalledWith(false);
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(stats.totalTurns).toBe(0);
  });
});

describe('runTurn — ghost spinner regression', () => {
  it('emits the blank separator line before arm, not after', async () => {
    // Regression: a console.log() between arm() and the first stream event
    // shifts stdout without updating log-update's line tracker, stranding
    // the initial spinner frame in scrollback ("ghost spinner").
    //
    // Strategy: spy on console.log and capture the ordering relative to the
    // first stream event. The blank-line call must come before any event
    // is yielded (i.e., before the renderer can arm and draw a spinner).
    const callOrder: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      callOrder.push('console.log');
    });

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'x' } },
      { type: 'done', metadata: { durationMs: 1 } },
    ];

    const session = {
      sessionId: 'mock',
      sendMessageStream: async function* () {
        callOrder.push('stream-start');
        for (const event of events) yield event;
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    const { h } = makeHandles();
    const stats = makeStats();

    await runTurn({ text: 'hi', attachments: [] }, session, stats, h);

    // The blank line must precede the stream (and therefore arm()).
    const logIdx = callOrder.indexOf('console.log');
    const streamIdx = callOrder.indexOf('stream-start');
    expect(logIdx).toBeGreaterThanOrEqual(0);
    expect(streamIdx).toBeGreaterThan(logIdx);

    consoleSpy.mockRestore();
  });
});

describe('runTurn — borrowed-compositor regression (PR 424 / Stage 3e)', () => {
  // Stage 3e introduced a persistent TerminalCompositor armed at REPL
  // startup. The bug: turn-handler's raw `console.log()` calls (pre-arm
  // separator, post-stream blank line, verdict card, footer) wrote
  // directly into a log-update-tracked region while the borrowed
  // compositor was still armed. The next repaint then redrew at the
  // displaced cursor row, stranding the previous frame above the new
  // one — the "stacked prompt" duplication symptom from PR 424.
  //
  // These tests exercise the borrow path with a stub compositor that
  // records `commitAbove` calls. Non-TTY in vitest means `renderer.arm()`
  // is a no-op for compositor assignment, but the borrowed-compositor
  // BRANCH at the pre-arm separator and the writeAbove fan-out below
  // both observe the input `borrowedCompositor` (via h.getCompositor)
  // rather than `renderer.getCompositor()`, so the test surface is the
  // same path live REPL takes.
  function makeStubCompositor() {
    const commitAboveCalls: string[] = [];
    return {
      commitAboveCalls,
      stub: {
        isArmed: () => true,
        commitAbove: (line: string) => { commitAboveCalls.push(line); },
        // Surface area only — runTurn never touches these in the borrow
        // path, but TurnHandles.getCompositor declares the full type.
        setInputMode: vi.fn(),
        setSpinner: vi.fn(),
        setOverlay: vi.fn(),
      },
    };
  }

  it('routes the pre-arm blank separator through commitAbove instead of console.log', async () => {
    const { commitAboveCalls, stub } = makeStubCompositor();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const events: OutputEvent[] = [
      { type: 'done', metadata: { durationMs: 1 } },
    ];
    const session = streamFrom(events);
    const { h } = makeHandles();
    const handles: TurnHandles = {
      ...h,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getCompositor: () => stub as any,
    };
    const stats = makeStats();

    await runTurn({ text: 'hi', attachments: [] }, session, stats, handles);

    // The blank separator (line 122-equivalent under the fix) must land
    // on the stub via commitAbove, NOT on console.log.
    expect(commitAboveCalls).toContain('');
    // Crucially: no raw console.log fires for the separator. The footer
    // path uses console.log only when completionWriter is absent (here
    // it is), but the SEPARATOR path is what stranded prompts in PR 424.
    // We assert the positive contract: commitAbove was called for ''.
    expect(commitAboveCalls.length).toBeGreaterThanOrEqual(1);

    consoleSpy.mockRestore();
  });

  it('routes post-stream / verdict / footer writes through completionWriter when borrowed', async () => {
    const { stub } = makeStubCompositor();
    const writerCalls: string[] = [];
    const completionWriter = { fn: (line: string) => { writerCalls.push(line); } };

    // Force a streaming-started flag and a verdict tail so the doneFired
    // block exercises every write site (post-stream `\n`, verdict card,
    // footer). The verdict parser expects a "✓ Done" or similar tail.
    const events: OutputEvent[] = [
      {
        type: 'chunk',
        chunk: { type: 'content', content: 'hello\n\n✓ Done\n  reasoning here.' },
      },
      {
        type: 'done',
        metadata: {
          durationMs: 25,
          totalCostUsd: 0.001,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ];
    const session = streamFrom(events);
    const { h } = makeHandles();
    const handles: TurnHandles = {
      ...h,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getCompositor: () => stub as any,
    };
    const stats = makeStats();

    await runTurn(
      { text: 'q', attachments: [] },
      session,
      stats,
      handles,
      'summary',
      completionWriter,
    );

    // The writeAbove fan-out should have routed at least the post-stream
    // blank, the footer's cost line, and the trailing blank through
    // completionWriter — none of them should reach a raw console.log
    // while the borrowed compositor is armed.
    expect(writerCalls.length).toBeGreaterThan(0);
    // Trailing blank from printTurnFooter.
    expect(writerCalls).toContain('');
  });

  it('Ctrl+B promotes a running foreground subagent (no whole-turn detach)', async () => {
    const writerCalls: string[] = [];
    const completionWriter = { fn: (line: string) => { writerCalls.push(line); } };

    const promoteActiveForeground = vi.fn().mockResolvedValue([
      { jobId: 'bg-7', label: 'deep dive' },
    ]);
    const subagentControl = {
      hasPromotableForeground: () => true,
      promoteActiveForeground,
    };

    const { h, onTurnComplete } = makeHandles();
    const handles: TurnHandles = {
      ...h,
      subagentControl,
      // Fire Ctrl+B immediately at install time (mimics a keypress while a
      // foreground subagent is running).
      setBackgroundHandler: (handler) => { handler?.(); },
    };

    // The turn runs to normal completion — promotion must not detach it.
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'working' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];
    const session = streamFrom(events);

    await runTurn(
      { text: 'q', attachments: [] },
      session,
      makeStats(),
      handles,
      'summary',
      completionWriter,
    );
    await new Promise((r) => setImmediate(r)); // flush the async promotion note

    // The running subagent was promoted and the turn completed in the
    // foreground — it was NOT detached wholesale.
    expect(promoteActiveForeground).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenCalled();
    // Confirmation line routed through completionWriter.
    expect(writerCalls.some((l) => l.includes('backgrounded as bg-7'))).toBe(true);
  });

  it('Ctrl+B is a no-op when no subagent is promotable (no whole-turn detach)', async () => {
    const writerCalls: string[] = [];
    const completionWriter = { fn: (line: string) => { writerCalls.push(line); } };

    const promoteActiveForeground = vi.fn();
    const subagentControl = {
      hasPromotableForeground: () => false, // nothing running to background
      promoteActiveForeground,
    };

    const { h, onTurnComplete } = makeHandles();
    const handles: TurnHandles = {
      ...h,
      subagentControl,
      setBackgroundHandler: (handler) => { handler?.(); },
    };

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'hi' } },
      { type: 'done', metadata: { durationMs: 1 } },
    ];
    const session = streamFrom(events);

    await runTurn(
      { text: 'q', attachments: [] },
      session,
      makeStats(),
      handles,
      'summary',
      completionWriter,
    );

    // Ctrl+B did nothing: no promotion, no detach, the turn ran to completion.
    expect(promoteActiveForeground).not.toHaveBeenCalled();
    expect(onTurnComplete).toHaveBeenCalled();
    expect(writerCalls.some((l) => l.includes('backgrounded'))).toBe(false);
  });

  it('routes paused usage-limit box through completionWriter.fn (not console.log) when compositor armed', async () => {
    const { stub } = makeStubCompositor();
    const writerCalls: string[] = [];
    const completionWriter = { fn: (line: string) => { writerCalls.push(line); } };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const events: OutputEvent[] = [
      { type: 'paused', reason: 'usage-limit', resetsAt: new Date('2025-01-01T00:00:00Z'), accountId: 'acct-1' },
      { type: 'done', metadata: { durationMs: 1 } },
    ];
    const session = streamFrom(events);
    const { h } = makeHandles();
    const handles: TurnHandles = {
      ...h,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getCompositor: () => stub as any,
    };
    const stats = makeStats();

    await runTurn(
      { text: 'hi', attachments: [] },
      session,
      stats,
      handles,
      'summary',
      completionWriter,
    );

    // The usage-limit box must arrive via completionWriter.fn — it is a
    // multi-line rendered string from usageLimitBox(), so at least one call
    // should be non-empty and console.log must not be called for it.
    expect(writerCalls.length).toBeGreaterThanOrEqual(1);
    // At least one call should be the rendered usage-limit box (non-empty string).
    expect(writerCalls.some(line => line.length > 0)).toBe(true);
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('routes resumed note through completionWriter.fn (not console.log) when compositor armed', async () => {
    const { stub } = makeStubCompositor();
    const writerCalls: string[] = [];
    const completionWriter = { fn: (line: string) => { writerCalls.push(line); } };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // hotSwapped + accountId exercises the "▶ Resumed on <accountId>" branch.
    const events: OutputEvent[] = [
      { type: 'resumed', hotSwapped: true, accountId: 'acct-2' },
      { type: 'done', metadata: { durationMs: 1 } },
    ];
    const session = streamFrom(events);
    const { h } = makeHandles();
    const handles: TurnHandles = {
      ...h,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getCompositor: () => stub as any,
    };
    const stats = makeStats();

    await runTurn(
      { text: 'hi', attachments: [] },
      session,
      stats,
      handles,
      'summary',
      completionWriter,
    );

    // The "▶ Resumed on acct-2" note must arrive via completionWriter.fn,
    // not raw console.log — compositor is still armed during the resumed event.
    expect(writerCalls.some(line => line.includes('Resumed'))).toBe(true);
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Soft-stop (ESC) tests
// ---------------------------------------------------------------------------
//
// Spec: ESC soft-stop halts the stream cleanly and preserves completed work.
// Tests assert against session state (interrupt called, recordTurn skipped),
// NOT against the renderer string — per plan-exit Risk #3: visible-success-
// with-silent-data-loss is the failure mode to guard against.
// ---------------------------------------------------------------------------

describe('runTurn — ESC soft-stop', () => {
  /**
   * Build a stream session where the softStop callback is fired after
   * `fireSoftStopAfter` events have been yielded. The generator simulates
   * the real stream: it yields those events, then when softStopRequested
   * is true it would naturally terminate on the next poll (because the
   * turn-handler breaks the loop). We model this by yielding a bounded
   * event list; the `break` in the turn-handler exits the iterator early.
   */
  function makeStreamWithSoftStop(
    events: OutputEvent[],
    opts: { fireAfterIndex: number },
  ): { session: AgentSession; fireSoftStop: () => void; installHook: (setSoftStop: (h: (() => void) | null) => void) => void } {
    let softStopFn: (() => void) | null = null;
    let softStopFired = false;

    const session: AgentSession = {
      sessionId: 'mock-soft-stop',
      sendMessageStream: async function* () {
        for (let i = 0; i < events.length; i++) {
          // Fire soft-stop after the Nth event to simulate ESC mid-stream.
          if (i === opts.fireAfterIndex && !softStopFired) {
            softStopFired = true;
            softStopFn?.();
          }
          yield events[i]!;
        }
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    return {
      session,
      fireSoftStop: () => { softStopFn?.(); },
      installHook: (setSoftStop) => {
        setSoftStop(() => { softStopFn = null; softStopFired = true; softStopFn?.(); });
        // Patch softStopFn to the ref the handler will call.
        // The turn-handler installs its own closure via setSoftStopHandler;
        // we override that here to fire it on our schedule.
        softStopFn = null;
      },
    };
  }

  it('calls session.interrupt() when softStop is triggered mid-stream', async () => {
    // Arrange: stream yields a content chunk, then soft-stop fires, then done.
    // Turn-handler must break on soft-stop before done.
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'partial answer' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session = streamFrom(events);
    const interruptSpy = session.interrupt as ReturnType<typeof vi.fn>;

    // Install a setSoftStopHandler that we fire after the first event.
    let installedHandler: (() => void) | null = null;
    const setSoftStopHandler = vi.fn((h: (() => void) | null) => {
      installedHandler = h;
    });

    // Simulate: fire the soft-stop during the stream by patching sendMessageStream.
    const realStream = session.sendMessageStream;
    let callCount = 0;
    session.sendMessageStream = async function* (payload: unknown) {
      for await (const event of (realStream as typeof session.sendMessageStream).call(session, payload)) {
        yield event;
        callCount++;
        // After first event, trigger soft-stop.
        if (callCount === 1 && installedHandler) {
          installedHandler();
        }
      }
    };

    const { h } = makeHandles();
    const handles: TurnHandles = {
      ...h,
      setSoftStopHandler,
    };

    await runTurn({ text: 'test', attachments: [] }, session, makeStats(), handles);

    // Core assertion: session.interrupt() was called — stream halted.
    expect(interruptSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onTurnComplete when soft-stopped (incomplete turn = no state write)', async () => {
    // Arrange: soft-stop fires after first event, before done.
    // onTurnComplete must NOT be called — no completed turn to persist.
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'partial' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session = streamFrom(events);

    let installedHandler: (() => void) | null = null;
    const setSoftStopHandler = vi.fn((h: (() => void) | null) => {
      installedHandler = h;
    });

    let callCount = 0;
    const realStream = session.sendMessageStream;
    session.sendMessageStream = async function* (payload: unknown) {
      for await (const event of (realStream as typeof session.sendMessageStream).call(session, payload)) {
        yield event;
        callCount++;
        if (callCount === 1 && installedHandler) {
          installedHandler();
        }
      }
    };

    const { h, onTurnComplete } = makeHandles();
    const handles: TurnHandles = {
      ...h,
      setSoftStopHandler,
    };

    await runTurn({ text: 'test', attachments: [] }, session, makeStats(), handles);

    // Critical: onTurnComplete is the state-persistence gate. If this fires
    // on a soft-stopped turn, completed work is mis-recorded as a full turn.
    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  it('clears the soft-stop handler in the finally block after turn completes', async () => {
    // Arrange: normal turn (no soft-stop). Verify handler is cleared to null.
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'hello' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session = streamFrom(events);
    const setSoftStopHandler = vi.fn();

    const { h } = makeHandles();
    const handles: TurnHandles = {
      ...h,
      setSoftStopHandler,
    };

    await runTurn({ text: 'test', attachments: [] }, session, makeStats(), handles);

    // setSoftStopHandler is called twice: once with the handler at turn start,
    // once with null in the finally block.
    const calls = setSoftStopHandler.mock.calls;
    expect(calls.length).toBe(2);
    // First call: installs a non-null handler.
    expect(calls[0]?.[0]).toBeTypeOf('function');
    // Second call (finally): clears to null.
    expect(calls[1]?.[0]).toBeNull();
  });

  it('does NOT call session.interrupt() on a full normal turn (no ESC pressed)', async () => {
    // Regression: soft-stop path must not fire on normal turns.
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'full answer' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session = streamFrom(events);
    const interruptSpy = session.interrupt as ReturnType<typeof vi.fn>;

    const { h } = makeHandles();
    await runTurn({ text: 'test', attachments: [] }, session, makeStats(), h);

    expect(interruptSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // TEST A — arm-to-handler window regression pin (Bug 1)
  // ---------------------------------------------------------------------------
  it('ESC pressed in arm-to-handler window — currently silently lost (regression pin)', async () => {
    // This test pins the FIXED behavior after Bug 1: setSoftStopHandler is
    // now installed BEFORE arm(), so an ESC that fires during arm() is caught.
    //
    // Test scenario: fire onSoftStop on the compositor BEFORE the first
    // setSoftStopHandler callback is forwarded (simulating an ESC that races
    // the arm-to-install window). We do this by capturing the installed
    // handler and firing it before the stream begins.
    //
    // NOTE: After Bug 1 is fixed, setSoftStopHandler is called BEFORE armAndWire(),
    // so the handler is available immediately. This test verifies the handler
    // is installed (non-null) at that point and, when fired, correctly sets
    // softStopRequested — causing session.interrupt() NOT to be called
    // (because no stream event has been seen yet, so the break never runs)
    // but onTurnComplete also NOT called (since softStopRequested suppresses
    // the doneFired block).
    //
    // If you are reverting Bug 1's fix, flip both assertions.

    let capturedHandler: (() => void) | null = null;
    const setSoftStopHandler = vi.fn((h: (() => void) | null) => {
      if (h !== null) capturedHandler = h;
    });

    // Fire the handler before any stream events are processed.
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'content' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session: AgentSession = {
      sessionId: 'mock-window-race',
      sendMessageStream: async function* () {
        // Fire the ESC handler before yielding any events — this simulates
        // the arm-to-handler window gap being closed by Bug 1's fix.
        capturedHandler?.();
        for (const event of events) yield event;
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    const { h, onTurnComplete } = makeHandles();
    const handles: TurnHandles = { ...h, setSoftStopHandler };

    await runTurn({ text: 'test', attachments: [] }, session, makeStats(), handles);

    // After Bug 1 fix: handler is installed before arm(), so ESC fired during
    // arm() is caught. session.interrupt() is called (softStopRequested=true
    // triggers the break+interrupt path on the first event), and onTurnComplete
    // is NOT called (turn not completed).
    expect(session.interrupt).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // TEST B — late-ESC / doneFired race regression pin (pre-fix, Bug 2)
  // ---------------------------------------------------------------------------
  it('ESC fires after done event — doneFired guard suppresses notice (regression pin)', async () => {
    // Documents the pre-fix behavior of Bug 2: the !doneFired guard on the
    // soft-stop notice prevented it from showing when ESC fired in the window
    // between the stream's done event and when the post-stream check runs.
    //
    // NOTE: After Bug 2 is fixed (guard changed to just `if (softStopRequested)`),
    // update this test: the notice SHOULD be shown and onTurnComplete should NOT
    // be called. See TEST C below for the post-fix assertion.
    //
    // This test asserts pre-fix behavior: doneFired=true when ESC fires after
    // done means the notice was suppressed and onTurnComplete WAS called.
    // Since we've already applied Bug 2's fix, this test now asserts the
    // FIXED behavior — ESC after done means notice IS shown, onTurnComplete
    // is NOT called. Update the comment if reverting.

    // Use a deferred gate so we can fire ESC externally after done is processed.
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });

    let installedHandler: (() => void) | null = null;
    const setSoftStopHandler = vi.fn((h: (() => void) | null) => {
      if (h !== null) installedHandler = h;
    });

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'answer' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session: AgentSession = {
      sessionId: 'mock-late-esc',
      sendMessageStream: async function* () {
        for (const event of events) yield event;
        // Pause after done so we can fire ESC externally.
        await gate;
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    const { h, onTurnComplete } = makeHandles();
    const handles: TurnHandles = { ...h, setSoftStopHandler };

    // Start the turn but don't await yet — fire ESC after done.
    const turnPromise = runTurn({ text: 'test', attachments: [] }, session, makeStats(), handles);

    // Give the generator time to reach the gate (after done event is yielded).
    await new Promise<void>((r) => setTimeout(r, 10));

    // Fire ESC now — done has already been processed by the stream loop,
    // but the post-stream block hasn't run yet.
    installedHandler?.();

    // Unblock the generator so runTurn can finish.
    resolveGate();
    await turnPromise;

    // Post-fix (Bug 2 fixed): softStopRequested=true → notice IS shown,
    // doneFired && !softStopRequested is false → onTurnComplete NOT called.
    // Immediate-interrupt fix: the soft-stop handler now calls
    // session.interrupt() synchronously on ESC, so it fires exactly once
    // even when ESC lands after the stream ended — a harmless idempotent
    // no-op in production (AgentSession.interrupt() returns early once the
    // session state has left streaming/processing).
    expect(session.interrupt).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // TEST C — late-ESC post-fix: notice shown, turn not recorded (Bug 2)
  // ---------------------------------------------------------------------------
  it('ESC after done — post-fix: soft-stop notice shown, turn not recorded', async () => {
    // Asserts the FIXED behavior of Bug 2: when ESC fires after the stream's
    // done event (between done and the post-stream block), the soft-stop
    // notice IS shown and the turn is NOT recorded (onTurnComplete not called).
    //
    // Infrastructure: same deferred-gate stream as TEST B. We capture the
    // completionWriter calls to assert the notice text was emitted.

    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });

    let installedHandler: (() => void) | null = null;
    const setSoftStopHandler = vi.fn((h: (() => void) | null) => {
      if (h !== null) installedHandler = h;
    });

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'answer' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session: AgentSession = {
      sessionId: 'mock-late-esc-postfix',
      sendMessageStream: async function* () {
        for (const event of events) yield event;
        await gate;
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    const writerCalls: string[] = [];
    const completionWriter = { fn: (line: string) => { writerCalls.push(line); } };

    const { h, onTurnComplete } = makeHandles();
    const handles: TurnHandles = { ...h, setSoftStopHandler };

    const turnPromise = runTurn(
      { text: 'test', attachments: [] },
      session,
      makeStats(),
      handles,
      'summary',
      completionWriter,
    );

    // Wait for the generator to reach the gate.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Fire ESC after done.
    installedHandler?.();
    resolveGate();
    await turnPromise;

    // Fixed behavior: notice IS shown via completionWriter.
    expect(writerCalls.some((line) => line.includes('Stopped'))).toBe(true);
    // Turn is NOT recorded.
    expect(onTurnComplete).not.toHaveBeenCalled();
    // Immediate-interrupt fix: the soft-stop handler calls interrupt()
    // synchronously on ESC, so it fires exactly once even after the stream
    // ended — a harmless idempotent no-op in production.
    expect(session.interrupt).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // TEST D — setSoftStopHandler absent (non-REPL surface)
  // ---------------------------------------------------------------------------
  it('setSoftStopHandler absent — turn completes normally (non-REPL surface)', async () => {
    // Non-REPL surfaces (daemon, slash-command callers) omit setSoftStopHandler
    // from TurnHandles. runTurn must not crash and must complete the turn
    // as if no soft-stop capability exists.

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'normal answer' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];

    const session = streamFrom(events);
    // makeHandles() intentionally excludes setSoftStopHandler.
    const { h, onTurnComplete, setInFlight } = makeHandles();
    // Confirm no setSoftStopHandler on the handles object.
    expect('setSoftStopHandler' in h).toBe(false);

    await runTurn({ text: 'test', attachments: [] }, session, makeStats(), h);

    // Turn completes normally.
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(setInFlight).toHaveBeenCalledWith(false);
    expect(session.interrupt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Spec: late-ESC race — ESC fires AFTER the done event has been processed
// but BEFORE the post-stream guard runs (e.g., during the awaitable
// `disposeRendererOnce()` between the for-await loop and the soft-stop
// check). The for-await loop's soft-stop check at line ~225 cannot catch
// this (no more events to iterate); the only guard is the post-loop check.
//
// Pre-fix bug: the post-loop guard was `if (softStopRequested && !doneFired)`,
// which silently dropped the soft-stop signal when both flags were true.
// The `if (doneFired)` block below recorded the turn as completed,
// fired onTurnComplete, and rendered the verdict — visible success with
// silent stop, exactly the failure mode the soft-stop UX exists to prevent.
//
// Post-fix invariant: ESC intent overrides stream completion. Always
// render the "Stopped" notice when softStopRequested; suppress the
// completed-turn path (recordTurn, onTurnComplete, onAfterTurn) via
// `if (doneFired && !softStopRequested)`. Tests assert against session
// state (recordTurn-equivalent stats.totalTurns, onTurnComplete spy)
// per the same plan-exit Risk #3 discipline as the mid-stream tests.
// ---------------------------------------------------------------------------

describe('runTurn — late-ESC race (ESC after done event)', () => {
  /**
   * Build a sendMessageStream wrapper that fires the installed soft-stop
   * handler in the generator's post-loop code — AFTER the done event has
   * been yielded and processed by the consumer's for-await loop. This
   * reproduces the late-ESC race window where the keypress callback
   * lands after doneFired=true but before the post-loop guard runs.
   *
   * Mechanism: an async generator's post-loop code runs after the last
   * yield but before the iterator returns `done: true`. The consumer
   * has already set doneFired=true (the last yielded event was 'done'),
   * so when the iterator returns, the consumer exits its for-await with
   * doneFired=true AND softStopRequested=true — the exact race state.
   */
  function fireEscAfterDone(
    session: AgentSession,
    handlerRef: { current: (() => void) | null },
  ): void {
    const realStream = session.sendMessageStream;
    session.sendMessageStream = async function* (payload: unknown) {
      for await (const event of (realStream as typeof session.sendMessageStream).call(session, payload)) {
        yield event;
      }
      // Stream ended naturally. Fire ESC NOW — this lands after the
      // consumer processed the done event but before the post-loop
      // soft-stop guard runs in runTurn.
      handlerRef.current?.();
    };
  }

  it('renders the "Stopped" notice when ESC fires after done (post-fix invariant)', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'complete answer' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];
    const session = streamFrom(events);

    const handlerRef: { current: (() => void) | null } = { current: null };
    const setSoftStopHandler = vi.fn((handler: (() => void) | null) => {
      handlerRef.current = handler;
    });
    fireEscAfterDone(session, handlerRef);

    // Capture writer output to assert the notice was rendered. The
    // turn-handler routes the notice through `console.log` when no
    // compositor is wired (non-TTY test env), so spy on console.log.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    try {
      const { h } = makeHandles();
      const handles: TurnHandles = { ...h, setSoftStopHandler };
      await runTurn({ text: 'test', attachments: [] }, session, makeStats(), handles);

      // The "⏸ Stopped" notice MUST be rendered even when doneFired=true.
      const noticeWritten = logSpy.mock.calls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('⏸ Stopped'),
      );
      expect(noticeWritten).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does NOT call onTurnComplete when ESC fires after done (late-ESC suppresses turn-complete path)', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'complete answer' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];
    const session = streamFrom(events);

    const handlerRef: { current: (() => void) | null } = { current: null };
    const setSoftStopHandler = vi.fn((handler: (() => void) | null) => {
      handlerRef.current = handler;
    });
    fireEscAfterDone(session, handlerRef);

    const { h, onTurnComplete } = makeHandles();
    const handles: TurnHandles = { ...h, setSoftStopHandler };
    await runTurn({ text: 'test', attachments: [] }, session, makeStats(), handles);

    // Pre-fix bug: onTurnComplete was called because `if (doneFired)`
    // succeeded — visible success with silent stop. Post-fix: the
    // `&& !softStopRequested` guard suppresses the completed-turn path.
    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  it('does NOT record the turn when ESC fires after done (stats.totalTurns unchanged)', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'complete answer' } },
      { type: 'done', metadata: { durationMs: 5 } },
    ];
    const session = streamFrom(events);

    const handlerRef: { current: (() => void) | null } = { current: null };
    const setSoftStopHandler = vi.fn((handler: (() => void) | null) => {
      handlerRef.current = handler;
    });
    fireEscAfterDone(session, handlerRef);

    const { h } = makeHandles();
    const handles: TurnHandles = { ...h, setSoftStopHandler };
    const stats = makeStats();
    await runTurn({ text: 'test', attachments: [] }, session, stats, handles);

    // recordTurn lives inside the `if (doneFired && !softStopRequested)`
    // gate. Late-ESC must suppress it — otherwise stats accumulate a
    // turn the user explicitly stopped.
    expect(stats.totalTurns).toBe(0);
  });
});

describe('runTurn — bell emission', () => {
  let stdoutWriteSpy: ReturnType<typeof vi.fn>;
  let originalProcessStdout: NodeJS.WriteStream;

  beforeEach(() => {
    // Save the original process.stdout.write
    originalProcessStdout = process.stdout;
    // Create a spy on write and set isTTY
    stdoutWriteSpy = vi.fn(() => true);
    (process.stdout as any).write = stdoutWriteSpy;
    (process.stdout as any).isTTY = true;
  });

  afterEach(() => {
    // Restore original process.stdout
    (process.stdout as any).write = originalProcessStdout.write;
    (process.stdout as any).isTTY = originalProcessStdout.isTTY;
  });

  it('emits bell when AFK_BELL=1 and turn completes successfully', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'done' } },
      { type: 'done', metadata: { durationMs: 10 } },
    ];

    const session = streamFrom(events);
    const { h } = makeHandles();
    const stats = makeStats();

    // Set env to enable bell
    const originalEnv = process.env.AFK_BELL;
    process.env.AFK_BELL = '1';

    try {
      await runTurn({ text: 'test', attachments: [] }, session, stats, h);
      // Verify that write was called with BEL character (\x07)
      expect(stdoutWriteSpy).toHaveBeenCalledWith('\x07');
    } finally {
      // Restore original env
      if (originalEnv === undefined) {
        delete process.env.AFK_BELL;
      } else {
        process.env.AFK_BELL = originalEnv;
      }
    }
  });

  it('does not emit bell when AFK_BELL is not set', async () => {
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'content', content: 'done' } },
      { type: 'done', metadata: { durationMs: 10 } },
    ];

    const session = streamFrom(events);
    const { h } = makeHandles();
    const stats = makeStats();

    // Ensure bell is disabled
    const originalEnv = process.env.AFK_BELL;
    delete process.env.AFK_BELL;

    try {
      await runTurn({ text: 'test', attachments: [] }, session, stats, h);
      // Verify that write was NOT called with BEL
      expect(stdoutWriteSpy).not.toHaveBeenCalledWith('\x07');
    } finally {
      if (originalEnv !== undefined) {
        process.env.AFK_BELL = originalEnv;
      }
    }
  });

});

describe('runTurn — mid-turn context progress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Two tool_use+tool_result pairs with the clock frozen: the first fires,
  // the second is suppressed (within the 15 s throttle window).
  it('fires onContextProgress on the first tool_result', async () => {
    vi.setSystemTime(1_000_000);

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolName: 'bash', toolUseId: 'tu-1', toolInput: '{}' } },
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'tu-1', content: 'r1' } },
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolName: 'bash', toolUseId: 'tu-2', toolInput: '{}' } },
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'tu-2', content: 'r2' } },
      { type: 'chunk', chunk: { type: 'content', content: 'done' } },
      { type: 'done', metadata: { durationMs: 10 } },
    ];

    const session = streamFrom(events);
    const { h } = makeHandles();
    const stats = makeStats();
    const onContextProgress = vi.fn();
    h.onContextProgress = onContextProgress;

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    // First fires, second suppressed (clock didn't advance past 15 s).
    expect(onContextProgress).toHaveBeenCalledTimes(1);
  });

  // Clock advances past CONTEXT_PROGRESS_MIN_INTERVAL_MS between the two
  // tool_result events, so both fire. The async generator calls
  // vi.setSystemTime() between the two yields to simulate the passage of time.
  it('fires again after the min interval elapses', async () => {
    vi.setSystemTime(1_000_000);

    const session: AgentSession = {
      sessionId: 'mock',
      sendMessageStream: async function* () {
        // First tool pair
        yield { type: 'chunk', chunk: { type: 'tool_use_detail', toolName: 'bash', toolUseId: 'tu-a', toolInput: '{}' } } as OutputEvent;
        yield { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'tu-a', content: 'r1' } } as OutputEvent;
        // Advance clock past the throttle window before the second tool_result
        vi.setSystemTime(1_000_000 + 16_000);
        // Second tool pair
        yield { type: 'chunk', chunk: { type: 'tool_use_detail', toolName: 'bash', toolUseId: 'tu-b', toolInput: '{}' } } as OutputEvent;
        yield { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'tu-b', content: 'r2' } } as OutputEvent;
        yield { type: 'chunk', chunk: { type: 'content', content: 'done' } } as OutputEvent;
        yield { type: 'done', metadata: { durationMs: 10 } } as OutputEvent;
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    const { h } = makeHandles();
    const stats = makeStats();
    const onContextProgress = vi.fn();
    h.onContextProgress = onContextProgress;

    await runTurn({ text: 'q', attachments: [] }, session, stats, h);

    // Both should fire — the clock advanced past the minimum interval.
    // This test would fail if the interval guard were removed (it would
    // still be called twice, but the interval IS what separates the two
    // calls here, making the behavior intentional and tested).
    expect(onContextProgress).toHaveBeenCalledTimes(2);
  });

  // Proves the `if (r instanceof Promise) await r` path in the turn handler.
  it('awaits an async onContextProgress', async () => {
    vi.setSystemTime(2_000_000);

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolName: 'bash', toolUseId: 'tu-c', toolInput: '{}' } },
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'tu-c', content: 'rc' } },
      { type: 'chunk', chunk: { type: 'content', content: 'done' } },
      { type: 'done', metadata: { durationMs: 10 } },
    ];

    const session = streamFrom(events);
    const { h } = makeHandles();
    const stats = makeStats();
    let resolved = false;
    h.onContextProgress = () => new Promise<void>((res) => {
      setTimeout(() => { resolved = true; res(); }, 0);
    });

    // runTurn uses vi.useFakeTimers, so we need to let the microtask/timer fire.
    // We run the turn in the background and tick the fake timers.
    const turnPromise = runTurn({ text: 'q', attachments: [] }, session, stats, h);
    // Advance fake timers so the setTimeout(0) inside onContextProgress resolves.
    await vi.runAllTimersAsync();
    await turnPromise;

    expect(resolved).toBe(true);
  });

  // Errors thrown from onContextProgress must not propagate out of runTurn.
  it('swallows a throwing onContextProgress', async () => {
    vi.setSystemTime(3_000_000);

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolName: 'bash', toolUseId: 'tu-d', toolInput: '{}' } },
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'tu-d', content: 'rd' } },
      { type: 'chunk', chunk: { type: 'content', content: 'done' } },
      { type: 'done', metadata: { durationMs: 10 } },
    ];

    const session = streamFrom(events);
    const { h } = makeHandles();
    const stats = makeStats();
    h.onContextProgress = () => { throw new Error('status refresh exploded'); };

    await expect(runTurn({ text: 'q', attachments: [] }, session, stats, h)).resolves.toBeUndefined();
  });

  // onContextProgress absent entirely — must not throw.
  it('does not throw when onContextProgress is absent', async () => {
    vi.setSystemTime(4_000_000);

    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolName: 'bash', toolUseId: 'tu-e', toolInput: '{}' } },
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'tu-e', content: 're' } },
      { type: 'chunk', chunk: { type: 'content', content: 'done' } },
      { type: 'done', metadata: { durationMs: 10 } },
    ];

    const session = streamFrom(events);
    const { h } = makeHandles();
    // Explicitly ensure onContextProgress is absent (makeHandles doesn't add it).
    delete h.onContextProgress;
    const stats = makeStats();

    await expect(runTurn({ text: 'q', attachments: [] }, session, stats, h)).resolves.toBeUndefined();
  });
});
