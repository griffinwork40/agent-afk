/**
 * Provider-neutral tool-result microcompaction tests. Exercises the generic
 * {@link microcompactToolResults} algorithm and the pure option resolver against
 * a tiny fake message + tool-result-ref model, with no real provider.
 *
 * The core invariants under test (each a Messages-API correctness property):
 *   - PAIRING PRESERVED: no ref is ever removed; only its content is cleared.
 *   - PLACEHOLDER applied to large/old blocks, carrying a byte hint.
 *   - LAST-K kept intact regardless of size.
 *   - IDEMPOTENT: a second pass over already-cleared content is a no-op.
 *   - SIZE-ORDERED: largest candidates cleared first.
 *   - THRESHOLD respected: blocks below the byte threshold are left intact.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MICROCOMPACT_KEEP_LAST,
  DEFAULT_MICROCOMPACT_TOOL_RESULT_BYTES,
  MICROCOMPACT_PLACEHOLDER_SENTINEL,
  buildMicrocompactPlaceholder,
  byteLengthOf,
  isMicrocompactPlaceholder,
  microcompactToolResults,
  resolveMicrocompactOptions,
  type MicrocompactOps,
  type ToolResultRef,
} from './compaction.js';

// A minimal message: either a plain message or a tool result carrying content.
interface FakeMsg {
  kind: 'text' | 'tool_result';
  content: string;
}

/**
 * Fake ops: every `tool_result` message is one ref. `clear()` mutates the
 * message's content in place — the message object itself is never removed, which
 * is exactly the pairing-preservation invariant the real providers must honor.
 */
const fakeOps: MicrocompactOps<FakeMsg> = {
  listToolResults(messages: ReadonlyArray<FakeMsg>): ToolResultRef[] {
    const refs: ToolResultRef[] = [];
    for (const msg of messages) {
      if (msg.kind !== 'tool_result') continue;
      refs.push({
        byteLength: byteLengthOf(msg.content),
        isPlaceholder: isMicrocompactPlaceholder(msg.content),
        clear(placeholder: string): void {
          msg.content = placeholder;
        },
      });
    }
    return refs;
  },
};

function tr(bytes: number, fill = 'x'): FakeMsg {
  return { kind: 'tool_result', content: fill.repeat(bytes) };
}
function txt(content: string): FakeMsg {
  return { kind: 'text', content };
}

describe('buildMicrocompactPlaceholder / isMicrocompactPlaceholder', () => {
  it('placeholder begins with the sentinel and reports the byte count', () => {
    const p = buildMicrocompactPlaceholder(4096);
    expect(p.startsWith(MICROCOMPACT_PLACEHOLDER_SENTINEL)).toBe(true);
    expect(p).toContain('4096');
    expect(isMicrocompactPlaceholder(p)).toBe(true);
  });
  it('non-placeholder text is not detected as a placeholder', () => {
    expect(isMicrocompactPlaceholder('a normal tool result')).toBe(false);
    expect(isMicrocompactPlaceholder('')).toBe(false);
  });
});

