/**
 * Tests for `improve/propose/template-engine.ts`.
 *
 * Coverage:
 *   - Every FailurePattern has a template (no missing entries).
 *   - Proposal output parses against ImprovementProposalSchema.
 *   - evidenceRefs are built from card.evidence one-to-one.
 *   - Pattern-specific hypothesis text incorporates card.detail fields.
 *   - scopeFreeze.forbiddenPaths is populated from DEFAULT_FORBIDDEN_PATH_GLOBS.
 *   - riskLevel derivation: floor + worst likelyFiles tier.
 *   - requiresExplicitApproval true iff riskLevel = 'high'.
 *   - generatedBy is always 'template'.
 *   - status is always 'draft'.
 *   - deriveRiskLevel boundary tests (all 4 tiers × 3 floors).
 *   - Unknown pattern → throws.
 */

import { describe, it, expect } from 'vitest';
import {
  proposeFromCard,
  deriveRiskLevel,
  type TemplateContext,
} from './template-engine.js';
import {
  DEFAULT_FORBIDDEN_PATH_GLOBS,
  type FailureCard,
  FailurePatternSchema,
  ImprovementProposalSchema,
  type LikelyFile,
  type Severity,
} from '../schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = () => new Date('2026-05-24T19:30:00.000Z');

function makeCard(overrides: Partial<FailureCard> = {}): FailureCard {
  return {
    schemaVersion: 1,
    slug: 'repeated-tool-grep-aabbccddeeff',
    title: "'grep' tool repeated 4× with identical fingerprint",
    pattern: 'repeated-tool-use',
    severity: 'medium',
    status: 'open',
    firstSeen: '2026-05-22T10:00:00.000Z',
    lastSeen: '2026-05-22T10:00:00.000Z',
    occurrenceCount: 1,
    sightingCount: 0,
    evidence: [
      {
        sessionId: 'sess-A',
        tracePath: 'state/witness/sess-A/trace.jsonl',
        eventIndices: [10, 12, 14, 16],
        excerpt: '{"kind":"tool_call"}',
        annotation: '4× grep in root context',
      },
    ],
    detail: {
      detector: 'repeated-tool-use@v1',
      toolName: 'grep',
      runLength: 4,
      fingerprint: 'aa' + 'b'.repeat(62),
      agentContext: 'root',
    },
    notes: [],
    ...overrides,
  };
}

const CTX: TemplateContext = { proposalId: 'test-proposal-id', now: FIXED_NOW };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proposeFromCard — coverage', () => {
  it('has a template for every value in FailurePatternSchema', () => {
    for (const pattern of FailurePatternSchema.options) {
      const card = makeCard({ pattern, slug: 'test-slug', detail: {} });
      expect(() => proposeFromCard(card, CTX)).not.toThrow();
    }
  });

  it('produces a proposal that parses against the schema', () => {
    const proposal = proposeFromCard(makeCard(), CTX);
    expect(ImprovementProposalSchema.safeParse(proposal).success).toBe(true);
  });

  it('always sets generatedBy = template, status = draft', () => {
    for (const pattern of FailurePatternSchema.options) {
      const proposal = proposeFromCard(makeCard({ pattern, detail: {} }), CTX);
      expect(proposal.generatedBy).toBe('template');
      expect(proposal.status).toBe('draft');
    }
  });

  it('populates scopeFreeze.forbiddenPaths from the canonical list', () => {
    const proposal = proposeFromCard(makeCard(), CTX);
    expect(proposal.scopeFreeze.forbiddenPaths).toEqual([...DEFAULT_FORBIDDEN_PATH_GLOBS]);
  });

  it('uses the supplied proposalId and now()', () => {
    const proposal = proposeFromCard(makeCard(), { proposalId: 'my-id', now: FIXED_NOW });
    expect(proposal.proposalId).toBe('my-id');
    expect(proposal.createdAt).toBe('2026-05-24T19:30:00.000Z');
  });
});

