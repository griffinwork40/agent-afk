/**
 * Tests for the witness-tree retention sweep (#849).
 *
 * The issue's stated acceptance criterion is "a test asserts the bound actually
 * evicts" — not merely that the sweep runs — so the age and byte bounds each
 * have a test proving a directory is gone from disk afterwards.
 *
 * Every test operates on a temp dir passed explicitly as `root`. Nothing here
 * can touch the real `~/.afk`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sweepWitnessTree,
  WITNESS_EVICTION_GRACE_MS,
  WITNESS_MAX_AGE_DAYS_DEFAULT,
  WITNESS_MAX_BYTES_DEFAULT,
} from './witness-sweep.js';

let root: string;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'afk-849-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['AFK_WITNESS_RETENTION_DISABLE'];
});

/** Create a witness session dir whose CONTENT mtime is `ageMs` in the past. */
function makeSession(label: string, ageMs: number, bytes = 64): string {
  const dir = join(root, label);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'trace.jsonl');
  writeFileSync(file, 'x'.repeat(bytes));
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
  return dir;
}

describe('sweepWitnessTree — the age bound actually evicts', () => {
  it('removes a session directory older than the age bound', async () => {
    const old = makeSession('old-session', 40 * DAY_MS);
    const fresh = makeSession('fresh-session', 2 * DAY_MS);

    const result = await sweepWitnessTree({ root, maxAgeDays: 30, force: true });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(result.evictedLabels).toEqual(['old-session']);
    expect(result.evicted).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
  });

  it('keeps everything when nothing exceeds the bound', async () => {
    const a = makeSession('a', 2 * DAY_MS);
    const result = await sweepWitnessTree({ root, maxAgeDays: 30, force: true });
    expect(existsSync(a)).toBe(true);
    expect(result.evicted).toBe(0);
  });
});

describe('sweepWitnessTree — the byte bound actually evicts, oldest first', () => {
  it('evicts oldest-first until the aggregate cap is met', async () => {
    const oldest = makeSession('oldest', 10 * DAY_MS, 400);
    const middle = makeSession('middle', 5 * DAY_MS, 400);
    const newest = makeSession('newest', 3 * DAY_MS, 400);

    // 1200 bytes on disk, cap at 500 → the two oldest must go.
    const result = await sweepWitnessTree({ root, maxAgeDays: 365, maxBytes: 500, force: true });

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(result.evictedLabels).toEqual(['oldest', 'middle']);
  });
});

describe('sweepWitnessTree — safety properties', () => {
  it('never evicts the active session, even when it is over both bounds', async () => {
    const active = makeSession('active-label', 400 * DAY_MS, 5000);

    const result = await sweepWitnessTree({
      root, activeLabel: 'active-label', maxAgeDays: 1, maxBytes: 1, force: true,
    });

    expect(existsSync(active)).toBe(true);
    expect(result.evictedLabels).not.toContain('active-label');
  });

  it('never evicts a directory inside the grace window, however small the cap', async () => {
    const recent = makeSession('recent', WITNESS_EVICTION_GRACE_MS / 2, 5000);
    const result = await sweepWitnessTree({ root, maxAgeDays: 0.001, maxBytes: 1, force: true });
    expect(existsSync(recent)).toBe(true);
    expect(result.evicted).toBe(0);
  });

  it('judges liveness by newest CONTENT mtime, not the directory mtime', async () => {
    // A long-running session appends to trace.jsonl without creating new
    // entries, so the DIRECTORY mtime stays old while the content is current.
    // Directory-mtime-based eviction would delete a live session's trace.
    const dir = join(root, 'appending-session');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'trace.jsonl'), 'fresh content');
    const longAgo = new Date(Date.now() - 400 * DAY_MS);
    utimesSync(dir, longAgo, longAgo); // directory looks ancient

    const result = await sweepWitnessTree({ root, maxAgeDays: 30, force: true });

    expect(existsSync(dir)).toBe(true);
    expect(result.evicted).toBe(0);
  });

  it('is disabled entirely by AFK_WITNESS_RETENTION_DISABLE=1', async () => {
    const old = makeSession('ancient', 400 * DAY_MS);
    process.env['AFK_WITNESS_RETENTION_DISABLE'] = '1';

    const result = await sweepWitnessTree({ root, maxAgeDays: 1, force: true });

    expect(existsSync(old)).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it('never throws on a missing root', async () => {
    const result = await sweepWitnessTree({ root: join(root, 'does-not-exist'), force: true });
    expect(result.evicted).toBe(0);
  });

  it('self-throttles: a second sweep within the interval is skipped', async () => {
    makeSession('old-one', 400 * DAY_MS);
    await sweepWitnessTree({ root, maxAgeDays: 30, force: true }); // writes the stamp

    const second = await sweepWitnessTree({ root, maxAgeDays: 30 });
    expect(second.skipped).toBe(true);
  });

  it('ships generous defaults so installing this version is not a mass delete', () => {
    expect(WITNESS_MAX_AGE_DAYS_DEFAULT).toBe(30);
    expect(WITNESS_MAX_BYTES_DEFAULT).toBe(2 * 1024 * 1024 * 1024);
  });
});
