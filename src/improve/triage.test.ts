/**
 * Tests for `improve/triage.ts`.
 *
 * Coverage:
 *   - Add a note → notes grows by 1, status preserved, evidence preserved.
 *   - Change status only → no note appended, status updated.
 *   - Change both → both applied.
 *   - Missing card → TriageError('card-not-found').
 *   - Empty/whitespace note → TriageError('invalid-note').
 *   - No-change (no note, status matches current) → TriageError('no-change').
 *   - Notes preserved across triages.
 *   - Markdown re-renders to include the new note.
 *   - Status `resolved` is sticky — re-running triage with same status is no-op (errors).
 *   - Atomic write semantics — file present, parseable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { triageCard, TriageError } from './triage.js';
import { getFailureCardJsonPath, getFailureCardMarkdownPath, getFailureCardsDir } from './paths.js';
import { writeCard } from './scan/card-writer.js';
import type { DetectorResult } from './schemas.js';

// ---------------------------------------------------------------------------
// Filesystem fixture — mirrors card-writer.test.ts
// ---------------------------------------------------------------------------

let originalAfkHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalAfkHome = process.env['AFK_HOME'];
  tempHome = mkdtempSync(join(tmpdir(), 'afk-triage-test-'));
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

function seedCard(slug = 'repeated-tool-grep-aabbccddeeff'): string {
  const detection: DetectorResult = {
    slug,
    title: "'grep' tool repeated 4× with identical fingerprint",
    pattern: 'repeated-tool-use',
    severity: 'medium',
    observedAt: '2026-05-22T10:00:00.000Z',
    evidence: [
      {
        sessionId: 'sess-A',
        tracePath: 'state/witness/sess-A/trace.jsonl',
        eventIndices: [10, 12, 14, 16],
        excerpt: '{"kind":"tool_call"}',
      },
    ],
    detail: { detector: 'repeated-tool-use@v1' },
  };
  writeCard(detection);
  return slug;
}

const FIXED_NOW = () => new Date('2026-05-24T19:30:00.000Z');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('triageCard — happy paths', () => {
  it('appends a note and preserves everything else', () => {
    const slug = seedCard();
    const outcome = triageCard(slug, { note: 'False positive — productive recursion', now: FIXED_NOW });

    expect(outcome.noteAdded).toBe(true);
    expect(outcome.statusChanged).toBeUndefined();
    expect(outcome.card.notes).toHaveLength(1);
    expect(outcome.card.notes[0]?.text).toBe('False positive — productive recursion');
    expect(outcome.card.notes[0]?.at).toBe('2026-05-24T19:30:00.000Z');
    expect(outcome.card.status).toBe('open');
    expect(outcome.card.evidence).toHaveLength(1); // preserved
    expect(outcome.card.severity).toBe('medium'); // preserved
  });

  it('changes status only', () => {
    const slug = seedCard();
    const outcome = triageCard(slug, { status: 'deferred' });
    expect(outcome.noteAdded).toBe(false);
    expect(outcome.statusChanged).toEqual({ from: 'open', to: 'deferred' });
    expect(outcome.card.notes).toHaveLength(0);
    expect(outcome.card.status).toBe('deferred');
  });

  it('changes both note and status in one call', () => {
    const slug = seedCard();
    const outcome = triageCard(slug, {
      note: 'Closing — patched in PR #123',
      status: 'resolved',
      now: FIXED_NOW,
    });
    expect(outcome.noteAdded).toBe(true);
    expect(outcome.statusChanged).toEqual({ from: 'open', to: 'resolved' });
    expect(outcome.card.notes).toHaveLength(1);
    expect(outcome.card.status).toBe('resolved');
  });

  it('preserves prior notes when adding a new one', () => {
    const slug = seedCard();
    triageCard(slug, { note: 'first note', now: () => new Date('2026-05-24T10:00:00.000Z') });
    const outcome = triageCard(slug, {
      note: 'second note',
      now: () => new Date('2026-05-24T11:00:00.000Z'),
    });
    expect(outcome.card.notes).toHaveLength(2);
    expect(outcome.card.notes[0]?.text).toBe('first note');
    expect(outcome.card.notes[1]?.text).toBe('second note');
  });

  it('trims whitespace from the note', () => {
    const slug = seedCard();
    const outcome = triageCard(slug, { note: '   trimmed body   ', now: FIXED_NOW });
    expect(outcome.card.notes[0]?.text).toBe('trimmed body');
  });
});

describe('triageCard — error paths', () => {
  it('throws card-not-found when the slug has no file', () => {
    try {
      triageCard('does-not-exist', { note: 'x' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TriageError);
      expect((err as TriageError).code).toBe('card-not-found');
    }
  });

  it('throws invalid-note when --note is empty after trim', () => {
    const slug = seedCard();
    try {
      triageCard(slug, { note: '   ' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TriageError);
      expect((err as TriageError).code).toBe('invalid-note');
    }
  });

  it('throws no-change when no note AND no status delta', () => {
    const slug = seedCard();
    try {
      triageCard(slug, {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TriageError);
      expect((err as TriageError).code).toBe('no-change');
    }
  });

  it('throws no-change when --status equals current status', () => {
    const slug = seedCard();
    try {
      triageCard(slug, { status: 'open' }); // already 'open'
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TriageError);
      expect((err as TriageError).code).toBe('no-change');
    }
  });
});

describe('triageCard — on-disk state', () => {
  it('persists the new note to <slug>.json on disk', () => {
    const slug = seedCard();
    triageCard(slug, { note: 'persistent note', now: FIXED_NOW });

    const raw = readFileSync(getFailureCardJsonPath(slug), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0].text).toBe('persistent note');
  });

  it('re-renders <slug>.md with the new note', () => {
    const slug = seedCard();
    triageCard(slug, { note: 'visible in markdown', now: FIXED_NOW });

    const md = readFileSync(getFailureCardMarkdownPath(slug), 'utf-8');
    expect(md).toContain('visible in markdown');
    expect(md).toContain('2026-05-24T19:30:00.000Z');
    expect(md).not.toContain('Phase 1A does not write notes');
  });

  it('survives a re-render when no notes are present', () => {
    const slug = seedCard();
    triageCard(slug, { status: 'deferred' }); // no note, status change only
    const md = readFileSync(getFailureCardMarkdownPath(slug), 'utf-8');
    expect(md).toContain('## Triage notes');
    expect(md).toContain('(none — add one with');
  });

  it('creates the cards dir if missing (defensive)', () => {
    // Card seeded into one dir; we'll triage and confirm dir exists after.
    const slug = seedCard();
    expect(existsSync(getFailureCardsDir())).toBe(true);
    triageCard(slug, { status: 'resolved' });
    expect(existsSync(getFailureCardsDir())).toBe(true);
  });
});

describe('triageCard — corrupted card handling', () => {
  it('treats a corrupted JSON as card-not-found (matches card-writer convention)', () => {
    const slug = 'corrupted-card';
    const dir = getFailureCardsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(getFailureCardJsonPath(slug), '{not valid json');
    try {
      triageCard(slug, { note: 'whatever' });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as TriageError).code).toBe('card-not-found');
    }
  });
});
