/**
 * Tests for the session sidecar retention sweep.
 *
 * Every test operates on a temp dir passed explicitly as `root`. Nothing here
 * can touch the real `~/.afk`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepSessionSidecars } from './session-sidecar-sweep.js';

let root: string;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'afk-sidecar-sweep-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['AFK_SESSION_RETENTION_DISABLE'];
  delete process.env['AFK_SESSION_MAX_AGE_DAYS'];
  delete process.env['AFK_SESSION_MAX_COUNT'];
});

/**
 * Write a fake session sidecar JSON file with the given savedAt timestamp.
 * Optionally backdate the filesystem mtime as well.
 */
function makeSidecar(name: string, savedAtMs: number, backdateMtimeMs?: number): string {
  const path = join(root, `${name}.json`);
  writeFileSync(path, JSON.stringify({ savedAt: savedAtMs, model: 'test' }));
  if (backdateMtimeMs !== undefined) {
    const when = new Date(backdateMtimeMs);
    utimesSync(path, when, when);
  }
  return path;
}

describe('sweepSessionSidecars — age pass', () => {
  it('evicts sidecars older than maxAgeDays and keeps recent ones', async () => {
    const now = Date.now();
    const old = makeSidecar('old-session', now - 40 * DAY_MS);
    const fresh = makeSidecar('fresh-session', now - 2 * DAY_MS);

    const result = await sweepSessionSidecars({ root, force: true });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.evictedAge).toBe(1);
    expect(result.evictedCount).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it('keeps everything when nothing exceeds the age bound', async () => {
    const now = Date.now();
    const a = makeSidecar('recent-a', now - 2 * DAY_MS);
    const b = makeSidecar('recent-b', now - 5 * DAY_MS);

    const result = await sweepSessionSidecars({ root, force: true });

    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(result.evictedAge).toBe(0);
    expect(result.evictedCount).toBe(0);
    expect(result.remaining).toBe(2);
  });
});

describe('sweepSessionSidecars — count pass', () => {
  it('evicts oldest-first when over maxCount', async () => {
    const now = Date.now();
    const oldest = makeSidecar('oldest', now - 10 * DAY_MS);
    const middle = makeSidecar('middle', now - 5 * DAY_MS);
    const newest = makeSidecar('newest', now - 3 * DAY_MS);

    // Set maxCount to 1 — only newest should survive.
    process.env['AFK_SESSION_MAX_COUNT'] = '1';
    const result = await sweepSessionSidecars({ root, force: true });

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(result.evictedCount).toBe(2);
    expect(result.remaining).toBe(1);
  });
});

describe('sweepSessionSidecars — grace window', () => {
  it('never evicts a file with a very recent savedAt, even when mtime is old', async () => {
    const now = Date.now();
    // savedAt is very recent (5 minutes ago) — should be protected by grace window.
    const path = makeSidecar('active-session', now - 5 * 60 * 1000);
    // Backdate the mtime to look ancient on disk.
    const longAgo = new Date(now - 400 * DAY_MS);
    utimesSync(path, longAgo, longAgo);

    process.env['AFK_SESSION_MAX_AGE_DAYS'] = '0.001';
    const result = await sweepSessionSidecars({ root, force: true });

    expect(existsSync(path)).toBe(true);
    expect(result.evictedAge).toBe(0);
    expect(result.evictedCount).toBe(0);
  });
});

describe('sweepSessionSidecars — skips non-.json files and subdirectories', () => {
  it('ignores non-.json files in the sessions dir', async () => {
    const now = Date.now();
    // Old .json sidecar — should be evicted.
    const jsonPath = makeSidecar('old-session', now - 40 * DAY_MS);
    // A non-.json file — must not be touched.
    const txtPath = join(root, 'notes.txt');
    writeFileSync(txtPath, 'keep me');
    // A subdirectory (ledger dir) — must not be touched.
    const subdir = join(root, 'abc123');
    mkdirSync(subdir);
    writeFileSync(join(subdir, 'events.jsonl'), 'data');

    const result = await sweepSessionSidecars({ root, force: true });

    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(txtPath)).toBe(true);
    expect(existsSync(subdir)).toBe(true);
    expect(result.evictedAge).toBe(1);
  });
});

describe('sweepSessionSidecars — stamp throttling', () => {
  it('skips a second sweep within the 6-hour interval', async () => {
    const now = Date.now();
    makeSidecar('old', now - 40 * DAY_MS);

    // First sweep writes the stamp.
    const first = await sweepSessionSidecars({ root, force: true });
    expect(first.skipped).toBe(false);

    // Second sweep (no force) should be skipped.
    const second = await sweepSessionSidecars({ root });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('stamp');
  });
});

describe('sweepSessionSidecars — disabled via env', () => {
  it('returns skipped:true when AFK_SESSION_RETENTION_DISABLE=1', async () => {
    const now = Date.now();
    const path = makeSidecar('ancient', now - 400 * DAY_MS);
    process.env['AFK_SESSION_RETENTION_DISABLE'] = '1';

    const result = await sweepSessionSidecars({ root, force: true });

    expect(existsSync(path)).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('disabled');
  });
});

describe('sweepSessionSidecars — corrupt JSON fallback', () => {
  it('falls back to mtime for corrupt JSON and still evicts by age', async () => {
    const now = Date.now();
    // Write corrupt JSON.
    const path = join(root, 'corrupt-session.json');
    writeFileSync(path, '{not valid json!!!');
    // Backdate mtime to look old.
    const oldDate = new Date(now - 40 * DAY_MS);
    utimesSync(path, oldDate, oldDate);

    const result = await sweepSessionSidecars({ root, force: true });

    expect(existsSync(path)).toBe(false);
    expect(result.evictedAge).toBe(1);
  });

  it('falls back to mtime for valid JSON without savedAt field', async () => {
    const now = Date.now();
    const path = join(root, 'no-savedat.json');
    writeFileSync(path, JSON.stringify({ model: 'test', label: 'something' }));
    // Backdate mtime to look old.
    const oldDate = new Date(now - 40 * DAY_MS);
    utimesSync(path, oldDate, oldDate);

    const result = await sweepSessionSidecars({ root, force: true });

    expect(existsSync(path)).toBe(false);
    expect(result.evictedAge).toBe(1);
  });
});

describe('sweepSessionSidecars — missing root', () => {
  it('never throws on a missing root', async () => {
    const result = await sweepSessionSidecars({ root: join(root, 'does-not-exist'), force: true });
    expect(result.evictedAge).toBe(0);
    expect(result.evictedCount).toBe(0);
  });
});
