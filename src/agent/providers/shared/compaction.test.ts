/**
 * Provider-neutral compaction core tests. Exercises the generic algorithms and
 * the orchestrator guardrails against a tiny fake message type + ops, with no
 * real provider or network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  COMPACT_ACK_TEXT,
  COMPACT_SUMMARY_HEADER,
  DEFAULT_COMPACT_SHRINK_THRESHOLD,
  applyCompaction,
  estimateTokensSaved,
  findCompactionBoundary,
  findCompactionBoundaryAdaptive,
  renderTranscript,
  runCompactionCore,
  wrapTranscriptForSummary,
  type CompactionOps,
} from './compaction.js';

// A minimal message: a role + text. "user" messages are fresh user turns.
interface FakeMsg {
  role: 'user' | 'assistant';
  text: string;
}

const fakeOps: CompactionOps<FakeMsg> = {
  isFreshUserTurn: (m) => m.role === 'user',
  renderMessage: (m) => `${m.role}: ${m.text}`,
  buildPreamble: (summary) => [
    { role: 'user', text: COMPACT_SUMMARY_HEADER + '\n\n' + summary },
    { role: 'assistant', text: COMPACT_ACK_TEXT },
  ],
  countChars: (m) => m.text.length,
};

function history(): FakeMsg[] {
  return [
    { role: 'user', text: 'u1' },
    { role: 'assistant', text: 'a1' },
    { role: 'user', text: 'u2' },
    { role: 'assistant', text: 'a2' },
    { role: 'user', text: 'u3' },
  ];
}

describe('findCompactionBoundary (generic)', () => {
  it('returns -1 when fewer fresh user turns than keepLastN', () => {
    expect(findCompactionBoundary(history(), 9, fakeOps)).toBe(-1);
  });
  it('returns the index of the K-th fresh user turn from the end', () => {
    // fresh users at 0,2,4. keep last 2 -> boundary at index 2 (u2).
    expect(findCompactionBoundary(history(), 2, fakeOps)).toBe(2);
  });
  it('returns 0 when the whole history is within the keep window', () => {
    expect(findCompactionBoundary(history(), 3, fakeOps)).toBe(0);
  });
});

// Two fresh user turns — the "short but full" shape that the turn-count
// keep-window (default 2) cannot compact without the fullness fallback.
function twoTurns(): FakeMsg[] {
  return [
    { role: 'user', text: 'u1' },
    { role: 'assistant', text: 'a1' },
    { role: 'user', text: 'u2' },
    { role: 'assistant', text: 'a2' },
  ];
}

describe('findCompactionBoundaryAdaptive', () => {
  const full = DEFAULT_COMPACT_SHRINK_THRESHOLD; // exactly at the gate counts as full
  const empty = 0;

  it('returns the normal boundary unchanged when the turn-count window already works', () => {
    // history() has fresh users at 0,2,4 → keepLastN=2 lands at index 2. A full
    // window must not change a boundary that was already > 0.
    expect(findCompactionBoundaryAdaptive(history(), 2, fakeOps, full)).toBe(2);
    expect(findCompactionBoundaryAdaptive(history(), 2, fakeOps, empty)).toBe(2);
  });

  it('does NOT shrink below the fullness threshold (preserves the no-op)', () => {
    // Two turns, keepLastN=2 → base boundary 0 (nothing-to-summarize). Below the
    // gate the boundary stays 0 so a near-empty session is left alone.
    expect(findCompactionBoundary(twoTurns(), 2, fakeOps)).toBe(0);
    expect(findCompactionBoundaryAdaptive(twoTurns(), 2, fakeOps, 0.5, 0.7)).toBe(0);
  });

  it('shrinks the keep-window on a short-but-full session so an older turn becomes eligible', () => {
    // At/above the gate, keepLastN relaxes from 2 → 1, landing the boundary on
    // the second fresh user turn (index 2) so turn 1 gets summarized.
    expect(findCompactionBoundaryAdaptive(twoTurns(), 2, fakeOps, 0.7, 0.7)).toBe(2);
    expect(findCompactionBoundaryAdaptive(twoTurns(), 2, fakeOps, 0.95, 0.7)).toBe(2);
  });

  it('cannot help a genuinely single-turn session even when full', () => {
    // One fresh user turn (index 0). keepLastN=2 → -1; shrinking to 1 still lands
    // at index 0 (not > 0), so the honest history-too-short boundary is returned.
    const oneTurn: FakeMsg[] = [
      { role: 'user', text: 'only' },
      { role: 'assistant', text: 'reply' },
    ];
    expect(findCompactionBoundaryAdaptive(oneTurn, 2, fakeOps, 0.99, 0.7)).toBe(-1);
  });

  it('has nothing to shrink when keepLastN is already 1', () => {
    // Base boundary 0 and the shrink loop (n from 0) never runs → stays 0.
    expect(findCompactionBoundaryAdaptive(twoTurns(), 1, fakeOps, 0.99, 0.7)).toBe(2);
    const oneTurn: FakeMsg[] = [{ role: 'user', text: 'only' }];
    expect(findCompactionBoundaryAdaptive(oneTurn, 1, fakeOps, 0.99, 0.7)).toBe(0);
  });
});

describe('renderTranscript / applyCompaction / estimateTokensSaved (generic)', () => {
  it('renders each message via ops.renderMessage', () => {
    const t = renderTranscript(history(), fakeOps);
    expect(t).toContain('user: u1');
    expect(t).toContain('assistant: a2');
  });
  it('splices [summary, ack, ...tail] at the boundary', () => {
    const out = applyCompaction(history(), 2, 'SUM', fakeOps);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(out[0]?.text).toContain(COMPACT_SUMMARY_HEADER);
    expect(out[0]?.text).toContain('SUM');
    expect(out[1]?.text).toBe(COMPACT_ACK_TEXT);
    expect(out[2]?.text).toBe('u2');
  });
  it('estimate is 0 at boundary 0 and positive once content is dropped', () => {
    expect(estimateTokensSaved(history(), 0, 's', fakeOps)).toBe(0);
    const big: FakeMsg[] = [{ role: 'user', text: 'x'.repeat(4000) }, { role: 'user', text: 't' }];
    expect(estimateTokensSaved(big, 1, 's', fakeOps)).toBeGreaterThan(0);
  });
});

describe('wrapTranscriptForSummary', () => {
  it('wraps the transcript in a single <transcript> instruction', () => {
    const w = wrapTranscriptForSummary('HELLO');
    expect(w).toContain('<transcript>\nHELLO\n</transcript>');
    expect(w.toLowerCase()).toContain('summarize');
  });
});

describe('runCompactionCore', () => {
  const baseDeps = () => ({
    messages: history(),
    ops: fakeOps,
    keepLastN: 2,
    isAborted: () => false,
  });

  it('summarizes the older slice and splices in place on success', async () => {
    const deps = baseDeps();
    const summarize = vi.fn(async (transcript: string) => {
      expect(transcript).toContain('u1'); // older slice was rendered
      return 'COMPRESSED';
    });
    const onSuccess = vi.fn();
    const result = await runCompactionCore({ ...deps, summarize, onSuccess });
    expect(result.compacted).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    // priorTurns mutated in place: [user(summary), assistant(ack), u2, a2, u3]
    expect(deps.messages[0]?.text).toContain('COMPRESSED');
    expect(deps.messages[1]?.text).toBe(COMPACT_ACK_TEXT);
    expect(deps.messages).toHaveLength(5);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty summary and leaves history untouched', async () => {
    const deps = baseDeps();
    const before = [...deps.messages];
    const result = await runCompactionCore({ ...deps, summarize: async () => '   ' });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('empty-summary');
    expect(deps.messages).toEqual(before);
  });

  it('maps a rejected summarize to summarization-failed (history untouched)', async () => {
    const deps = baseDeps();
    const before = [...deps.messages];
    const result = await runCompactionCore({
      ...deps,
      summarize: async () => {
        throw new Error('boom');
      },
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain('summarization-failed');
    expect(result.reason).toContain('boom');
    expect(deps.messages).toEqual(before);
  });

  it('reclassifies a failure as aborted when isAborted() is true', async () => {
    const deps = baseDeps();
    const result = await runCompactionCore({
      ...deps,
      isAborted: () => true,
      summarize: async () => {
        throw new Error('cancelled');
      },
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('aborted');
  });

  it('reports a timeout as summarization-failed even when abortInFlight trips the shared abort signal', async () => {
    const deps = baseDeps();
    const before = [...deps.messages];
    // Mirror the real provider wiring (openai-compatible/compact.ts): isAborted
    // and abortInFlight read the SAME controller, so the timeout's abortInFlight()
    // flips isAborted() to true. A genuine timeout must still be reported as
    // summarization-failed, never reclassified as a user-initiated 'aborted'.
    const controller = new AbortController();
    const result = await runCompactionCore({
      ...deps,
      timeoutMs: 20,
      isAborted: () => controller.signal.aborted,
      abortInFlight: () => controller.abort(),
      summarize: () => new Promise<string>(() => {}), // never resolves
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain('summarization-failed');
    expect(result.reason).toContain('timed out');
    expect(controller.signal.aborted).toBe(true);
    expect(deps.messages).toEqual(before);
  });

  it('no-ops (history-too-short) without calling summarize', async () => {
    const summarize = vi.fn();
    const result = await runCompactionCore({
      messages: history(),
      ops: fakeOps,
      keepLastN: 99,
      isAborted: () => false,
      summarize,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('history-too-short');
    expect(summarize).not.toHaveBeenCalled();
  });

  it('no-ops (nothing-to-summarize) when the whole history is within the keep window', async () => {
    // history() has 3 fresh user turns (indices 0,2,4). keepLastN=3 lands the
    // boundary at index 0 — nothing older than the keep window to summarize —
    // so the core bails without touching the summarizer or the history.
    const summarize = vi.fn();
    const messages = history();
    const before = [...messages];
    const result = await runCompactionCore({
      messages,
      ops: fakeOps,
      keepLastN: 3,
      isAborted: () => false,
      summarize,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('nothing-to-summarize');
    expect(summarize).not.toHaveBeenCalled();
    expect(messages).toEqual(before);
  });

  it('compacts a short-but-full session via the adaptive keep-window (usedFraction >= threshold)', async () => {
    // Two fresh user turns, keepLastN=2 → the turn-count boundary is 0
    // (nothing-to-summarize). A full window relaxes the keep-window to 1 so
    // turn 1 is summarized and spliced away.
    const summarize = vi.fn(async () => 'COMPRESSED');
    const messages = twoTurns();
    const result = await runCompactionCore({
      messages,
      ops: fakeOps,
      keepLastN: 2,
      usedFraction: 0.95,
      isAborted: () => false,
      summarize,
    });
    expect(result.compacted).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    // [user(summary), assistant(ack), u2, a2]
    expect(messages[0]?.text).toContain('COMPRESSED');
    expect(messages[2]?.text).toBe('u2');
  });

  it('leaves a short session untouched when usedFraction is below the threshold', async () => {
    const summarize = vi.fn();
    const messages = twoTurns();
    const before = [...messages];
    const result = await runCompactionCore({
      messages,
      ops: fakeOps,
      keepLastN: 2,
      usedFraction: 0.1,
      isAborted: () => false,
      summarize,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('nothing-to-summarize');
    expect(summarize).not.toHaveBeenCalled();
    expect(messages).toEqual(before);
  });
});
