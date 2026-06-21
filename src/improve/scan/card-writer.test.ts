/**
 * Tests for `improve/scan/card-writer.ts`.
 *
 * Coverage:
 *   - First detection creates a card with status='open' and no notes.
 *   - Re-detecting the same evidence is a no-op merge (no double-count).
 *   - Re-detecting NEW evidence is a merge that grows occurrenceCount.
 *   - User-added notes survive a merge.
 *   - User-set status (deferred/resolved) survives a merge.
 *   - Severity escalates but never auto-downgrades.
 *   - firstSeen/lastSeen window expands correctly.
 *   - Slug mismatch on merge throws.
 *
 * Filesystem isolation: each test gets a unique temp AFK_HOME via
 * `mkdtempSync` + `AFK_HOME` env override. The env is restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { DetectorResult, FailureCard } from '../schemas.js';
import {
  getCard,
  isRegressed,
  latestNoteAt,
  listCards,
  listRegressedCards,
  mergeCard,
  readCardIfExists,
  renderMarkdown,
  selectRegressed,
  writeCard,
} from './card-writer.js';
import { triageCard } from '../triage.js';
import { getFailureCardJsonPath, getFailureCardsIndexPath } from '../paths.js';

// ---------------------------------------------------------------------------
// Filesystem fixture
// ---------------------------------------------------------------------------

let originalAfkHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalAfkHome = process.env['AFK_HOME'];
  tempHome = mkdtempSync(join(tmpdir(), 'afk-improve-test-'));
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

function makeDetection(overrides: Partial<DetectorResult> = {}): DetectorResult {
  return {
    slug: 'repeated-tool-grep-aabbccddeeff',
    title: "'grep' tool repeated 4× with identical fingerprint",
    pattern: 'repeated-tool-use',
    severity: 'medium',
    observedAt: '2026-05-22T10:00:00.000Z',
    evidence: [
      {
        sessionId: 'sess-A',
        tracePath: 'state/witness/sess-A/trace.jsonl',
        eventIndices: [10, 12, 14, 16],
        excerpt: '{"kind":"tool_call","payload":{"phase":"completed"}}',
        annotation: '4× grep in root context',
      },
    ],
    detail: {
      detector: 'repeated-tool-use@v1',
      fingerprint: 'aa' + 'b'.repeat(62),
      fingerprintAlgorithm: 'v1-bytes-tuple',
      toolName: 'grep',
      runLength: 4,
      agentContext: 'root',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure merge tests (no filesystem)
// ---------------------------------------------------------------------------

describe('mergeCard (pure)', () => {
  it('creates a new card with defaults on first sighting', () => {
    const merged = mergeCard(undefined, makeDetection());
    expect(merged.status).toBe('open');
    expect(merged.notes).toEqual([]);
    expect(merged.occurrenceCount).toBe(1);
    expect(merged.firstSeen).toBe('2026-05-22T10:00:00.000Z');
    expect(merged.lastSeen).toBe('2026-05-22T10:00:00.000Z');
  });

  it('expands firstSeen/lastSeen window on later detection', () => {
    const first = mergeCard(undefined, makeDetection({ observedAt: '2026-05-22T10:00:00.000Z' }));
    const merged = mergeCard(
      first,
      makeDetection({
        observedAt: '2026-05-25T15:00:00.000Z',
        evidence: [
          {
            sessionId: 'sess-B',
            tracePath: 'state/witness/sess-B/trace.jsonl',
            eventIndices: [5, 7, 9, 11],
            excerpt: 'foo',
          },
        ],
      }),
    );
    expect(merged.firstSeen).toBe('2026-05-22T10:00:00.000Z');
    expect(merged.lastSeen).toBe('2026-05-25T15:00:00.000Z');
    expect(merged.occurrenceCount).toBe(2);
  });

  it('preserves notes from the existing card', () => {
    const first: FailureCard = {
      ...mergeCard(undefined, makeDetection()),
      notes: [{ at: '2026-05-22T11:00:00.000Z', text: 'looked at this, real loop' }],
    };
    const merged = mergeCard(first, makeDetection());
    expect(merged.notes).toEqual(first.notes);
  });

  it('preserves a triaged status across re-detection', () => {
    const first: FailureCard = {
      ...mergeCard(undefined, makeDetection()),
      status: 'deferred',
    };
    const merged = mergeCard(first, makeDetection());
    expect(merged.status).toBe('deferred');
  });

  it('escalates severity but never auto-downgrades', () => {
    const first: FailureCard = {
      ...mergeCard(undefined, makeDetection({ severity: 'high' })),
    };
    const merged = mergeCard(first, makeDetection({ severity: 'low' }));
    expect(merged.severity).toBe('high');

    const escalated = mergeCard(
      mergeCard(undefined, makeDetection({ severity: 'low' })),
      makeDetection({ severity: 'medium' }),
    );
    expect(escalated.severity).toBe('medium');
  });

  it('dedupes evidence by (sessionId, first event seq)', () => {
    const first = mergeCard(undefined, makeDetection());
    const merged = mergeCard(first, makeDetection()); // identical evidence
    expect(merged.evidence).toHaveLength(1);
    expect(merged.occurrenceCount).toBe(1);
  });

  it('throws on slug mismatch', () => {
    const first = mergeCard(undefined, makeDetection());
    expect(() => mergeCard(first, makeDetection({ slug: 'different-slug' }))).toThrow(/slug mismatch/);
  });
});

// ---------------------------------------------------------------------------
// I/O round-trip tests
// ---------------------------------------------------------------------------

describe('writeCard (round-trip)', () => {
  it('creates JSON, MD, and index entry on first write', () => {
    const outcome = writeCard(makeDetection());
    expect(outcome.event).toBe('created');
    expect(outcome.occurrenceCount).toBe(1);
    expect(outcome.evidenceAdded).toBe(1);
    expect(existsSync(outcome.jsonPath)).toBe(true);
    expect(existsSync(outcome.markdownPath)).toBe(true);
    expect(existsSync(getFailureCardsIndexPath())).toBe(true);
  });

  it('writes valid card JSON readable by readCardIfExists', () => {
    const d = makeDetection();
    writeCard(d);
    const card = readCardIfExists(getFailureCardJsonPath(d.slug));
    expect(card).toBeDefined();
    expect(card?.slug).toBe(d.slug);
    expect(card?.status).toBe('open');
  });

  it('logs separate events for created/updated/merged-noop', () => {
    // First write — created.
    writeCard(makeDetection());
    // Same evidence — merged-noop.
    writeCard(makeDetection());
    // New evidence — updated.
    writeCard(
      makeDetection({
        observedAt: '2026-05-23T10:00:00.000Z',
        evidence: [
          {
            sessionId: 'sess-B',
            tracePath: 'state/witness/sess-B/trace.jsonl',
            eventIndices: [50, 52, 54, 56],
            excerpt: 'foo',
          },
        ],
      }),
    );

    const indexRaw = readFileSync(getFailureCardsIndexPath(), 'utf-8');
    const indexLines = indexRaw.trim().split('\n').filter(Boolean);
    expect(indexLines).toHaveLength(3);
    expect(JSON.parse(indexLines[0] ?? '{}')['event']).toBe('created');
    expect(JSON.parse(indexLines[1] ?? '{}')['event']).toBe('merged-noop');
    expect(JSON.parse(indexLines[2] ?? '{}')['event']).toBe('updated');
  });

  it('preserves notes added directly to disk after first write', () => {
    const d = makeDetection();
    const first = writeCard(d);

    // Simulate a human adding a note via direct edit (or future triage CLI).
    const card = readCardIfExists(first.jsonPath);
    if (!card) throw new Error('card disappeared');
    const withNote: FailureCard = {
      ...card,
      notes: [
        { at: '2026-05-22T12:00:00.000Z', text: 'I confirmed this is real' },
      ],
    };
    writeFileSync(first.jsonPath, JSON.stringify(withNote, null, 2));

    // Re-detect — the note must survive.
    writeCard(d);
    const after = readCardIfExists(first.jsonPath);
    expect(after?.notes).toHaveLength(1);
    expect(after?.notes[0]?.text).toBe('I confirmed this is real');
  });
});

describe('listCards / getCard', () => {
  it('returns empty when no cards exist', () => {
    expect(listCards()).toEqual([]);
    expect(getCard('nope')).toBeUndefined();
  });

  it('returns written cards, newest-lastSeen first', () => {
    writeCard(
      makeDetection({
        slug: 'repeated-tool-grep-111111111111',
        observedAt: '2026-05-20T10:00:00.000Z',
      }),
    );
    writeCard(
      makeDetection({
        slug: 'repeated-tool-grep-222222222222',
        observedAt: '2026-05-22T10:00:00.000Z',
      }),
    );
    const entries = listCards();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.slug).toBe('repeated-tool-grep-222222222222');
    expect(entries[1]?.slug).toBe('repeated-tool-grep-111111111111');
  });
});

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  it('includes slug, severity, status, evidence sections', () => {
    const card = mergeCard(undefined, makeDetection());
    const md = renderMarkdown(card);
    expect(md).toContain(card.slug);
    expect(md).toContain('medium');
    expect(md).toContain('open');
    expect(md).toContain('## Evidence');
    expect(md).toContain('## Detail');
    expect(md).toContain('## Triage notes');
  });

  it('shows real notes when present', () => {
    const card: FailureCard = {
      ...mergeCard(undefined, makeDetection()),
      notes: [{ at: '2026-05-22T12:00:00.000Z', text: 'confirmed' }],
    };
    const md = renderMarkdown(card);
    expect(md).toContain('confirmed');
    expect(md).not.toContain('Phase 1A does not write notes');
  });
});

// ---------------------------------------------------------------------------
// Regressed-card selection (pure)
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<FailureCard> = {}): FailureCard {
  return {
    schemaVersion: 1,
    slug: 'tool-failure-memory-search',
    title: 'memory_search failing repeatedly',
    pattern: 'repeated-tool-use',
    severity: 'medium',
    status: 'resolved',
    firstSeen: '2026-05-01T10:00:00.000Z',
    lastSeen: '2026-06-10T10:00:00.000Z',
    occurrenceCount: 5,
    evidence: [
      {
        sessionId: 'sess-A',
        tracePath: 'state/witness/sess-A/trace.jsonl',
        eventIndices: [1],
        excerpt: '{"kind":"tool_call"}',
      },
    ],
    detail: { detector: 'test' },
    notes: [{ at: '2026-06-01T10:00:00.000Z', text: 'resolved as expected' }],
    ...overrides,
  };
}

describe('latestNoteAt (pure)', () => {
  it('returns undefined for a card with no notes', () => {
    expect(latestNoteAt(makeCard({ notes: [] }))).toBeUndefined();
  });

  it('returns the only note timestamp', () => {
    expect(latestNoteAt(makeCard({ notes: [{ at: '2026-06-01T10:00:00.000Z', text: 'x' }] }))).toBe(
      '2026-06-01T10:00:00.000Z',
    );
  });

  it('returns the MAX timestamp regardless of on-disk note order', () => {
    const card = makeCard({
      notes: [
        { at: '2026-06-05T10:00:00.000Z', text: 'later' },
        { at: '2026-06-01T10:00:00.000Z', text: 'earlier' },
        { at: '2026-06-03T10:00:00.000Z', text: 'middle' },
      ],
    });
    expect(latestNoteAt(card)).toBe('2026-06-05T10:00:00.000Z');
  });
});

describe('isRegressed (pure)', () => {
  it('is true when resolved + note + lastSeen strictly after latest note', () => {
    expect(
      isRegressed(
        makeCard({
          status: 'resolved',
          notes: [{ at: '2026-06-01T10:00:00.000Z', text: 'fixed' }],
          lastSeen: '2026-06-10T10:00:00.000Z',
        }),
      ),
    ).toBe(true);
  });

  it('is true for a deferred card that fired again', () => {
    expect(
      isRegressed(
        makeCard({
          status: 'deferred',
          notes: [{ at: '2026-06-01T10:00:00.000Z', text: 'later' }],
          lastSeen: '2026-06-10T10:00:00.000Z',
        }),
      ),
    ).toBe(true);
  });

  it('is false for an open card even if it fired after a note (status gate)', () => {
    expect(
      isRegressed(
        makeCard({
          status: 'open',
          notes: [{ at: '2026-06-01T10:00:00.000Z', text: 'n' }],
          lastSeen: '2026-06-10T10:00:00.000Z',
        }),
      ),
    ).toBe(false);
  });

  it('is false for a resolved card with no triage notes (note gate)', () => {
    expect(isRegressed(makeCard({ status: 'resolved', notes: [] }))).toBe(false);
  });

  it('is false when lastSeen equals the latest note (must be STRICTLY later)', () => {
    expect(
      isRegressed(
        makeCard({
          notes: [{ at: '2026-06-10T10:00:00.000Z', text: 'n' }],
          lastSeen: '2026-06-10T10:00:00.000Z',
        }),
      ),
    ).toBe(false);
  });

  it('is false when lastSeen predates the note (fixed and quiet)', () => {
    expect(
      isRegressed(
        makeCard({
          notes: [{ at: '2026-06-10T10:00:00.000Z', text: 'n' }],
          lastSeen: '2026-06-01T10:00:00.000Z',
        }),
      ),
    ).toBe(false);
  });

  it('measures against the LATEST note, not an earlier one', () => {
    // lastSeen sits after the first note but before the most recent note → not regressed.
    expect(
      isRegressed(
        makeCard({
          notes: [
            { at: '2026-06-01T10:00:00.000Z', text: 'first' },
            { at: '2026-06-20T10:00:00.000Z', text: 'second' },
          ],
          lastSeen: '2026-06-10T10:00:00.000Z',
        }),
      ),
    ).toBe(false);
  });

  it('ignores an unparseable lastSeen (conservative not-regressed)', () => {
    expect(
      isRegressed(
        makeCard({
          notes: [{ at: '2026-06-01T10:00:00.000Z', text: 'n' }],
          lastSeen: 'not-a-date',
        }),
      ),
    ).toBe(false);
  });
});

describe('selectRegressed (pure)', () => {
  it('returns [] for an empty input', () => {
    expect(selectRegressed([])).toEqual([]);
  });

  it('keeps only regressed cards and projects the expected fields', () => {
    const regressed = makeCard({
      slug: 'regressed-one',
      status: 'resolved',
      severity: 'high',
      occurrenceCount: 9,
      notes: [{ at: '2026-06-01T10:00:00.000Z', text: 'fixed' }],
      lastSeen: '2026-06-10T10:00:00.000Z',
    });
    const quiet = makeCard({
      slug: 'quiet-resolved',
      notes: [{ at: '2026-06-10T10:00:00.000Z', text: 'fixed' }],
      lastSeen: '2026-06-01T10:00:00.000Z',
    });
    const open = makeCard({ slug: 'still-open', status: 'open', notes: [] });

    const out = selectRegressed([regressed, quiet, open]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      slug: 'regressed-one',
      pattern: 'repeated-tool-use',
      severity: 'high',
      status: 'resolved',
      occurrenceCount: 9,
      lastSeen: '2026-06-10T10:00:00.000Z',
      latestNoteAt: '2026-06-01T10:00:00.000Z',
    });
  });

  it('sorts by lastSeen descending, then slug', () => {
    const a = makeCard({
      slug: 'aaa',
      notes: [{ at: '2026-06-01T10:00:00.000Z', text: 'n' }],
      lastSeen: '2026-06-09T10:00:00.000Z',
    });
    const b = makeCard({
      slug: 'bbb',
      notes: [{ at: '2026-06-01T10:00:00.000Z', text: 'n' }],
      lastSeen: '2026-06-12T10:00:00.000Z',
    });
    const c = makeCard({
      slug: 'ccc',
      notes: [{ at: '2026-06-01T10:00:00.000Z', text: 'n' }],
      lastSeen: '2026-06-12T10:00:00.000Z',
    });
    const out = selectRegressed([a, b, c]).map((e) => e.slug);
    // b and c share lastSeen → tie broken by slug ascending; a is older → last.
    expect(out).toEqual(['bbb', 'ccc', 'aaa']);
  });
});

// ---------------------------------------------------------------------------
// listRegressedCards (round-trip): proves the real scan-merge + triage path
// feeds the regression view WITHOUT changing merge semantics.
// ---------------------------------------------------------------------------

describe('listRegressedCards (round-trip)', () => {
  it('returns empty when no cards exist', () => {
    expect(listRegressedCards()).toEqual([]);
  });

  it('flags a card that re-fired after being resolved, but not a quiet one', () => {
    // Card 1: detected, resolved with a note, then detected AGAIN later → regressed.
    writeCard(makeDetection({ slug: 'repeated-tool-grep-aaaaaaaaaaaa', observedAt: '2026-05-20T10:00:00.000Z' }));
    triageCard('repeated-tool-grep-aaaaaaaaaaaa', {
      status: 'resolved',
      note: 'fixed in commit X',
      now: () => new Date('2026-05-21T10:00:00.000Z'),
    });
    // Re-detection with a NEW session + later observedAt advances lastSeen past the note.
    writeCard(
      makeDetection({
        slug: 'repeated-tool-grep-aaaaaaaaaaaa',
        observedAt: '2026-05-25T10:00:00.000Z',
        evidence: [
          {
            sessionId: 'sess-Z',
            tracePath: 'state/witness/sess-Z/trace.jsonl',
            eventIndices: [3, 5, 7, 9],
            excerpt: 'recurred',
          },
        ],
      }),
    );

    // Card 2: detected, resolved with a note, and never fired again → quiet.
    writeCard(makeDetection({ slug: 'repeated-tool-grep-bbbbbbbbbbbb', observedAt: '2026-05-20T10:00:00.000Z' }));
    triageCard('repeated-tool-grep-bbbbbbbbbbbb', {
      status: 'resolved',
      note: 'expected behavior',
      now: () => new Date('2026-05-26T10:00:00.000Z'),
    });

    // Card 1's status must still be 'resolved' (merge preserves it — not auto-reopened).
    expect(getCard('repeated-tool-grep-aaaaaaaaaaaa')?.status).toBe('resolved');

    const regressed = listRegressedCards();
    expect(regressed).toHaveLength(1);
    expect(regressed[0]?.slug).toBe('repeated-tool-grep-aaaaaaaaaaaa');
    expect(regressed[0]?.status).toBe('resolved');
    expect(regressed[0]?.latestNoteAt).toBe('2026-05-21T10:00:00.000Z');
    expect(regressed[0]?.lastSeen).toBe('2026-05-25T10:00:00.000Z');
  });
});
