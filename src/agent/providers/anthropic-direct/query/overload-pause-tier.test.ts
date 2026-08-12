// Bounded overload-pause tier tests (#762). Mocks `runTurn` so the tier can be
// driven deterministically: the loop's exhaustion terminal is a clean
// `turn.completed` carrying OVERLOAD_EXHAUSTED, which is the ONLY signal this
// tier keys on (a status-less mid-stream 529 is unclassifiable by
// classifyUsageLimitError — see usage-limit.ts:111).
//
// Invariant under test: every exit path re-yields the preserved terminal, so the
// session always seals with a real `closure`. A pause that ended in silence
// would re-create the 38-and-63-minute hangs issue #762 documents.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput } from '../types.js';

const runTurnMock = vi.hoisted(() => vi.fn());
vi.mock('../loop.js', () => ({ runTurn: runTurnMock }));
vi.mock('../../../../cli/keychain.js', () => ({
  loadClaudeCodeOauthToken: () => 'tok',
  parseAccountIdentifier: () => 'acct',
}));
vi.mock('../auth.js', () => ({ buildRequestHeaders: () => ({ 'x-req': 'new' }) }));

const { RetryLayer } = await import('./retry-layer.js');
const { OVERLOAD_EXHAUSTED } = await import('../overload-pause.js');

const exhausted: ProviderEvent = {
  type: 'turn.completed',
  usage: { stopReason: OVERLOAD_EXHAUSTED, outputTokens: 12 },
  sessionId: 's1',
};
const cleanDone: ProviderEvent = {
  type: 'turn.completed',
  usage: { stopReason: 'end_turn' },
  sessionId: 's1',
};

function makeLayer(surface: string | undefined) {
  return new RetryLayer({
    client: {} as unknown as Anthropic,
    authMode: 'api-key',
    initSessionId: 's1',
    autoResumeOnUsageLimit: true,
    ...(surface !== undefined ? { surface } : {}),
  });
}

function makeInput(signal: AbortSignal): RunTurnInput {
  return {
    client: {} as never,
    messages: [{ role: 'user', content: 'hi' }],
    system: null,
    tools: null,
    toolDispatcher: {} as never,
    model: 'claude-test',
    maxTokens: 1024,
    headers: {},
    signal,
    ctx: { sessionId: 's1' } as never,
  };
}

/** Feed a scripted sequence of per-attempt event arrays to the mocked runTurn. */
function scriptTurns(...attempts: ProviderEvent[][]): void {
  let i = 0;
  runTurnMock.mockImplementation(() => {
    const events = attempts[Math.min(i, attempts.length - 1)] ?? [];
    i++;
    return (async function* () {
      for (const e of events) yield e;
    })();
  });
}

