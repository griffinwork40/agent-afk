/**
 * Unit tests for goal-store.ts — lifecycle transitions and no-op guards.
 *
 * The store uses a module-scope singleton backed by SQLite. Each test resets
 * the module registry and re-imports with a fresh temp-DB path so tests are
 * fully isolated from one another and from the real ~/.afk state.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Per-test module reset ────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

// Dynamically imported module — refreshed every test via vi.resetModules().
type GoalStoreModule = typeof import('./goal-store.js');
let mod: GoalStoreModule;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'goal-store-test-'));
  dbPath = join(tmpDir, 'test.db');

  vi.resetModules();

  // Redirect getStateDatabasePath to our temp file so the singleton opens
  // there instead of the real ~/.afk/state/kv/kv.db.
  vi.mock('../../paths.js', () => ({
    getStateDatabasePath: () => dbPath,
  }));

  mod = await import('./goal-store.js');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Lifecycle transitions ─────────────────────────────────────────────────────

describe('setGoal', () => {
  it('creates an active goal and returns it', () => {
    const goal = mod.setGoal('ship the feature');
    expect(goal.text).toBe('ship the feature');
    expect(goal.status).toBe('active');
    expect(goal.createdAt).toBeTruthy();
    expect(goal.updatedAt).toBeTruthy();
  });

  it('replaces an existing goal', () => {
    mod.setGoal('first goal');
    const second = mod.setGoal('second goal');
    expect(second.text).toBe('second goal');
    expect(mod.getGoal()?.text).toBe('second goal');
  });

  it('attaches sessionId when provided', () => {
    const goal = mod.setGoal('goal with session', 'sess-abc');
    expect(goal.createdBy).toBe('sess-abc');
  });

  it('throws when text exceeds MAX_GOAL_CHARS', () => {
    const oversize = 'x'.repeat(501);
    expect(() => mod.setGoal(oversize)).toThrow(/exceeds the 500-character limit/);
    // Nothing was persisted.
    expect(mod.getGoal()).toBeNull();
  });

  it('accepts text at exactly MAX_GOAL_CHARS', () => {
    const exact = 'x'.repeat(500);
    const goal = mod.setGoal(exact);
    expect(goal.text).toBe(exact);
  });
});

describe('getGoal', () => {
  it('returns null when no goal is set', () => {
    expect(mod.getGoal()).toBeNull();
  });

  it('returns the stored goal', () => {
    mod.setGoal('persisted');
    expect(mod.getGoal()?.text).toBe('persisted');
  });
});

describe('pauseGoal', () => {
  it('transitions active → paused and returns the updated goal', () => {
    mod.setGoal('active goal');
    const result = mod.pauseGoal();
    expect(result).not.toBeNull();
    expect(result?.status).toBe('paused');
    expect(mod.getGoal()?.status).toBe('paused');
  });

  it('returns null when no goal exists', () => {
    expect(mod.pauseGoal()).toBeNull();
  });

  it('returns null when goal is already paused (no-op)', () => {
    mod.setGoal('g');
    mod.pauseGoal();
    expect(mod.pauseGoal()).toBeNull();
  });

  it('returns null when goal is completed', () => {
    mod.setGoal('g');
    mod.completeGoal();
    expect(mod.pauseGoal()).toBeNull();
  });
});

describe('resumeGoal', () => {
  it('transitions paused → active and returns the updated goal', () => {
    mod.setGoal('paused goal');
    mod.pauseGoal();
    const result = mod.resumeGoal();
    expect(result).not.toBeNull();
    expect(result?.status).toBe('active');
    expect(mod.getGoal()?.status).toBe('active');
  });

  it('returns null when no goal exists', () => {
    expect(mod.resumeGoal()).toBeNull();
  });

  it('returns null when goal is already active (no-op)', () => {
    mod.setGoal('g');
    expect(mod.resumeGoal()).toBeNull();
  });

  it('returns null when goal is completed', () => {
    mod.setGoal('g');
    mod.completeGoal();
    expect(mod.resumeGoal()).toBeNull();
  });
});

describe('completeGoal', () => {
  it('transitions active → completed and returns the updated goal', () => {
    mod.setGoal('active goal');
    const result = mod.completeGoal();
    expect(result).not.toBeNull();
    expect(result?.status).toBe('completed');
    expect(mod.getGoal()?.status).toBe('completed');
  });

  it('returns null when no goal exists', () => {
    expect(mod.completeGoal()).toBeNull();
  });

  it('returns null when goal is paused (must resume first)', () => {
    mod.setGoal('g');
    mod.pauseGoal();
    expect(mod.completeGoal()).toBeNull();
  });

  it('returns null when goal is already completed (no-op)', () => {
    mod.setGoal('g');
    mod.completeGoal();
    expect(mod.completeGoal()).toBeNull();
  });
});

describe('clearGoal', () => {
  it('removes the goal and returns true', () => {
    mod.setGoal('to clear');
    expect(mod.clearGoal()).toBe(true);
    expect(mod.getGoal()).toBeNull();
  });

  it('returns false when no goal exists', () => {
    expect(mod.clearGoal()).toBe(false);
  });

  it('can clear a paused or completed goal', () => {
    mod.setGoal('g');
    mod.pauseGoal();
    expect(mod.clearGoal()).toBe(true);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('full lifecycle', () => {
  it('active → paused → active → completed', () => {
    mod.setGoal('full lifecycle');
    expect(mod.pauseGoal()?.status).toBe('paused');
    expect(mod.resumeGoal()?.status).toBe('active');
    expect(mod.completeGoal()?.status).toBe('completed');
    expect(mod.getGoal()?.status).toBe('completed');
  });

  it('set replaces a completed goal with a fresh active one', () => {
    mod.setGoal('old');
    mod.completeGoal();
    const fresh = mod.setGoal('new');
    expect(fresh.status).toBe('active');
    expect(fresh.text).toBe('new');
  });
});
