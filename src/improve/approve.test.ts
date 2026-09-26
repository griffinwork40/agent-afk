/**
 * Tests for `improve/approve.ts`.
 *
 * Coverage:
 *   - Approve a draft proposal → status becomes 'approved', note appended.
 *   - Approve a draft eval-case → status becomes 'approved', note appended.
 *   - Slug resolves proposal before eval-case (priority order).
 *   - Unknown slug → ApproveError('not-found').
 *   - Already-approved proposal without --force → ApproveError('already-approved').
 *   - Already-approved eval-case without --force → ApproveError('already-approved').
 *   - --force allows re-approving an already-approved artifact.
 *   - approvedBy defaults to process.env.USER (or 'unknown').
 *   - Approval note text is deterministic.
 *   - JSON and markdown are updated on disk.
 *   - .index.jsonl gets a 'triaged' event appended.
 *   - previousStatus is correctly reported.
 *   - Non-draft proposal ('rejected') can also be approved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { approveArtifact, ApproveError } from './approve.js';
import { writeProposal, renderProposalMarkdown } from './propose/writer.js';
import { writeEvalCase } from './eval-gen/writer.js';
import { proposeFromCard } from './propose/template-engine.js';
import { writeCard } from './scan/card-writer.js';
import {
  getProposalsDir,
  getProposalsIndexPath,
  getEvalCasesDir,
  getEvalCasesIndexPath,
  getProposalJsonPath,
  getProposalMarkdownPath,
  getEvalCaseJsonPath,
  getEvalCaseMarkdownPath,
} from './paths.js';
import type { DetectorResult, FailureCard, ImprovementProposal, EvalCase } from './schemas.js';
import { ImprovementProposalSchema, EvalCaseSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Filesystem fixture
// ---------------------------------------------------------------------------

let originalAfkHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalAfkHome = process.env['AFK_HOME'];
  tempHome = mkdtempSync(join(tmpdir(), 'afk-approve-test-'));
  process.env['AFK_HOME'] = tempHome;
});

afterEach(() => {
  if (originalAfkHome === undefined) {
    delete process.env['AFK_HOME'];
  } else {
    process.env['AFK_HOME'] = originalAfkHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CARD_SLUG = 'repeated-tool-grep-aabbccddeeff';
const FIXED_NOW = () => new Date('2026-06-01T12:00:00.000Z');

function makeCard(overrides: Partial<FailureCard> = {}): FailureCard {
  return {
    schemaVersion: 1,
    slug: CARD_SLUG,
    title: "'grep' repeated 4×",
    pattern: 'repeated-tool-use',
    severity: 'medium',
    status: 'open',
    firstSeen: '2026-05-22T10:00:00.000Z',
    lastSeen: '2026-05-22T10:00:00.000Z',
    occurrenceCount: 1,
    evidence: [
      {
        sessionId: 'sess-A',
        tracePath: 'state/witness/sess-A/trace.jsonl',
        eventIndices: [10, 12, 14, 16],
        excerpt: '{"kind":"tool_call"}',
      },
    ],
    detail: { detector: 'repeated-tool-use@v1', toolName: 'grep', runLength: 4 },
    notes: [],
    ...overrides,
  };
}

function seedProposal(
  overrides: Partial<ImprovementProposal> = {},
  proposalId = 'test-prop-20260601-aabbcc',
): ImprovementProposal {
  const card = makeCard();
  // writeCard is needed so getProposalsForCard can find the card during seeding
  const detection: DetectorResult = {
    slug: card.slug,
    title: card.title,
    pattern: card.pattern,
    severity: card.severity,
    observedAt: card.firstSeen,
    evidence: card.evidence,
    detail: card.detail,
  };
  writeCard(detection);
  const base = proposeFromCard(card, { proposalId, now: FIXED_NOW });
  const proposal = { ...base, ...overrides };
  writeProposal(proposal);
  return proposal;
}

function seedEvalCase(
  overrides: Partial<EvalCase> = {},
  evalCaseId = 'repeated-tool-grep-aabbccddeeff-eval-20260601-cc1122',
): EvalCase {
  // Build a minimal valid EvalCase inline — avoids the need for a real trace file.
  const ec: EvalCase = EvalCaseSchema.parse({
    schemaVersion: 1,
    evalCaseId,
    cardSlug: CARD_SLUG,
    proposalId: null,
    title: 'Replay [pattern-absent]: grep repeated 4× (through seq 16)',
    createdAt: '2026-06-01T12:00:00.000Z',
    kind: 'replay',
    replay: {
      sourceSessionId: 'sess-A',
      sourceTracePath: 'state/witness/sess-A/trace.jsonl',
      fixturePath: `agent-framework/improve/eval-cases/${evalCaseId}.fixture.jsonl`,
      evidenceRowIndex: 0,
      evidenceEventIndices: [10, 12, 14, 16],
      sliceLineRange: { startLine: 1, endLine: 16 },
      sliceLineCount: 16,
      sliceSha256: 'a'.repeat(64),
    },
    assertion: {
      kind: 'pattern-absent',
      patternId: 'repeated-tool-use',
      detectorVersion: 'repeated-tool-use@v1',
      rationale: 'After fix, pattern must be absent.',
    },
    provenance: {
      detectorAtGeneration: 'repeated-tool-use@v1',
      fingerprintAtGeneration: null,
      cardOccurrenceCountAtGeneration: 1,
      cardLastSeenAtGeneration: '2026-05-22T10:00:00.000Z',
      generatedBy: 'replay-fixture',
    },
    status: 'draft',
    notes: [],
    ...overrides,
  });

  // Write directly without the fixture checksum verification (test only).
  const dir = getEvalCasesDir();
  const { mkdirSync, writeFileSync } = require('fs');
  if (!require('fs').existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getEvalCaseJsonPath(evalCaseId), JSON.stringify(ec, null, 2), 'utf-8');
  writeFileSync(getEvalCaseMarkdownPath(evalCaseId), 'placeholder', 'utf-8');
  return ec;
}

// ---------------------------------------------------------------------------
// Happy-path: proposal approval
// ---------------------------------------------------------------------------

describe('approveArtifact — proposal', () => {
  it('transitions a draft proposal to approved', () => {
    const proposal = seedProposal();
    const outcome = approveArtifact(proposal.proposalId, {
      approvedBy: 'alice',
      now: FIXED_NOW,
    });

    expect(outcome.kind).toBe('proposal');
    expect(outcome.previousStatus).toBe('draft');
    expect(outcome.newStatus).toBe('approved');
    expect(outcome.approvedBy).toBe('alice');
    expect(outcome.approvedAt).toBe('2026-06-01T12:00:00.000Z');
  });

  it('appends an approval note to the proposal', () => {
    const proposal = seedProposal();
    approveArtifact(proposal.proposalId, { approvedBy: 'bob', now: FIXED_NOW });

    const raw = readFileSync(getProposalJsonPath(proposal.proposalId), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe('approved');
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0].text).toBe('Approved by bob.');
    expect(parsed.notes[0].at).toBe('2026-06-01T12:00:00.000Z');
  });

  it('preserves prior notes when appending approval note', () => {
    const existingNote = { at: '2026-05-30T10:00:00.000Z', text: 'Looks good' };
    const proposal = seedProposal({ notes: [existingNote] });
    approveArtifact(proposal.proposalId, { approvedBy: 'carol', now: FIXED_NOW });

    const raw = readFileSync(getProposalJsonPath(proposal.proposalId), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.notes).toHaveLength(2);
    expect(parsed.notes[0].text).toBe('Looks good');
    expect(parsed.notes[1].text).toBe('Approved by carol.');
  });

  it('writes updated markdown to disk', () => {
    const proposal = seedProposal();
    approveArtifact(proposal.proposalId, { approvedBy: 'dave', now: FIXED_NOW });

    const md = readFileSync(getProposalMarkdownPath(proposal.proposalId), 'utf-8');
    expect(md).toContain('approved');
    expect(md).toContain('Approved by dave.');
  });

  it('appends a triaged event to the proposals .index.jsonl', () => {
    const proposal = seedProposal();
    approveArtifact(proposal.proposalId, { approvedBy: 'eve', now: FIXED_NOW });

    const indexPath = getProposalsIndexPath();
    expect(existsSync(indexPath)).toBe(true);
    const lines = readFileSync(indexPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const triaged = lines.filter((l) => l.event === 'triaged');
    expect(triaged).toHaveLength(1);
    expect(triaged[0].proposalId).toBe(proposal.proposalId);
  });

  it('returns the correct file paths', () => {
    const proposal = seedProposal();
    const outcome = approveArtifact(proposal.proposalId, { approvedBy: 'frank', now: FIXED_NOW });
    expect(outcome.jsonPath).toBe(getProposalJsonPath(proposal.proposalId));
    expect(outcome.markdownPath).toBe(getProposalMarkdownPath(proposal.proposalId));
  });

  it('can approve a rejected proposal', () => {
    const proposal = seedProposal({ status: 'rejected' });
    const outcome = approveArtifact(proposal.proposalId, { approvedBy: 'grace', now: FIXED_NOW });
    expect(outcome.previousStatus).toBe('rejected');
    expect(outcome.newStatus).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Happy-path: eval-case approval
// ---------------------------------------------------------------------------

describe('approveArtifact — eval-case', () => {
  it('transitions a draft eval-case to approved', () => {
    const ec = seedEvalCase();
    const outcome = approveArtifact(ec.evalCaseId, {
      approvedBy: 'alice',
      now: FIXED_NOW,
    });

    expect(outcome.kind).toBe('eval-case');
    expect(outcome.previousStatus).toBe('draft');
    expect(outcome.newStatus).toBe('approved');
    expect(outcome.approvedBy).toBe('alice');
    expect(outcome.slug).toBe(ec.evalCaseId);
  });

  it('persists approved status and note to disk', () => {
    const ec = seedEvalCase();
    approveArtifact(ec.evalCaseId, { approvedBy: 'bob', now: FIXED_NOW });

    const raw = readFileSync(getEvalCaseJsonPath(ec.evalCaseId), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe('approved');
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0].text).toBe('Approved by bob.');
  });

  it('appends a triaged event to the eval-cases .index.jsonl', () => {
    const ec = seedEvalCase();
    approveArtifact(ec.evalCaseId, { approvedBy: 'carol', now: FIXED_NOW });

    const indexPath = getEvalCasesIndexPath();
    expect(existsSync(indexPath)).toBe(true);
    const lines = readFileSync(indexPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const triaged = lines.filter((l) => l.event === 'triaged');
    expect(triaged).toHaveLength(1);
    expect(triaged[0].evalCaseId).toBe(ec.evalCaseId);
  });

  it('returns the correct file paths', () => {
    const ec = seedEvalCase();
    const outcome = approveArtifact(ec.evalCaseId, { approvedBy: 'dave', now: FIXED_NOW });
    expect(outcome.jsonPath).toBe(getEvalCaseJsonPath(ec.evalCaseId));
    expect(outcome.markdownPath).toBe(getEvalCaseMarkdownPath(ec.evalCaseId));
  });
});

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

describe('approveArtifact — slug resolution order', () => {
  it('resolves proposal before eval-case when both exist with the same id (edge case guard)', () => {
    // In practice slugs are distinct (proposals have no -eval- infix), but
    // the guard ensures determinism if slugs ever collide.
    const proposalId = 'shared-slug-20260601-aabb00';
    const proposal = seedProposal({}, proposalId);
    // Seed an eval-case with the same slug id.
    seedEvalCase({}, proposalId);

    const outcome = approveArtifact(proposalId, { approvedBy: 'test', now: FIXED_NOW });
    expect(outcome.kind).toBe('proposal');
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('approveArtifact — error paths', () => {
  it('throws not-found for an unknown slug', () => {
    expect(() => approveArtifact('does-not-exist-20260601-aabbcc')).toThrow(ApproveError);
    try {
      approveArtifact('does-not-exist-20260601-aabbcc');
    } catch (err) {
      expect((err as ApproveError).code).toBe('not-found');
    }
  });

  it('throws already-approved for a proposal without --force', () => {
    const proposal = seedProposal({ status: 'approved' });
    try {
      approveArtifact(proposal.proposalId, { approvedBy: 'alice', now: FIXED_NOW });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApproveError);
      expect((err as ApproveError).code).toBe('already-approved');
    }
  });

  it('throws already-approved for an eval-case without --force', () => {
    const ec = seedEvalCase({ status: 'approved' });
    try {
      approveArtifact(ec.evalCaseId, { approvedBy: 'alice', now: FIXED_NOW });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApproveError);
      expect((err as ApproveError).code).toBe('already-approved');
    }
  });

  it('allows re-approve with --force on a proposal', () => {
    const proposal = seedProposal({ status: 'approved', notes: [{ at: '2026-05-30T00:00:00.000Z', text: 'First approval.' }] });
    const outcome = approveArtifact(proposal.proposalId, {
      approvedBy: 'updated-approver',
      now: FIXED_NOW,
      force: true,
    });
    expect(outcome.previousStatus).toBe('approved');
    expect(outcome.newStatus).toBe('approved');

    const raw = readFileSync(getProposalJsonPath(proposal.proposalId), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.notes).toHaveLength(2);
    expect(parsed.notes[1].text).toBe('Approved by updated-approver.');
  });

  it('allows re-approve with --force on an eval-case', () => {
    const ec = seedEvalCase({ status: 'approved' });
    const outcome = approveArtifact(ec.evalCaseId, {
      approvedBy: 'second-approver',
      now: FIXED_NOW,
      force: true,
    });
    expect(outcome.newStatus).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// approvedBy default
// ---------------------------------------------------------------------------

describe('approveArtifact — approvedBy default', () => {
  it('falls back to process.env.USER when approvedBy is omitted', () => {
    const original = process.env['USER'];
    process.env['USER'] = 'test-user';
    try {
      const proposal = seedProposal();
      approveArtifact(proposal.proposalId, { now: FIXED_NOW });

      const raw = readFileSync(getProposalJsonPath(proposal.proposalId), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.notes[0].text).toBe('Approved by test-user.');
    } finally {
      if (original === undefined) {
        delete process.env['USER'];
      } else {
        process.env['USER'] = original;
      }
    }
  });

  it('falls back to "unknown" when neither USER nor USERNAME is set', () => {
    const origUser = process.env['USER'];
    const origUsername = process.env['USERNAME'];
    delete process.env['USER'];
    delete process.env['USERNAME'];
    try {
      const proposal = seedProposal();
      approveArtifact(proposal.proposalId, { now: FIXED_NOW });

      const raw = readFileSync(getProposalJsonPath(proposal.proposalId), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.notes[0].text).toBe('Approved by unknown.');
    } finally {
      if (origUser !== undefined) process.env['USER'] = origUser;
      if (origUsername !== undefined) process.env['USERNAME'] = origUsername;
    }
  });
});