async function drain(gen: AsyncGenerator<ProviderEvent, void, void>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

beforeEach(() => {
  runTurnMock.mockReset();
  delete process.env['AFK_OVERLOAD_PAUSE_MS'];
});
afterEach(() => {
  vi.useRealTimers();
  // Drops any `Math.random` pin a jitter-sensitive test installed, so the probe
  // band stays random for every other test in this file.
  vi.restoreAllMocks();
  delete process.env['AFK_OVERLOAD_PAUSE_MS'];
});

describe('overload pause tier — fail-fast surfaces', () => {
  // The daemon safety property: never park, surface the preserved terminal at
  // once. One runTurn call, no probe, and the terminal still reaches the caller.
  it('does not park a daemon session and preserves the terminal', async () => {
    scriptTurns([exhausted]);
    const events = await drain(
      makeLayer('daemon').turnWithRetries(makeInput(new AbortController().signal), () => false),
    );

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('turn.completed');
    if (events[0]?.type === 'turn.completed') {
      expect(events[0].usage.stopReason).toBe(OVERLOAD_EXHAUSTED);
    }
  });

  it('honors AFK_OVERLOAD_PAUSE_MS=0 on an interactive surface', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '0';
    scriptTurns([exhausted]);
    const events = await drain(
      makeLayer('cli').turnWithRetries(makeInput(new AbortController().signal), () => false),
    );
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it('passes an ordinary clean turn straight through untouched', async () => {
    scriptTurns([{ type: 'delta.text', text: 'hello', sessionId: 's1' }, cleanDone]);
    const events = await drain(
      makeLayer('cli').turnWithRetries(makeInput(new AbortController().signal), () => false),
    );
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(2);
  });
});

describe('overload pause tier — interactive pause + ceiling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('parks an interactive session, probes, and resumes when capacity frees up', async () => {
    // Attempt 1 exhausts; the post-pause probe streams normally.
    scriptTurns([exhausted], [{ type: 'delta.text', text: 'recovered', sessionId: 's1' }, cleanDone]);
    const promise = drain(
      makeLayer('cli').turnWithRetries(makeInput(new AbortController().signal), () => false),
    );
    await vi.advanceTimersByTimeAsync(130_000); // past one 60–120s probe interval
    const events = await promise;

    expect(runTurnMock).toHaveBeenCalledTimes(2);
    // The exhaustion terminal was SWALLOWED (the turn recovered), so the caller
    // sees only the recovered stream — no spurious failure terminal.
    expect(events.some((e) => e.type === 'turn.completed' && e.usage.stopReason === OVERLOAD_EXHAUSTED)).toBe(false);
    expect(events.at(-1)?.type).toBe('turn.completed');
  });

  // Invariant: the probe interval is JITTERED — `nextProbeDelayMs` draws
  // uniformly from [60s, 120s) off `Math.random` — so the probe count under a
  // fixed ceiling is a range, not a constant, and the RNG must be pinned for
  // the bound to be assertable at all. Arithmetic for the 150s ceiling, where
  // each sleep is clamped to the remaining budget:
  //   shortest draws (60s): probes land at 60s, 120s, 150s -> 4 runTurn calls
  //   longest  draws (~120s): probes land at 120s, 150s    -> 3 runTurn calls
  // Both extremes are pinned below so a ceiling regression breaks the count in
  // whichever direction it drifts. The previous unpinned `<= 3` asserted a max
  // that was simply wrong (4, not 3) and so failed on the ~12.5% of CI runs
  // that drew d1 + d2 < 150s — red on PRs #811 and #817 from the same seedless
  // draw, not from either PR's diff.
  it.each([
    { label: 'shortest probe draws', random: 0, expectedCalls: 4 },
    { label: 'longest probe draws', random: 0.999999, expectedCalls: 3 },
  ])(
    'surfaces a real terminal at the wall-clock ceiling instead of parking forever ($label)',
    async ({ random, expectedCalls }) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      process.env['AFK_OVERLOAD_PAUSE_MS'] = '150000'; // 2.5min ceiling
      scriptTurns([exhausted]); // never recovers
      const promise = drain(
        makeLayer('cli').turnWithRetries(makeInput(new AbortController().signal), () => false),
      );
      await vi.advanceTimersByTimeAsync(600_000);
      const events = await promise;

      // Bounded: it stopped probing rather than looping forever...
      expect(runTurnMock.mock.calls.length).toBe(expectedCalls);
      // ...and the LAST thing it did was emit a real terminal, never silence.
      expect(events.at(-1)?.type).toBe('turn.completed');
      const last = events.at(-1);
      if (last?.type === 'turn.completed') {
        expect(last.usage.stopReason).toBe(OVERLOAD_EXHAUSTED);
      }
    },
  );

  // AbortGraph precedence: abort beats hook decisions and retries, so it must
  // also beat a pause. A caller interrupt during the park must halt promptly.
  it('lets a caller abort during the pause win immediately', async () => {
    scriptTurns([exhausted]);
    const ac = new AbortController();
    const promise = drain(makeLayer('cli').turnWithRetries(makeInput(ac.signal), () => false));

    await vi.advanceTimersByTimeAsync(100); // attempt 1 exhausts, tier enters the park
    ac.abort('interrupted');
    await vi.advanceTimersByTimeAsync(200_000);
    const events = await promise;

    // Aborted during the probe sleep — no replay was ever attempted.
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    // This tier yields NOTHING on the post-sleep abort exit, by design: query.ts
    // detects a terminal-less clean return and synthesizes an `interrupted`
    // terminal, so the turn still commits and the seal is `cancelled` (the
    // more-specific status). Pinned so a change to that exit is deliberate.
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false);
  });

  // A concurrent close() must not leave the tier spinning either.
  // M1 fix: close() is distinguished from interrupt(). A close() ends the
  // session entirely; the OVERLOAD_EXHAUSTED terminal must be yielded so
  // `lastStopReason` is recorded and the session seals `failed` not `succeeded`.
  // This is different from the abort exit above: interrupt() is a recoverable
  // pause and query-turn-driver.ts synthesizes an `interrupted` terminal for it,
  // but close() is a session end and query-turn-driver.ts relies on the tier to
  // surface the real terminal so `lastUsage.stopReason` can be captured before
  // the closed-return.
  it('yields the preserved terminal when the session closes during the pause', async () => {
    scriptTurns([exhausted]);
    let closed = false;
    const promise = drain(
      makeLayer('cli').turnWithRetries(makeInput(new AbortController().signal), () => closed),
    );
    await vi.advanceTimersByTimeAsync(100);
    closed = true;
    await vi.advanceTimersByTimeAsync(200_000);
    const events = await promise;
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    // The tier must yield the exhausted terminal so the session consumer can
    // record lastStopReason = OVERLOAD_EXHAUSTED before returning on close.
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('turn.completed');
    if (events[0]?.type === 'turn.completed') {
      expect(events[0].usage.stopReason).toBe(OVERLOAD_EXHAUSTED);
    }
  });
});

