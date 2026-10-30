/**
 * Tests for turn-provenance.ts:
 *   - Factory helpers return correct shapes.
 *   - Zod schemas accept valid / reject invalid payloads.
 *
 * @module agent/turn-provenance.test
 */

import { describe, it, expect } from 'vitest';
import {
  humanTurnProvenance,
  autoResumeTurnProvenance,
  scheduledTurnProvenance,
  TurnOriginSchema,
  TurnProvenanceSchema,
  type TurnProvenance,
  type TurnOrigin,
} from './turn-provenance.js';

// ── Factory return shapes ───────────────────────────────────────────────────

describe('humanTurnProvenance', () => {
  it('returns origin "human" with peerInfluenced false', () => {
    const p = humanTurnProvenance();
    expect(p).toEqual({ origin: 'human', peerInfluenced: false });
  });

  it('returns a fresh object on every call', () => {
    expect(humanTurnProvenance()).not.toBe(humanTurnProvenance());
  });
});

describe('autoResumeTurnProvenance', () => {
  it('bgResultPending=true → origin "background"', () => {
    const p = autoResumeTurnProvenance(true);
    expect(p.origin).toBe('background');
    expect(p.peerInfluenced).toBe(false);
  });

  it('bgResultPending=false → origin "peer"', () => {
    const p = autoResumeTurnProvenance(false);
    expect(p.origin).toBe('peer');
    expect(p.peerInfluenced).toBe(false);
  });
});

describe('scheduledTurnProvenance', () => {
  it('returns origin "scheduled" with peerInfluenced false', () => {
    const p = scheduledTurnProvenance();
    expect(p).toEqual({ origin: 'scheduled', peerInfluenced: false });
  });
});

// ── Zod schema: TurnOriginSchema ────────────────────────────────────────────

describe('TurnOriginSchema', () => {
  const validOrigins: TurnOrigin[] = ['human', 'peer', 'background', 'scheduled'];

  it.each(validOrigins)('accepts "%s"', (origin) => {
    expect(TurnOriginSchema.safeParse(origin).success).toBe(true);
  });

  it('rejects an unknown string', () => {
    expect(TurnOriginSchema.safeParse('daemon').success).toBe(false);
  });

  it('rejects a number', () => {
    expect(TurnOriginSchema.safeParse(42).success).toBe(false);
  });

  it('rejects null', () => {
    expect(TurnOriginSchema.safeParse(null).success).toBe(false);
  });
});

// ── Zod schema: TurnProvenanceSchema ────────────────────────────────────────

describe('TurnProvenanceSchema', () => {
  it('accepts a valid TurnProvenance object', () => {
    const valid: TurnProvenance = { origin: 'human', peerInfluenced: false };
    const result = TurnProvenanceSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(valid);
  });

  it('accepts peerInfluenced=true', () => {
    const valid: TurnProvenance = { origin: 'peer', peerInfluenced: true };
    expect(TurnProvenanceSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects missing origin', () => {
    expect(TurnProvenanceSchema.safeParse({ peerInfluenced: false }).success).toBe(false);
  });

  it('rejects missing peerInfluenced', () => {
    expect(TurnProvenanceSchema.safeParse({ origin: 'human' }).success).toBe(false);
  });

  it('rejects invalid origin value', () => {
    expect(TurnProvenanceSchema.safeParse({ origin: 'cron', peerInfluenced: false }).success).toBe(false);
  });

  it('rejects peerInfluenced as string', () => {
    expect(TurnProvenanceSchema.safeParse({ origin: 'human', peerInfluenced: 'no' }).success).toBe(false);
  });

  it('rejects empty object', () => {
    expect(TurnProvenanceSchema.safeParse({}).success).toBe(false);
  });

  it('rejects null', () => {
    expect(TurnProvenanceSchema.safeParse(null).success).toBe(false);
  });

  it('round-trips every factory output', () => {
    const factories = [humanTurnProvenance(), autoResumeTurnProvenance(true), autoResumeTurnProvenance(false), scheduledTurnProvenance()];
    for (const p of factories) {
      const result = TurnProvenanceSchema.safeParse(p);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual(p);
    }
  });
});
