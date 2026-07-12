/**
 * Provider-neutral compaction core tests. Exercises the generic algorithms and
 * the orchestrator guardrails against a tiny fake message type + ops, with no
 * real provider or network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  COMPACT_ACK_TEXT,
  COMPACT_SUMMARY_HEADER,
  applyCompaction,
  estimateTokensSaved,
  findCompactionBoundary,
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
});