// Trace-fidelity and replay-hygiene contracts for the park (#764 review).
describe('overload pause tier — trace fidelity and replay hygiene', () => {
  /** Captures `session_phase` rows so a phantom pause/resume cycle is visible. */
  function makeCapturingInput(signal: AbortSignal): {
    input: RunTurnInput;
    phases: { phase: string; outcome?: unknown; ceilingMs?: unknown; durationMs?: number }[];
  } {
    const phases: { phase: string; outcome?: unknown; ceilingMs?: unknown; durationMs?: number }[] =
      [];
    const input = makeInput(signal);
    input.traceWriter = {
      write: (row: { kind: string; payload: Record<string, unknown> }) => {
        if (row.kind === 'session_phase') {
          const md = (row.payload['metadata'] ?? {}) as Record<string, unknown>;
          phases.push({
            phase: String(row.payload['phase']),
            outcome: md['outcome'],
            ceilingMs: md['ceilingMs'],
            durationMs: row.payload['durationMs'] as number | undefined,
          });
        }
        return Promise.resolve();
      },
    } as unknown as RunTurnInput['traceWriter'];
    return { input, phases };
  }

  const notice: ProviderEvent = {
    type: 'assistant.message',
    text: 'Anthropic is overloaded (HTTP 529) …',
    sessionId: 's1',
  };

  // THE REGRESSION: a re-exhausting probe forwards the notice (and any partial
  // deltas) BEFORE its sentinel terminal. Gating `overload_resume` on the first
  // forwarded event therefore logged a phantom 'recovered' on every probe — a
  // 10-minute park read as ~9 recover/park cycles that never happened.
  it('does not log a phantom resume when a probe re-exhausts', async () => {
    vi.useFakeTimers();
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '600000';
    // Two attempts that emit the notice then re-exhaust, then a clean recovery.
    scriptTurns([notice, exhausted], [notice, exhausted], [{ ...notice, text: 'ok' }, cleanDone]);
    const { input, phases } = makeCapturingInput(new AbortController().signal);
    const promise = drain(makeLayer('cli').turnWithRetries(input, () => false));
    await vi.advanceTimersByTimeAsync(600_000);
    await promise;

    expect(phases.filter((p) => p.phase === 'overload_pause')).toHaveLength(1);
    const resumes = phases.filter((p) => p.phase === 'overload_resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.outcome).toBe('recovered');
  });

  it('marks a ceiling-reached park as such, never as recovered', async () => {
    vi.useFakeTimers();
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '150000';
    scriptTurns([notice, exhausted]); // never recovers
    const { input, phases } = makeCapturingInput(new AbortController().signal);
    const promise = drain(makeLayer('cli').turnWithRetries(input, () => false));
    await vi.advanceTimersByTimeAsync(600_000);
    await promise;

    const resumes = phases.filter((p) => p.phase === 'overload_resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.outcome).toBe('ceiling-reached');
    expect(phases.filter((p) => p.phase === 'overload_pause')).toHaveLength(1);
  });

  // Codex P1: the failed attempt's partial output was already forwarded, so a
  // recovering replay rendered appended to dead text with no reset marker.
  it('resets the surface with stream.retry before replaying', async () => {
    vi.useFakeTimers();
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '600000';
    scriptTurns([notice, exhausted], [{ ...notice, text: 'recovered' }, cleanDone]);
    const promise = drain(
      makeLayer('cli').turnWithRetries(makeInput(new AbortController().signal), () => false),
    );
    await vi.advanceTimersByTimeAsync(600_000);
    const events = await promise;

    const retryIdx = events.findIndex((e) => e.type === 'stream.retry');
    expect(retryIdx).toBeGreaterThan(-1);
    // The reset must precede the replayed attempt's output, not trail it.
    const recoveredIdx = events.findIndex(
      (e) => e.type === 'assistant.message' && e.text === 'recovered',
    );
    expect(recoveredIdx).toBeGreaterThan(retryIdx);
  });

  // Codex P2: the ceiling was advisory, not a wall clock — an unclamped probe
  // sleep parked a full 60s minimum regardless of how little budget remained.
  it('clamps the probe sleep to the remaining ceiling', async () => {
    vi.useFakeTimers();
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '1'; // 1ms ceiling
    scriptTurns([exhausted]);
    const promise = drain(
      makeLayer('cli').turnWithRetries(makeInput(new AbortController().signal), () => false),
    );
    // Far below one probe interval (60s): an unclamped sleep would still be parked.
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await promise;

    expect(events.at(-1)?.type).toBe('turn.completed');
    const last = events.at(-1);
    if (last?.type === 'turn.completed') {
      expect(last.usage.stopReason).toBe(OVERLOAD_EXHAUSTED);
    }
  });
});