describe('proposeFromCard — evidence refs', () => {
  it('builds one evidenceRef per card evidence row', () => {
    const card = makeCard({
      evidence: [
        {
          sessionId: 's1',
          tracePath: 'p1',
          eventIndices: [1, 2, 3],
          excerpt: 'x',
          annotation: 'a1',
        },
        {
          sessionId: 's2',
          tracePath: 'p2',
          eventIndices: [4],
          excerpt: 'y',
        },
      ],
    });
    const proposal = proposeFromCard(card, CTX);
    expect(proposal.evidenceRefs).toHaveLength(2);
    expect(proposal.evidenceRefs[0]?.cardSlug).toBe(card.slug);
    expect(proposal.evidenceRefs[0]?.eventIndices).toEqual([1, 2, 3]);
    expect(proposal.evidenceRefs[0]?.annotation).toBe('a1');
    expect(proposal.evidenceRefs[1]?.eventIndices).toEqual([4]);
    expect(proposal.evidenceRefs[1]?.annotation).toBeUndefined();
  });
});

describe('proposeFromCard — pattern-specific content', () => {
  it('repeated-tool-use hypothesis names the tool and run length', () => {
    const proposal = proposeFromCard(makeCard(), CTX);
    expect(proposal.hypothesis).toContain("'grep'");
    expect(proposal.hypothesis).toContain('4');
    expect(proposal.rootCauseClass).toBe('dispatcher-bug');
  });

  it('subagent-block hypothesis names block count and reason', () => {
    const card = makeCard({
      pattern: 'subagent-block',
      slug: 'subagent-block-abc123def456',
      detail: {
        detector: 'subagent-block@v1',
        reason: 'forge gate is closed',
        blockCount: 5,
        distinctSessions: 2,
      },
    });
    const proposal = proposeFromCard(card, CTX);
    expect(proposal.hypothesis).toContain('5');
    expect(proposal.hypothesis).toContain('2');
    expect(proposal.hypothesis).toContain('forge gate is closed');
    expect(proposal.rootCauseClass).toBe('hook-overreach');
  });

  it('closure-anomaly hypothesis names the reason', () => {
    const card = makeCard({
      pattern: 'closure-anomaly',
      slug: 'closure-anomaly-budget-exceeded',
      detail: {
        detector: 'closure-anomaly@v1',
        closureReason: 'budget_exceeded',
        affectedSessions: 3,
        totalCostUsd: 4.5,
      },
    });
    const proposal = proposeFromCard(card, CTX);
    expect(proposal.hypothesis).toContain('budget_exceeded');
    expect(proposal.hypothesis).toContain('3');
    expect(proposal.fixSketch).toContain('budget_exceeded');
  });

  it('closure-anomaly fix sketch carries reason-specific advice', () => {
    // budget_exceeded vs timeout produce different advice
    const budget = proposeFromCard(
      makeCard({
        pattern: 'closure-anomaly',
        detail: { closureReason: 'budget_exceeded', affectedSessions: 1, totalCostUsd: 1 },
      }),
      CTX,
    );
    const timeout = proposeFromCard(
      makeCard({
        pattern: 'closure-anomaly',
        detail: { closureReason: 'timeout', affectedSessions: 1, totalCostUsd: 0 },
      }),
      CTX,
    );
    expect(budget.fixSketch).toContain('AFK_MAX_BUDGET_USD');
    expect(timeout.fixSketch).toContain('wall-clock cap');
    expect(budget.fixSketch).not.toEqual(timeout.fixSketch);
  });
});

describe('deriveRiskLevel', () => {
  // Compact matrix of (floor, fileTier) → expected risk.
  const cases: Array<{ floor: Severity; files: LikelyFile[]; expected: Severity }> = [
    // All safe files → floor wins
    { floor: 'low', files: file('safe'), expected: 'low' },
    { floor: 'medium', files: file('safe'), expected: 'medium' },
    { floor: 'high', files: file('safe'), expected: 'high' },
    // moderate → max(floor, medium)
    { floor: 'low', files: file('moderate'), expected: 'medium' },
    { floor: 'medium', files: file('moderate'), expected: 'medium' },
    { floor: 'high', files: file('moderate'), expected: 'high' },
    // high → high
    { floor: 'low', files: file('high'), expected: 'high' },
    { floor: 'medium', files: file('high'), expected: 'high' },
    { floor: 'high', files: file('high'), expected: 'high' },
    // forbidden → high
    { floor: 'low', files: file('forbidden'), expected: 'high' },
    { floor: 'medium', files: file('forbidden'), expected: 'high' },
    // mixed files: worst tier wins
    {
      floor: 'low',
      files: [...file('safe'), ...file('high')],
      expected: 'high',
    },
    // empty file list → floor
    { floor: 'medium', files: [], expected: 'medium' },
  ];

  for (const c of cases) {
    it(`floor=${c.floor} + files=[${c.files.map((f) => f.riskTier).join(',')}] → ${c.expected}`, () => {
      expect(deriveRiskLevel(c.floor, c.files)).toBe(c.expected);
    });
  }

  function file(tier: 'safe' | 'moderate' | 'high' | 'forbidden'): LikelyFile[] {
    return [{ path: 'p', rationale: 'r', riskTier: tier, confidence: 'low' }];
  }
});

