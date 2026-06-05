/**
 * Tests for the SIGNAL block parser.
 *
 * Pins the v0 passive-observation contract:
 *   - Extraction is KEY-SCOPED, not positional. A `signal` key wins by name,
 *     not by being the last fenced block. This is the critical difference vs.
 *     `extractStructuredOutput` and lets a SIGNAL block coexist with an
 *     existing trailing `outputSchema`-driven JSON block.
 *   - Missing signal → `{ ok: false, reason: 'absent' }`. No inference, no NLP.
 *   - Malformed signal (wrong shape, wrong enum, etc.) → `{ ok: false,
 *     reason: 'malformed' }` — distinct from absent so observers can tell
 *     "didn't try" from "tried wrong".
 *   - Cohabitation: a JSON block carrying BOTH `signal` and an existing
 *     schema's keys parses fine for both consumers (Zod default strips
 *     unknown keys on the existing schema; we read `signal` by name).
 */

import { describe, it, expect } from 'vitest';
import {
  extractSignalBlock,
  parseSignal,
  SignalBlockSchema,
} from './signal-block.js';

const VALID_SIGNAL_PAYLOAD = {
  signal: {
    issue: 'race-in-cache-eviction',
    stance: 'supports',
    confidence: 0.82,
    evidence: ['src/cache/lru.ts:142', 'src/cache/lru.test.ts:88'],
    claim: 'The eviction path races with concurrent reads under load.',
  },
};

function fenced(body: unknown): string {
  return '```json\n' + JSON.stringify(body, null, 2) + '\n```';
}

describe('extractSignalBlock', () => {
  describe('finds signal by key, not by position', () => {
    it('returns the signal-bearing block when it is the only fence', () => {
      const content = 'Investigating cache.\n\n' + fenced(VALID_SIGNAL_PAYLOAD);
      expect(extractSignalBlock(content)).toEqual(VALID_SIGNAL_PAYLOAD);
    });

    it('returns the signal-bearing block even when a later schema block exists', () => {
      // This is the core invariant: positional extractors would pick the
      // second block; we pick by key.
      const content = [
        'preamble',
        fenced(VALID_SIGNAL_PAYLOAD),
        'and the structured output:',
        fenced({ findings: [{ location: 'src/x.ts:1' }] }),
      ].join('\n');
      expect(extractSignalBlock(content)).toEqual(VALID_SIGNAL_PAYLOAD);
    });

    it('returns the signal-bearing block when it comes AFTER a schema block', () => {
      const content = [
        fenced({ status: 'PASS', issues: [] }),
        '',
        fenced(VALID_SIGNAL_PAYLOAD),
      ].join('\n');
      expect(extractSignalBlock(content)).toEqual(VALID_SIGNAL_PAYLOAD);
    });

    it('returns the first signal-bearing block when multiple exist', () => {
      // Two SIGNAL blocks: first wins. Subagents should emit exactly one, but
      // pin the tie-break behavior so it is deterministic.
      const first = {
        signal: {
          issue: 'first',
          stance: 'supports',
          confidence: 0.5,
          evidence: [],
          claim: 'first claim',
        },
      };
      const second = {
        signal: {
          issue: 'second',
          stance: 'opposes',
          confidence: 0.9,
          evidence: ['x'],
          claim: 'second claim',
        },
      };
      const content = fenced(first) + '\n\n' + fenced(second);
      expect(extractSignalBlock(content)).toEqual(first);
    });

    it('reads signal from the SAME block as another schema (cohabitation)', () => {
      // Subagents may inline `signal` alongside their existing output schema.
      // Zod's default object parse strips unknown keys, so the existing
      // schema parse is unaffected. The signal extractor finds it here.
      const cohabited = {
        status: 'PASS',
        issues: [],
        summary: 'all green',
        signal: VALID_SIGNAL_PAYLOAD.signal,
      };
      const content = 'Verify mode results:\n\n' + fenced(cohabited);
      expect(extractSignalBlock(content)).toEqual(cohabited);
    });
  });

  describe('balanced-braces fallback (no fence)', () => {
    it('parses a bare signal object in prose', () => {
      const content = 'Conclusion: ' + JSON.stringify(VALID_SIGNAL_PAYLOAD);
      expect(extractSignalBlock(content)).toEqual(VALID_SIGNAL_PAYLOAD);
    });

    it('skips non-signal balanced objects and finds the signal one', () => {
      const content = [
        'first {"unrelated": true}',
        'then ' + JSON.stringify(VALID_SIGNAL_PAYLOAD),
      ].join('\n');
      expect(extractSignalBlock(content)).toEqual(VALID_SIGNAL_PAYLOAD);
    });

    it('handles braces inside string literals correctly', () => {
      const payload = {
        signal: {
          issue: 'has-{-and-}-inside',
          stance: 'uncertain',
          confidence: 0.3,
          evidence: ['note with { and } in it'],
          claim: 'a claim',
        },
      };
      const content = 'See: ' + JSON.stringify(payload);
      expect(extractSignalBlock(content)).toEqual(payload);
    });
  });

  describe('absent / unparseable', () => {
    it('returns undefined for empty content', () => {
      expect(extractSignalBlock('')).toBeUndefined();
    });

    it('returns undefined when no JSON is present', () => {
      expect(extractSignalBlock('just prose, no signal here.')).toBeUndefined();
    });

    it('returns undefined when JSON has no signal key', () => {
      const content = fenced({ findings: [], summary: 'nothing' });
      expect(extractSignalBlock(content)).toBeUndefined();
    });

    it('returns undefined when the fence is malformed JSON', () => {
      const content = '```json\n{ not really json }\n```';
      expect(extractSignalBlock(content)).toBeUndefined();
    });

    it('returns undefined for an array root even if it contains signal-like items', () => {
      // The convention requires `signal` as a TOP-LEVEL key on an object.
      // An array root is not a valid envelope.
      const content = fenced([VALID_SIGNAL_PAYLOAD]);
      expect(extractSignalBlock(content)).toBeUndefined();
    });
  });
});

