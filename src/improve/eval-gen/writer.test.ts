/**
 * Tests for `improve/eval-gen/writer.ts`.
 *
 * Coverage:
 *   - generateEvalCaseId: format + injection seams + invalid suffix rejection.
 *   - buildEvalCase: pure builder; slice runs through max(eventIndices);
 *     fingerprint extraction (present and absent); proposalId default null;
 *     evidence row index out of range; respects resolveTraceAbsPath seam.
 *   - writeEvalCase: writes JSON + fixture + md atomically;
 *     fixture bytes == bytes argument; sha256 stored in JSON matches file;
 *     .index.jsonl append per write; honours `proposalId` in the index event.
 *   - listEvalCases / getEvalCase / getEvalCasesForCard / getEvalCasesForProposal.
 *   - Markdown renderer: stable, contains disclaimer, renders all sections.
 *   - Sprint 3 deferred behaviour: writeEvalCase does NOT touch any
 *     proposal JSON even when proposalId is set.
 *   - Schema rejects invalid sliceSha256 and out-of-range proposalId regex.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildEvalCase,
  generateEvalCaseId,
  getEvalCase,
  getEvalCasesForCard,
  getEvalCasesForProposal,
  listEvalCases,
  renderEvalCaseMarkdown,
  writeEvalCase,
} from './writer.js';
import { sha256Bytes } from './replay-fixture.js';
import {
  EvalCaseSchema,
  type EvalCase,
  type FailureCard,
} from '../schemas.js';
import {
  getEvalCaseFixturePath,
  getEvalCaseJsonPath,
  getEvalCaseMarkdownPath,
  getEvalCasesDir,
  getEvalCasesIndexPath,
  getProposalsDir,
} from '../paths.js';
import { writeProposal } from '../propose/writer.js';
import { proposeFromCard } from '../propose/template-engine.js';

// ---------------------------------------------------------------------------
// Filesystem fixture
// ---------------------------------------------------------------------------

let originalAfkHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalAfkHome = process.env['AFK_HOME'];
  tempHome = mkdtempSync(join(tmpdir(), 'afk-evalgen-test-'));
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

const FIXED_NOW = () => new Date('2026-05-24T19:30:00.000Z');

/** Build a 5-line synthetic trace whose seqs are 0..4. */
function makeSyntheticTrace(): string {
  const lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    lines.push(
      JSON.stringify({
        ts: `2026-05-24T19:00:0${i}.000Z`,
        seq: i,
        kind: 'tool_call',
        payload: { phase: 'completed', name: 'grep' },
      }),
    );
  }
  return lines.join('\n') + '\n';
}

/** Write a trace to the temp `$AFK_HOME` mirroring the real witness layout. */
function writeWitnessTrace(sessionId: string, content: string): string {
  const sessionDir = join(tempHome, 'state', 'witness', sessionId);
  // mkdirSync wrapper inlined to avoid an import for a 1-line helper.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require('fs');
  mkdirSync(sessionDir, { recursive: true });
  const tracePath = join(sessionDir, 'trace.jsonl');
  writeFileSync(tracePath, content);
  return tracePath;
}

function makeCard(overrides: Partial<FailureCard> = {}): FailureCard {
  return {
    schemaVersion: 1,
    slug: 'repeated-tool-grep-abc123',
    title: "'grep' tool repeated 2× with identical fingerprint",
    pattern: 'repeated-tool-use',
    severity: 'low',
    status: 'open',
    firstSeen: '2026-05-24T19:00:00.000Z',
    lastSeen: '2026-05-24T19:00:03.000Z',
    occurrenceCount: 1,
    evidence: [
      {
        sessionId: 'sess-a',
        tracePath: 'state/witness/sess-a/trace.jsonl',
        eventIndices: [2, 3],
        excerpt: '{"seq":2,...}\n{"seq":3,...}',
      },
    ],
    detail: {
      detector: 'repeated-tool-use@v1',
      fingerprint: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
      toolName: 'grep',
      runLength: 2,
    },
    notes: [],
    ...overrides,
  };
}

