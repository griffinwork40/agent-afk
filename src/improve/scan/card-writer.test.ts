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
  listCards,
  mergeCard,
  readCardIfExists,
  renderMarkdown,
  writeCard,
} from './card-writer.js';
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