describe('parseSignal', () => {
  describe('ok results', () => {
    it('returns ok with the validated payload', () => {
      const content = 'analysis...\n\n' + fenced(VALID_SIGNAL_PAYLOAD);
      const result = parseSignal(content);
      expect(result).toEqual({ ok: true, signal: VALID_SIGNAL_PAYLOAD.signal });
    });

    it('accepts an empty evidence array (v0 records it; observer surfaces)', () => {
      const payload = {
        signal: {
          issue: 'untested-hunch',
          stance: 'uncertain',
          confidence: 0.4,
          evidence: [],
          claim: 'gut feeling, no evidence yet',
        },
      };
      const result = parseSignal(fenced(payload));
      expect(result).toEqual({ ok: true, signal: payload.signal });
    });

    it('accepts every valid stance enum value', () => {
      for (const stance of ['supports', 'opposes', 'uncertain', 'blocks'] as const) {
        const payload = {
          signal: {
            issue: 'i',
            stance,
            confidence: 0.5,
            evidence: ['src/x.ts:1'],
            claim: 'c',
          },
        };
        const result = parseSignal(fenced(payload));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.signal.stance).toBe(stance);
      }
    });

    it('accepts confidence at the inclusive bounds 0 and 1', () => {
      for (const confidence of [0, 1]) {
        const payload = {
          signal: {
            issue: 'i',
            stance: 'supports',
            confidence,
            evidence: [],
            claim: 'c',
          },
        };
        const result = parseSignal(fenced(payload));
        expect(result.ok).toBe(true);
      }
    });
  });

  describe('absent', () => {
    it('returns absent when no signal block exists', () => {
      const result = parseSignal('Final answer: 42.');
      expect(result).toEqual({ ok: false, reason: 'absent' });
    });

    it('returns absent when JSON blocks exist but none have a signal key', () => {
      const content = fenced({ findings: [], summary: 'x' });
      expect(parseSignal(content)).toEqual({ ok: false, reason: 'absent' });
    });

    it('returns absent for empty input', () => {
      expect(parseSignal('')).toEqual({ ok: false, reason: 'absent' });
    });
  });

  describe('malformed', () => {
    it('returns malformed when signal is missing required fields', () => {
      const content = fenced({ signal: { issue: 'x' } });
      expect(parseSignal(content)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('returns malformed when stance is not in the enum', () => {
      const content = fenced({
        signal: {
          issue: 'i',
          stance: 'maybe',
          confidence: 0.5,
          evidence: [],
          claim: 'c',
        },
      });
      expect(parseSignal(content)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('returns malformed when confidence is out of [0,1]', () => {
      const content = fenced({
        signal: {
          issue: 'i',
          stance: 'supports',
          confidence: 1.5,
          evidence: [],
          claim: 'c',
        },
      });
      expect(parseSignal(content)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('returns malformed when evidence is not an array', () => {
      const content = fenced({
        signal: {
          issue: 'i',
          stance: 'supports',
          confidence: 0.5,
          evidence: 'src/x.ts:1',
          claim: 'c',
        },
      });
      expect(parseSignal(content)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('returns malformed when issue is an empty string', () => {
      const content = fenced({
        signal: {
          issue: '',
          stance: 'supports',
          confidence: 0.5,
          evidence: [],
          claim: 'c',
        },
      });
      expect(parseSignal(content)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('returns malformed when claim is an empty string', () => {
      const content = fenced({
        signal: {
          issue: 'i',
          stance: 'supports',
          confidence: 0.5,
          evidence: [],
          claim: '',
        },
      });
      expect(parseSignal(content)).toEqual({ ok: false, reason: 'malformed' });
    });
  });
});

describe('SignalBlockSchema', () => {
  it('strips unknown sibling keys on the envelope (passthrough at root, strict at signal)', () => {
    // The envelope uses .passthrough() so it parses cleanly when the signal
    // is inlined into another schema's block (the cohabitation case).
    const parsed = SignalBlockSchema.safeParse({
      ...VALID_SIGNAL_PAYLOAD,
      status: 'PASS',
      issues: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.signal).toEqual(VALID_SIGNAL_PAYLOAD.signal);
    }
  });
});