/** Convenience: card + matching witness trace + buildEvalCase wrapper. */
function setupSession(opts: { sessionId?: string; cardOverrides?: Partial<FailureCard> } = {}): {
  card: FailureCard;
  tracePath: string;
} {
  const sessionId = opts.sessionId ?? 'sess-a';
  const traceContent = makeSyntheticTrace();
  writeWitnessTrace(sessionId, traceContent);
  const card = makeCard({
    evidence: [
      {
        sessionId,
        tracePath: `state/witness/${sessionId}/trace.jsonl`,
        eventIndices: [2, 3],
        excerpt: '{"seq":2,...}\n{"seq":3,...}',
      },
    ],
    ...opts.cardOverrides,
  });
  return { card, tracePath: join(tempHome, 'state', 'witness', sessionId, 'trace.jsonl') };
}

// ---------------------------------------------------------------------------
// generateEvalCaseId
// ---------------------------------------------------------------------------

describe('generateEvalCaseId', () => {
  it('produces <cardSlug>-eval-<yyyymmdd>-<6hex>', () => {
    const id = generateEvalCaseId('my-card', {
      now: FIXED_NOW,
      randomSuffix: () => 'abcdef',
    });
    expect(id).toBe('my-card-eval-20260524-abcdef');
  });

  it('uses UTC for the date', () => {
    const id = generateEvalCaseId('s', {
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      randomSuffix: () => '111111',
    });
    expect(id).toBe('s-eval-20260102-111111');
  });

  it('rejects invalid suffix (not 6 hex chars)', () => {
    expect(() =>
      generateEvalCaseId('s', { now: FIXED_NOW, randomSuffix: () => 'XYZ' }),
    ).toThrow(/6 lowercase hex chars/);
    expect(() =>
      generateEvalCaseId('s', { now: FIXED_NOW, randomSuffix: () => 'abcdefg' }),
    ).toThrow();
  });

  it('default generator returns a valid id (uses real crypto)', () => {
    const id = generateEvalCaseId('my-card');
    expect(id).toMatch(/^my-card-eval-\d{8}-[0-9a-f]{6}$/);
  });

  it('matches the schema slug regex when cardSlug does', () => {
    const id = generateEvalCaseId('a-b-c', { now: FIXED_NOW, randomSuffix: () => '000000' });
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('is mechanically distinguishable from a proposal id (no `-eval-` infix in proposals)', () => {
    const evalId = generateEvalCaseId('card-slug', {
      now: FIXED_NOW,
      randomSuffix: () => '9c4d2f',
    });
    expect(evalId).toContain('-eval-');
    expect(evalId).toBe('card-slug-eval-20260524-9c4d2f');
  });
});

// ---------------------------------------------------------------------------
// buildEvalCase
// ---------------------------------------------------------------------------

describe('buildEvalCase', () => {
  it('produces a schema-valid EvalCase that slices through max(eventIndices)', () => {
    const { card } = setupSession();
    const { evalCase, sliceBytes } = buildEvalCase(card, {
      evalCaseId: 'test-id-1',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    const validated = EvalCaseSchema.safeParse(evalCase);
    expect(validated.success).toBe(true);

    // Max eventIndex = 3 → endLine = 4.
    expect(evalCase.replay.evidenceEventIndices).toEqual([2, 3]);
    expect(evalCase.replay.sliceLineRange.endLine).toBe(4);
    expect(evalCase.replay.sliceLineCount).toBe(4);

    // sha256 in the schema matches sha256 of the returned bytes.
    expect(evalCase.replay.sliceSha256).toBe(sha256Bytes(sliceBytes));
  });

  it('defaults proposalId to null', () => {
    const { card } = setupSession();
    const { evalCase } = buildEvalCase(card, {
      evalCaseId: 'no-prop',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    expect(evalCase.proposalId).toBeNull();
  });

  it('records the supplied proposalId', () => {
    const { card } = setupSession();
    const { evalCase } = buildEvalCase(card, {
      evalCaseId: 'with-prop',
      evidenceRowIndex: 0,
      proposalId: 'card-slug-20260524-abc123',
      now: FIXED_NOW,
    });
    expect(evalCase.proposalId).toBe('card-slug-20260524-abc123');
  });

  it('extracts fingerprint from card.detail when present', () => {
    const { card } = setupSession();
    const { evalCase } = buildEvalCase(card, {
      evalCaseId: 'with-fp',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    expect(evalCase.provenance.fingerprintAtGeneration).toBe(
      'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    );
  });

  it('sets fingerprintAtGeneration to null when detail has no fingerprint (closure-anomaly shape)', () => {
    writeWitnessTrace('sess-closure', makeSyntheticTrace());
    const card = makeCard({
      slug: 'closure-anomaly-budget-exceeded',
      pattern: 'closure-anomaly',
      evidence: [
        {
          sessionId: 'sess-closure',
          tracePath: 'state/witness/sess-closure/trace.jsonl',
          eventIndices: [3],
          excerpt: '{"seq":3,...}',
        },
      ],
      detail: {
        detector: 'closure-anomaly@v1',
        closureReason: 'budget_exceeded',
        // No fingerprint field.
      },
    });

    const { evalCase } = buildEvalCase(card, {
      evalCaseId: 'no-fp',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    expect(evalCase.provenance.fingerprintAtGeneration).toBeNull();
    expect(evalCase.assertion.patternId).toBe('closure-anomaly');
  });

  it('throws evidence-row-out-of-range when index is invalid', () => {
    const { card } = setupSession();
    expect(() =>
      buildEvalCase(card, { evalCaseId: 'oor', evidenceRowIndex: 1, now: FIXED_NOW }),
    ).toThrowError(/evidence row 1 out of range/);
    expect(() =>
      buildEvalCase(card, { evalCaseId: 'oor', evidenceRowIndex: -1, now: FIXED_NOW }),
    ).toThrowError(/out of range/);
  });

  it('respects the resolveTraceAbsPath injection seam', () => {
    // Place the trace OUTSIDE the temp AFK_HOME and feed the resolver
    // a custom mapping. The slicer should follow the override.
    const externalDir = mkdtempSync(join(tmpdir(), 'afk-evalgen-external-'));
    const externalTrace = join(externalDir, 'custom-trace.jsonl');
    writeFileSync(externalTrace, makeSyntheticTrace());

    try {
      const card = makeCard({
        evidence: [
          {
            sessionId: 'sess-external',
            tracePath: 'unused-by-resolver/trace.jsonl',
            eventIndices: [1, 2],
            excerpt: '{}',
          },
        ],
      });

      const { evalCase } = buildEvalCase(card, {
        evalCaseId: 'external',
        evidenceRowIndex: 0,
        resolveTraceAbsPath: () => externalTrace,
        now: FIXED_NOW,
      });
      // Slice through seq 2 → line 3 (0-indexed seq, 1-indexed line).
      expect(evalCase.replay.sliceLineRange.endLine).toBe(3);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('captures provenance snapshot of card.occurrenceCount and lastSeen', () => {
    const { card } = setupSession({
      cardOverrides: {
        occurrenceCount: 7,
        lastSeen: '2026-05-22T10:00:00.000Z',
      },
    });
    const { evalCase } = buildEvalCase(card, {
      evalCaseId: 'prov',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    expect(evalCase.provenance.cardOccurrenceCountAtGeneration).toBe(7);
    expect(evalCase.provenance.cardLastSeenAtGeneration).toBe('2026-05-22T10:00:00.000Z');
  });

  it('handles multi-row evidence by picking the requested index (Q1 lock: one row per eval-case)', () => {
    // Two evidence rows pointing at two different sessions.
    writeWitnessTrace('sess-a', makeSyntheticTrace());
    writeWitnessTrace('sess-b', makeSyntheticTrace());
    const card = makeCard({
      occurrenceCount: 2,
      evidence: [
        {
          sessionId: 'sess-a',
          tracePath: 'state/witness/sess-a/trace.jsonl',
          eventIndices: [1, 2],
          excerpt: 'row-a',
        },
        {
          sessionId: 'sess-b',
          tracePath: 'state/witness/sess-b/trace.jsonl',
          eventIndices: [3, 4],
          excerpt: 'row-b',
        },
      ],
    });

    const rowA = buildEvalCase(card, { evalCaseId: 'a', evidenceRowIndex: 0, now: FIXED_NOW });
    const rowB = buildEvalCase(card, { evalCaseId: 'b', evidenceRowIndex: 1, now: FIXED_NOW });

    expect(rowA.evalCase.replay.sourceSessionId).toBe('sess-a');
    expect(rowA.evalCase.replay.evidenceRowIndex).toBe(0);
    expect(rowA.evalCase.replay.sliceLineRange.endLine).toBe(3); // seq 2 → line 3

    expect(rowB.evalCase.replay.sourceSessionId).toBe('sess-b');
    expect(rowB.evalCase.replay.evidenceRowIndex).toBe(1);
    expect(rowB.evalCase.replay.sliceLineRange.endLine).toBe(5); // seq 4 → line 5

    // Fixtures must differ.
    expect(rowA.evalCase.replay.sliceSha256).not.toBe(rowB.evalCase.replay.sliceSha256);
  });
});

// ---------------------------------------------------------------------------
// writeEvalCase
// ---------------------------------------------------------------------------

describe('writeEvalCase', () => {
  it('writes JSON, fixture, and markdown atomically', () => {
    const { card } = setupSession();
    const { evalCase, sliceBytes } = buildEvalCase(card, {
      evalCaseId: 'write-1',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    const outcome = writeEvalCase(evalCase, sliceBytes);

    expect(existsSync(outcome.jsonPath)).toBe(true);
    expect(existsSync(outcome.fixturePath)).toBe(true);
    expect(existsSync(outcome.markdownPath)).toBe(true);
  });

  it('persists fixture bytes byte-for-byte', () => {
    const { card } = setupSession();
    const { evalCase, sliceBytes } = buildEvalCase(card, {
      evalCaseId: 'bytes',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    const outcome = writeEvalCase(evalCase, sliceBytes);

    const onDisk = readFileSync(outcome.fixturePath);
    expect(Buffer.compare(onDisk, sliceBytes)).toBe(0);
  });

  it('the fixture file on disk matches sliceSha256 in the JSON', () => {
    const { card } = setupSession();
    const { evalCase, sliceBytes } = buildEvalCase(card, {
      evalCaseId: 'sha',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    const outcome = writeEvalCase(evalCase, sliceBytes);

    const onDisk = readFileSync(outcome.fixturePath);
    expect(sha256Bytes(onDisk)).toBe(evalCase.replay.sliceSha256);

    // And the JSON on disk carries that same sha.
    const parsed = JSON.parse(readFileSync(outcome.jsonPath, 'utf-8'));
    expect(parsed.replay.sliceSha256).toBe(sha256Bytes(onDisk));
  });

  it('throws fixture-mismatch when sliceBytes disagrees with the schema sha256', () => {
    const { card } = setupSession();
    const { evalCase } = buildEvalCase(card, {
      evalCaseId: 'mismatch',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    const bogusBytes = Buffer.from('this is not what the slicer produced\n');
    expect(() => writeEvalCase(evalCase, bogusBytes)).toThrowError(
      /sha256 mismatch/,
    );

    // No JSON should have been written because the fixture check happens first.
    expect(existsSync(getEvalCaseJsonPath('mismatch'))).toBe(false);
  });

  it('creates the eval-cases dir on first write', () => {
    const { card } = setupSession();
    const { evalCase, sliceBytes } = buildEvalCase(card, {
      evalCaseId: 'first',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    expect(existsSync(getEvalCasesDir())).toBe(false);
    writeEvalCase(evalCase, sliceBytes);
    expect(existsSync(getEvalCasesDir())).toBe(true);
  });

  it('appends to .index.jsonl on every write with kind=replay', () => {
    const { card } = setupSession();
    const r1 = buildEvalCase(card, { evalCaseId: 'a', evidenceRowIndex: 0, now: FIXED_NOW });
    writeEvalCase(r1.evalCase, r1.sliceBytes);
    const r2 = buildEvalCase(card, { evalCaseId: 'b', evidenceRowIndex: 0, now: FIXED_NOW });
    writeEvalCase(r2.evalCase, r2.sliceBytes);

    const lines = readFileSync(getEvalCasesIndexPath(), 'utf-8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const evt1 = JSON.parse(lines[0]!);
    expect(evt1.event).toBe('created');
    expect(evt1.evalCaseId).toBe('a');
    expect(evt1.kind).toBe('replay');
    expect(evt1.cardSlug).toBe('repeated-tool-grep-abc123');
  });

  it('index event carries proposalId when set, null when not', () => {
    const { card } = setupSession();
    const cardOnly = buildEvalCase(card, {
      evalCaseId: 'co',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    writeEvalCase(cardOnly.evalCase, cardOnly.sliceBytes);

    const withProp = buildEvalCase(card, {
      evalCaseId: 'wp',
      evidenceRowIndex: 0,
      proposalId: 'card-slug-20260524-abc123',
      now: FIXED_NOW,
    });
    writeEvalCase(withProp.evalCase, withProp.sliceBytes);

    const lines = readFileSync(getEvalCasesIndexPath(), 'utf-8')
      .trim()
      .split('\n');
    const [evt1, evt2] = lines.map((l) => JSON.parse(l!));
    expect(evt1.proposalId).toBeNull();
    expect(evt2.proposalId).toBe('card-slug-20260524-abc123');
  });

  it('rejects an EvalCase that fails schema validation', () => {
    const { card } = setupSession();
    const { evalCase, sliceBytes } = buildEvalCase(card, {
      evalCaseId: 'bad',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    const tampered = { ...evalCase, evalCaseId: 'INVALID UPPER' };
    expect(() => writeEvalCase(tampered as EvalCase, sliceBytes)).toThrow();
  });

  it('does NOT mutate any sibling proposal artifact (Sprint 3 deferred back-fill)', () => {
    // Create a real proposal first.
    const cardSlug = 'repeated-tool-grep-abc123';
    const { card } = setupSession();
    const proposal = proposeFromCard(card, { proposalId: `${cardSlug}-20260524-aaaaaa` });
    writeProposal(proposal);

    // Now generate an eval-case that back-references the proposal.
    const { evalCase, sliceBytes } = buildEvalCase(card, {
      evalCaseId: `${cardSlug}-eval-20260524-9c4d2f`,
      evidenceRowIndex: 0,
      proposalId: proposal.proposalId,
      now: FIXED_NOW,
    });
    writeEvalCase(evalCase, sliceBytes);

    // Read the proposal back from disk. validationPlan.evalCases must still
    // be the empty array the template originally wrote.
    const proposalPath = join(getProposalsDir(), `${proposal.proposalId}.json`);
    const proposalOnDisk = JSON.parse(readFileSync(proposalPath, 'utf-8'));
    expect(proposalOnDisk.validationPlan.evalCases).toEqual([]);
    // And it must still equal the value we wrote (no other field mutated).
    expect(proposalOnDisk.proposalId).toBe(proposal.proposalId);
  });
});

// ---------------------------------------------------------------------------
// Read-side helpers
// ---------------------------------------------------------------------------

describe('listEvalCases / getEvalCase / getEvalCasesForCard / getEvalCasesForProposal', () => {
  it('returns empty when no eval-cases exist', () => {
    expect(listEvalCases()).toEqual([]);
    expect(getEvalCase('nope')).toBeUndefined();
    expect(getEvalCasesForCard('nope')).toEqual([]);
    expect(getEvalCasesForProposal('nope')).toEqual([]);
  });

  it('lists eval-cases newest-first', () => {
    const { card } = setupSession();
    const r1 = buildEvalCase(card, {
      evalCaseId: 'old',
      evidenceRowIndex: 0,
      now: () => new Date('2026-05-20T00:00:00.000Z'),
    });
    writeEvalCase(r1.evalCase, r1.sliceBytes);

    const r2 = buildEvalCase(card, {
      evalCaseId: 'newer',
      evidenceRowIndex: 0,
      now: () => new Date('2026-05-24T00:00:00.000Z'),
    });
    writeEvalCase(r2.evalCase, r2.sliceBytes);

    const entries = listEvalCases();
    expect(entries.map((e) => e.evalCaseId)).toEqual(['newer', 'old']);
  });

  it('getEvalCase returns the round-tripped value', () => {
    const { card } = setupSession();
    const { evalCase, sliceBytes } = buildEvalCase(card, {
      evalCaseId: 'roundtrip',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    writeEvalCase(evalCase, sliceBytes);

    const round = getEvalCase('roundtrip');
    expect(round).toBeDefined();
    expect(round?.evalCaseId).toBe('roundtrip');
    expect(round?.replay.sliceSha256).toBe(evalCase.replay.sliceSha256);
    expect(round?.title).toBe(evalCase.title);
  });

  it('getEvalCasesForCard filters by cardSlug', () => {
    const { card: cardA } = setupSession({ sessionId: 'sa' });
    writeWitnessTrace('sb', makeSyntheticTrace());
    const cardB = makeCard({
      slug: 'card-b',
      evidence: [
        {
          sessionId: 'sb',
          tracePath: 'state/witness/sb/trace.jsonl',
          eventIndices: [1, 2],
          excerpt: '{}',
        },
      ],
    });

    const r1 = buildEvalCase(cardA, { evalCaseId: 'x1', evidenceRowIndex: 0, now: FIXED_NOW });
    writeEvalCase(r1.evalCase, r1.sliceBytes);
    const r2 = buildEvalCase(cardA, { evalCaseId: 'x2', evidenceRowIndex: 0, now: FIXED_NOW });
    writeEvalCase(r2.evalCase, r2.sliceBytes);
    const r3 = buildEvalCase(cardB, { evalCaseId: 'y1', evidenceRowIndex: 0, now: FIXED_NOW });
    writeEvalCase(r3.evalCase, r3.sliceBytes);

    expect(
      getEvalCasesForCard('repeated-tool-grep-abc123')
        .map((e) => e.evalCaseId)
        .sort(),
    ).toEqual(['x1', 'x2']);
    expect(getEvalCasesForCard('card-b').map((e) => e.evalCaseId)).toEqual(['y1']);
  });

  it('getEvalCasesForProposal filters by proposalId (null does not match anything)', () => {
    const { card } = setupSession();
    const withProp = buildEvalCase(card, {
      evalCaseId: 'with',
      evidenceRowIndex: 0,
      proposalId: 'prop-1',
      now: FIXED_NOW,
    });
    writeEvalCase(withProp.evalCase, withProp.sliceBytes);

    const cardOnly = buildEvalCase(card, {
      evalCaseId: 'co',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    writeEvalCase(cardOnly.evalCase, cardOnly.sliceBytes);

    expect(getEvalCasesForProposal('prop-1').map((e) => e.evalCaseId)).toEqual(['with']);
    expect(getEvalCasesForProposal('not-a-proposal')).toEqual([]);
  });

  it('silently skips corrupt JSON files (matches card-writer convention)', () => {
    const { card } = setupSession();
    const { evalCase, sliceBytes } = buildEvalCase(card, {
      evalCaseId: 'valid',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    writeEvalCase(evalCase, sliceBytes);

    writeFileSync(join(getEvalCasesDir(), 'corrupt.json'), '{not json');

    const entries = listEvalCases();
    expect(entries.map((e) => e.evalCaseId)).toEqual(['valid']);
  });
});

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

describe('renderEvalCaseMarkdown', () => {
  it('is byte-stable for the same input', () => {
    const { card } = setupSession();
    const { evalCase } = buildEvalCase(card, {
      evalCaseId: 'stable',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    expect(renderEvalCaseMarkdown(evalCase)).toBe(renderEvalCaseMarkdown(evalCase));
  });

  it('renders the Sprint 3 "contract, not executable" disclaimer', () => {
    const { card } = setupSession();
    const { evalCase } = buildEvalCase(card, {
      evalCaseId: 'disclaimer',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    const md = renderEvalCaseMarkdown(evalCase);
    expect(md).toContain('CONTRACT, not an');
    expect(md).toContain('No runner consumes it yet');
  });

  it('renders all required sections', () => {
    const { card } = setupSession();
    const { evalCase } = buildEvalCase(card, {
      evalCaseId: 'sections',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    const md = renderEvalCaseMarkdown(evalCase);
    expect(md).toContain('## Replay fixture');
    expect(md).toContain('## Assertion');
    expect(md).toContain('## Provenance');
    expect(md).toContain('## Triage notes');
    expect(md).toContain(`Source session`);
    expect(md).toContain(`SHA-256`);
  });

  it('renders proposalId when set, "_(none)_" when null', () => {
    const { card } = setupSession();
    const withProp = buildEvalCase(card, {
      evalCaseId: 'wp',
      evidenceRowIndex: 0,
      proposalId: 'card-slug-20260524-abc123',
      now: FIXED_NOW,
    });
    const mdWith = renderEvalCaseMarkdown(withProp.evalCase);
    expect(mdWith).toContain('card-slug-20260524-abc123');

    const cardOnly = buildEvalCase(card, {
      evalCaseId: 'co',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    const mdNone = renderEvalCaseMarkdown(cardOnly.evalCase);
    expect(mdNone).toContain('_(none)_');
  });

  it('renders fingerprintAtGeneration when present and "_(none — detector has no fingerprint)_" when null', () => {
    const { card } = setupSession();
    const { evalCase: withFp } = buildEvalCase(card, {
      evalCaseId: 'wf',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    expect(renderEvalCaseMarkdown(withFp)).toContain(
      'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    );

    writeWitnessTrace('sess-closure', makeSyntheticTrace());
    const noFpCard = makeCard({
      slug: 'closure-anomaly-x',
      pattern: 'closure-anomaly',
      evidence: [
        {
          sessionId: 'sess-closure',
          tracePath: 'state/witness/sess-closure/trace.jsonl',
          eventIndices: [3],
          excerpt: '{}',
        },
      ],
      detail: { detector: 'closure-anomaly@v1' }, // no fingerprint
    });
    const { evalCase: noFp } = buildEvalCase(noFpCard, {
      evalCaseId: 'nf',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    expect(renderEvalCaseMarkdown(noFp)).toContain('_(none — detector has no fingerprint)_');
  });
});

// ---------------------------------------------------------------------------
// Path helper integration
// ---------------------------------------------------------------------------

describe('path resolution', () => {
  it('replay.fixturePath is relative to $AFK_HOME', () => {
    const { card } = setupSession();
    const { evalCase } = buildEvalCase(card, {
      evalCaseId: 'rel',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    expect(evalCase.replay.fixturePath).toBe(
      'agent-framework/improve/eval-cases/rel.fixture.jsonl',
    );
  });

  it('the absolute path resolves to the same file on disk', () => {
    const { card } = setupSession();
    const { evalCase, sliceBytes } = buildEvalCase(card, {
      evalCaseId: 'abs',
      evidenceRowIndex: 0,
      now: FIXED_NOW,
    });
    writeEvalCase(evalCase, sliceBytes);

    const expectedAbs = getEvalCaseFixturePath('abs');
    expect(existsSync(expectedAbs)).toBe(true);
    expect(existsSync(getEvalCaseJsonPath('abs'))).toBe(true);
    expect(existsSync(getEvalCaseMarkdownPath('abs'))).toBe(true);
  });
});
