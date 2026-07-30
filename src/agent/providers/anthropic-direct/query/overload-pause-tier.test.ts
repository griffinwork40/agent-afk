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

  it('surfaces a real terminal at the wall-clock ceiling instead of parking forever', async () => {
    process.env['AFK_OVERLOAD_PAUSE_MS'] = '150000'; // 2.5min ceiling
    scriptTurns([exhausted]); // never recovers
    const promise = drain(
      makeLayer('cli').turnWithRetries(makeInput(new AbortController().signal), () => false),
    );
    await vi.advanceTimersByTimeAsync(600_000);
    const events = await promise;

    // Bounded: it stopped probing rather than looping forever...
    expect(runTurnMock.mock.calls.length).toBeLessThan(6);
    // ...and the LAST thing it did was emit a real terminal, never silence.
    expect(events.at(-1)?.type).toBe('turn.completed');
    const last = events.at(-1);
    if (last?.type === 'turn.completed') {
      expect(last.usage.stopReason).toBe(OVERLOAD_EXHAUSTED);
    }
  });

  // AbortGraph precedence: abort beats hook decisions and retries, so it must
  // also beat a pause. A caller interrupt during the park must halt promptly.
  it('lets a caller abort during the pause win immediately', async () => {
    scriptTurns([exhausted]);
    const ac = new AbortController();
    const promise = drain(makeLayer('cli').turnWithRetries(makeInput(ac.signal), () => false));

    await vi.advanceTimersByTimeAsync(100); // attempt 1 exhausts, tier enters the park
    ac.abort('interrupted');
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;

    // Aborted during the probe sleep — no replay was ever attempted.
    expect(runTurnMock).toHaveBeenCalledTimes(1);
  });

  // A concurrent close() must not leave the tier spinning either.
  it('stops when the session closes during the pause', async () => {
    scriptTurns([exhausted]);
    let closed = false;
    const promise = drain(
      makeLayer('cli').turnWithRetries(makeInput(new AbortController().signal), () => closed),
    );
    await vi.advanceTimersByTimeAsync(100);
    closed = true;
    await vi.advanceTimersByTimeAsync(200_000);
    await promise;
    expect(runTurnMock).toHaveBeenCalledTimes(1);
  });
});