describe('microcompactToolResults (generic)', () => {
  it('does nothing when there are no tool_result blocks', () => {
    const msgs = [txt('u1'), txt('a1')];
    const before = msgs.map((m) => m.content);
    const r = microcompactToolResults(msgs, fakeOps, { thresholdBytes: 10, keepLast: 0 });
    expect(r.blocksCleared).toBe(0);
    expect(r.bytesReclaimed).toBe(0);
    expect(r.blocksScanned).toBe(0);
    expect(msgs.map((m) => m.content)).toEqual(before);
  });

  it('PAIRING: never removes a block — count is unchanged, every ref still present', () => {
    const msgs = [tr(5000), txt('mid'), tr(6000), tr(7000)];
    const lenBefore = msgs.length;
    const trCountBefore = msgs.filter((m) => m.kind === 'tool_result').length;
    microcompactToolResults(msgs, fakeOps, { thresholdBytes: 1000, keepLast: 0 });
    expect(msgs.length).toBe(lenBefore);
    expect(msgs.filter((m) => m.kind === 'tool_result').length).toBe(trCountBefore);
  });

  it('PLACEHOLDER: replaces large blocks with a sentinel-prefixed placeholder', () => {
    const msgs = [tr(5000)];
    const r = microcompactToolResults(msgs, fakeOps, { thresholdBytes: 1000, keepLast: 0 });
    expect(r.blocksCleared).toBe(1);
    expect(isMicrocompactPlaceholder(msgs[0]!.content)).toBe(true);
    expect(msgs[0]!.content).toContain('5000');
    // Net reclaim = original bytes minus the placeholder length written back.
    expect(r.bytesReclaimed).toBe(5000 - byteLengthOf(msgs[0]!.content));
    expect(r.bytesReclaimed).toBeGreaterThan(4000);
  });

  it('THRESHOLD: blocks below the byte threshold are left intact', () => {
    const small = tr(500);
    const big = tr(5000);
    const msgs = [small, big];
    const smallBefore = small.content;
    const r = microcompactToolResults(msgs, fakeOps, { thresholdBytes: 1000, keepLast: 0 });
    expect(r.blocksCleared).toBe(1); // only the big one
    expect(small.content).toBe(smallBefore); // small untouched
    expect(isMicrocompactPlaceholder(big.content)).toBe(true);
  });

  it('LAST-K: keeps the most-recent keepLast results intact regardless of size', () => {
    // 4 large results; keepLast=2 protects the last two, clears the first two.
    const msgs = [tr(5000, 'a'), tr(5000, 'b'), tr(5000, 'c'), tr(5000, 'd')];
    const r = microcompactToolResults(msgs, fakeOps, { thresholdBytes: 1000, keepLast: 2 });
    expect(r.blocksCleared).toBe(2);
    expect(isMicrocompactPlaceholder(msgs[0]!.content)).toBe(true);
    expect(isMicrocompactPlaceholder(msgs[1]!.content)).toBe(true);
    // Last two kept verbatim.
    expect(msgs[2]!.content).toBe('c'.repeat(5000));
    expect(msgs[3]!.content).toBe('d'.repeat(5000));
  });

  it('LAST-K: keepLast >= tool_result count protects everything (no-op)', () => {
    const msgs = [tr(5000), tr(6000)];
    const before = msgs.map((m) => m.content);
    const r = microcompactToolResults(msgs, fakeOps, { thresholdBytes: 1, keepLast: 5 });
    expect(r.blocksCleared).toBe(0);
    expect(msgs.map((m) => m.content)).toEqual(before);
  });

  it('IDEMPOTENT: a second pass clears nothing and reclaims nothing', () => {
    const msgs = [tr(5000), tr(6000), tr(7000)];
    const first = microcompactToolResults(msgs, fakeOps, { thresholdBytes: 1000, keepLast: 0 });
    expect(first.blocksCleared).toBe(3);
    const snapshot = msgs.map((m) => m.content);

    const second = microcompactToolResults(msgs, fakeOps, { thresholdBytes: 1000, keepLast: 0 });
    expect(second.blocksCleared).toBe(0);
    expect(second.bytesReclaimed).toBe(0);
    // Content byte-for-byte unchanged on the second pass.
    expect(msgs.map((m) => m.content)).toEqual(snapshot);
  });

  it('SIZE-ORDERED: with keepLast protecting the tail, the largest OLDER blocks are cleared first', () => {
    // Sizes ascending by position; keepLast=1 protects the last (largest).
    // The clearing order is largest-first among candidates, but the OUTCOME we
    // assert is which blocks end up cleared: all older ones above threshold.
    const msgs = [tr(2000, 'a'), tr(8000, 'b'), tr(4000, 'c'), tr(9000, 'd')];
    const r = microcompactToolResults(msgs, fakeOps, { thresholdBytes: 1000, keepLast: 1 });
    // Last (index 3, 9000) protected; the other three cleared.
    expect(r.blocksCleared).toBe(3);
    expect(isMicrocompactPlaceholder(msgs[0]!.content)).toBe(true);
    expect(isMicrocompactPlaceholder(msgs[1]!.content)).toBe(true);
    expect(isMicrocompactPlaceholder(msgs[2]!.content)).toBe(true);
    expect(msgs[3]!.content).toBe('d'.repeat(9000)); // protected tail intact
  });

  it('reports blocksScanned across cleared, kept, below-threshold, and placeholder blocks', () => {
    const msgs = [tr(500), tr(5000), tr(6000)]; // one below threshold, two large
    const r = microcompactToolResults(msgs, fakeOps, { thresholdBytes: 1000, keepLast: 1 });
    expect(r.blocksScanned).toBe(3);
    // keepLast=1 protects the last (6000); only the 5000 (>= threshold, older) clears.
    expect(r.blocksCleared).toBe(1);
  });

  it('uses the documented defaults when options are omitted', () => {
    // A block just above the default threshold, with no keepLast protection
    // possible for a single block (default keepLast=4 protects it) → no-op.
    const single = [tr(DEFAULT_MICROCOMPACT_TOOL_RESULT_BYTES + 100)];
    const rSingle = microcompactToolResults(single, fakeOps);
    expect(rSingle.blocksCleared).toBe(0); // protected by default keepLast (4)

    // With more blocks than the default keepLast, older large ones clear.
    const many = [
      tr(DEFAULT_MICROCOMPACT_TOOL_RESULT_BYTES + 100, 'a'),
      tr(DEFAULT_MICROCOMPACT_TOOL_RESULT_BYTES + 100, 'b'),
      tr(DEFAULT_MICROCOMPACT_TOOL_RESULT_BYTES + 100, 'c'),
      tr(DEFAULT_MICROCOMPACT_TOOL_RESULT_BYTES + 100, 'd'),
      tr(DEFAULT_MICROCOMPACT_TOOL_RESULT_BYTES + 100, 'e'),
    ];
    const rMany = microcompactToolResults(many, fakeOps);
    // 5 blocks, default keepLast=4 → exactly the oldest 1 clears.
    expect(DEFAULT_MICROCOMPACT_KEEP_LAST).toBe(4);
    expect(rMany.blocksCleared).toBe(1);
    expect(isMicrocompactPlaceholder(many[0]!.content)).toBe(true);
  });
});

describe('resolveMicrocompactOptions', () => {
  it('falls back to defaults for undefined/empty/invalid input', () => {
    for (const [b, k] of [
      [undefined, undefined],
      ['', ''],
      ['abc', 'xyz'],
      ['0', '-1'], // bytes must be >= 1; keepLast must be >= 0
    ] as Array<[string | undefined, string | undefined]>) {
      const r = resolveMicrocompactOptions(b, k);
      expect(r.thresholdBytes).toBe(DEFAULT_MICROCOMPACT_TOOL_RESULT_BYTES);
      expect(r.keepLast).toBe(DEFAULT_MICROCOMPACT_KEEP_LAST);
    }
  });

  it('accepts a valid integer byte threshold', () => {
    expect(resolveMicrocompactOptions('4096', undefined).thresholdBytes).toBe(4096);
    expect(resolveMicrocompactOptions('1', undefined).thresholdBytes).toBe(1);
  });

  it('accepts a valid keepLast including 0 (protect nothing)', () => {
    expect(resolveMicrocompactOptions(undefined, '0').keepLast).toBe(0);
    expect(resolveMicrocompactOptions(undefined, '2').keepLast).toBe(2);
  });
});
