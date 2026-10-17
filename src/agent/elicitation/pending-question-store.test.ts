/**
 * Unit tests for the durable pending-question store (#1416).
 *
 * Each test runs against a fresh temporary StateStore so cases are fully
 * isolated from one another and from the real ~/.afk state.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../state/state-store.js';
import {
  _setStoreForTest,
  closeStore,
  getQuestion,
  listQuestions,
  markResolved,
  recordQuestion,
} from './pending-question-store.js';

let tmpDir: string;
let store: StateStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pq-store-test-'));
  store = new StateStore(join(tmpDir, 'test.db'));
  _setStoreForTest(store);
});

afterEach(() => {
  closeStore();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── recordQuestion ────────────────────────────────────────────────────────────

describe('recordQuestion', () => {
  it('stores a new question with status pending', () => {
    const q = recordQuestion('eid-1', 'sess-A', 'repl', 'Do you approve?');
    expect(q.questionId).toBe('eid-1');
    expect(q.sessionId).toBe('sess-A');
    expect(q.surface).toBe('repl');
    expect(q.prompt).toBe('Do you approve?');
    expect(q.status).toBe('pending');
    expect(q.createdAt).toBeTruthy();
    expect(q.resolvedAt).toBeUndefined();
  });

  it('is idempotent: second call with same questionId returns the existing record', () => {
    const first = recordQuestion('eid-2', 'sess-B', 'telegram', 'First?');
    const second = recordQuestion('eid-2', 'sess-X', 'repl', 'Different prompt');
    // Fields from the first write win.
    expect(second.sessionId).toBe('sess-B');
    expect(second.surface).toBe('telegram');
    expect(second.prompt).toBe('First?');
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('truncates prompt at 500 chars', () => {
    const longPrompt = 'x'.repeat(600);
    const q = recordQuestion('eid-3', undefined, 'daemon', longPrompt);
    expect(q.prompt.length).toBeLessThanOrEqual(501); // 500 chars + ellipsis
    expect(q.prompt.endsWith('\u2026')).toBe(true);
  });

  it('accepts undefined sessionId', () => {
    const q = recordQuestion('eid-4', undefined, 'unattended', 'No session');
    expect(q.sessionId).toBeUndefined();
    expect(q.status).toBe('pending');
  });

  it('persists across a fresh store read via getQuestion', () => {
    recordQuestion('eid-5', 'sess-C', 'repl', 'Persisted?');
    const read = getQuestion('eid-5');
    expect(read).not.toBeNull();
    expect(read!.questionId).toBe('eid-5');
  });
});

// ── markResolved ──────────────────────────────────────────────────────────────

describe('markResolved', () => {
  it('transitions status from pending to resolved', () => {
    recordQuestion('eid-10', 'sess-D', 'repl', 'Accept?');
    const r = markResolved('eid-10', 'accept');
    expect(r).not.toBeNull();
    expect(r!.status).toBe('resolved');
    expect(r!.resolvedAction).toBe('accept');
    expect(r!.resolvedAt).toBeTruthy();
  });

  it('persists resolution: getQuestion reflects resolved status', () => {
    recordQuestion('eid-11', 'sess-E', 'telegram', 'Decline?');
    markResolved('eid-11', 'decline');
    const read = getQuestion('eid-11');
    expect(read!.status).toBe('resolved');
    expect(read!.resolvedAction).toBe('decline');
  });

  it('is idempotent: resolving an already-resolved question returns the existing record', () => {
    recordQuestion('eid-12', 'sess-F', 'repl', 'Skip?');
    const first = markResolved('eid-12', 'skip');
    const second = markResolved('eid-12', 'accept'); // different action
    expect(second!.resolvedAction).toBe('skip'); // first resolution wins
    expect(second!.resolvedAt).toBe(first!.resolvedAt);
  });

  it('returns null when the questionId is not found', () => {
    const r = markResolved('nonexistent-id', 'accept');
    expect(r).toBeNull();
  });

  it('records aborted action', () => {
    recordQuestion('eid-13', 'sess-G', 'repl', 'Aborted?');
    const r = markResolved('eid-13', 'aborted');
    expect(r!.resolvedAction).toBe('aborted');
  });
});

// ── getQuestion ───────────────────────────────────────────────────────────────

describe('getQuestion', () => {
  it('returns null for unknown questionId', () => {
    expect(getQuestion('unknown')).toBeNull();
  });

  it('returns the stored record for a known questionId', () => {
    recordQuestion('eid-20', 'sess-H', 'repl', 'Hello?');
    const q = getQuestion('eid-20');
    expect(q).not.toBeNull();
    expect(q!.surface).toBe('repl');
  });
});

// ── listQuestions ─────────────────────────────────────────────────────────────

describe('listQuestions', () => {
  it('returns all questions when no status filter is applied', () => {
    recordQuestion('eid-30', 's1', 'repl', 'Q1');
    recordQuestion('eid-31', 's2', 'repl', 'Q2');
    markResolved('eid-30', 'accept');
    const all = listQuestions();
    expect(all.length).toBe(2);
  });

  it('filters by status=pending', () => {
    recordQuestion('eid-32', 's3', 'repl', 'Q3');
    recordQuestion('eid-33', 's4', 'repl', 'Q4');
    markResolved('eid-32', 'decline');
    const pending = listQuestions({ status: 'pending' });
    expect(pending.every((q) => q.status === 'pending')).toBe(true);
    expect(pending.some((q) => q.questionId === 'eid-33')).toBe(true);
    expect(pending.some((q) => q.questionId === 'eid-32')).toBe(false);
  });

  it('filters by status=resolved', () => {
    recordQuestion('eid-34', 's5', 'telegram', 'Q5');
    recordQuestion('eid-35', 's6', 'telegram', 'Q6');
    markResolved('eid-35', 'accept');
    const resolved = listQuestions({ status: 'resolved' });
    expect(resolved.every((q) => q.status === 'resolved')).toBe(true);
    expect(resolved.some((q) => q.questionId === 'eid-35')).toBe(true);
  });

  it('respects limit option', () => {
    for (let i = 0; i < 5; i++) {
      recordQuestion(`eid-lim-${i}`, 's', 'repl', `Q${i}`);
    }
    const limited = listQuestions({ limit: 3 });
    expect(limited.length).toBeLessThanOrEqual(3);
  });

  it('status filter applied after limit: pending question beyond first N total rows is still returned', () => {
    // Insert 3 resolved questions first, then 1 pending.
    // With the old (buggy) code, listQuestions({ status: 'pending', limit: 3 })
    // would cap at 3 rows BEFORE filtering, returning only the 3 resolved ones
    // and missing the pending question entirely.
    recordQuestion('eid-filter-0', 's', 'repl', 'R0');
    recordQuestion('eid-filter-1', 's', 'repl', 'R1');
    recordQuestion('eid-filter-2', 's', 'repl', 'R2');
    markResolved('eid-filter-0', 'accept');
    markResolved('eid-filter-1', 'accept');
    markResolved('eid-filter-2', 'accept');
    recordQuestion('eid-filter-pending', 's', 'repl', 'P0');

    const result = listQuestions({ status: 'pending', limit: 3 });
    expect(result.length).toBe(1);
    expect(result[0]!.questionId).toBe('eid-filter-pending');
  });
});

// ── key sanitization ──────────────────────────────────────────────────────────

describe('questionId key sanitization', () => {
  it('handles questionIds with special characters', () => {
    // UUIDs are fine; test with slash and space which need sanitizing.
    const q = recordQuestion('el/id with spaces', 'sess', 'repl', 'Tricky?');
    expect(q.questionId).toBe('el/id with spaces');
    expect(q.status).toBe('pending');
    // Must be resolvable.
    const r = markResolved('el/id with spaces', 'accept');
    expect(r!.status).toBe('resolved');
  });
});