describe('proposeFromCard — tool-failure-density integration', () => {
  function makeToolFailureCard(overrides: Partial<FailureCard> = {}): FailureCard {
    return {
      schemaVersion: 1,
      slug: 'tool-failure-read-file-aabbccdd1122',
      title: "'read_file' tool failed 6/20 calls (30.0%)",
      pattern: 'tool-failure-density',
      severity: 'medium',
      status: 'open',
      firstSeen: '2026-05-22T10:00:00.000Z',
      lastSeen: '2026-05-22T10:00:00.000Z',
      occurrenceCount: 1,
      evidence: [
        {
          sessionId: 'sess-abc',
          tracePath: 'state/witness/sess-abc/trace.jsonl',
          eventIndices: [1, 2, 3, 4, 5, 6],
          excerpt: '{"kind":"tool_call","payload":{"isError":true}}',
          annotation: 'isError=true · class=permission denied reading file',
        },
      ],
      detail: {
        detector: 'tool-failure-density@v2',
        toolName: 'read_file',
        totalCalls: 20,
        failureCount: 6,
        failureRate: 0.3,
        truncatedFailureCount: 0,
        affectedSessionCount: 2,
        avgFailureDurationMs: 120,
        failureClassBreakdown: { 'permission denied reading file': 5, 'enoent no such file': 1 },
        excludedByClass: {},
        sessionIds: ['sess-abc', 'sess-def'],
        seqs: [1, 2, 3, 4, 5, 6],
      },
      notes: [],
      ...overrides,
    };
  }

  it('derives rootCauseClass from failureClassBreakdown dominant key', () => {
    const proposal = proposeFromCard(makeToolFailureCard(), CTX);
    // 'permission denied reading file' → rootCauseFromClusterKey → 'hook-overreach'
    expect(proposal.rootCauseClass).toBe('hook-overreach');
    expect(proposal.rootCauseClass).not.toBe('unknown');
  });

  it('uses hyphenated handler path in likelyFiles[0] (Fix 2)', () => {
    const proposal = proposeFromCard(makeToolFailureCard(), CTX);
    // read_file → read-file.ts (underscores converted to hyphens)
    expect(proposal.likelyFiles[0]?.path).toContain('read-file.ts');
    expect(proposal.likelyFiles[0]?.path).not.toContain('read_file.ts');
  });

  it('handler file has confidence medium not high (Fix 3)', () => {
    const proposal = proposeFromCard(makeToolFailureCard(), CTX);
    expect(proposal.likelyFiles[0]?.confidence).toBe('medium');
  });

  it('falls back to template.rootCauseClass when failureClassBreakdown is absent', () => {
    const card = makeToolFailureCard();
    // Remove the breakdown entirely
    const detail = { ...card.detail };
    delete (detail as Record<string, unknown>)['failureClassBreakdown'];
    const proposal = proposeFromCard({ ...card, detail }, CTX);
    // toolFailureDensityTemplate.rootCauseClass is 'unknown'
    expect(proposal.rootCauseClass).toBe('unknown');
  });

  it('falls back to template.rootCauseClass when failureClassBreakdown is empty', () => {
    const card = makeToolFailureCard({
      detail: { ...makeToolFailureCard().detail, failureClassBreakdown: {} },
    });
    const proposal = proposeFromCard(card, CTX);
    expect(proposal.rootCauseClass).toBe('unknown');
  });
});

describe('proposeFromCard — risk + approval gating', () => {
  it('marks requiresExplicitApproval=true when riskLevel=high', () => {
    // subagent-block has a file with riskTier='high' → forces riskLevel='high'.
    const card = makeCard({
      pattern: 'subagent-block',
      detail: { reason: 'x', blockCount: 2, distinctSessions: 1 },
    });
    const proposal = proposeFromCard(card, CTX);
    expect(proposal.riskLevel).toBe('high');
    expect(proposal.scopeFreeze.requiresExplicitApproval).toBe(true);
  });
});
