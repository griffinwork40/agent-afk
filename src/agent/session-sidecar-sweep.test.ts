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
  unlinkSync,
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

describe('sweepSessionSidecars — activeSessionId exclusion (Item 4)', () => {
  it('skips the active session sidecar by identity', async () => {
    const now = Date.now();
    // An old sidecar that would normally be evicted.
    const oldPath = makeSidecar('old-session', now - 40 * DAY_MS);
    // The active session's sidecar — also old but must be excluded.
    const activeId = 'active-session-id';
    const activePath = makeSidecar(activeId, now - 40 * DAY_MS);

    const result = await sweepSessionSidecars({ root, force: true, activeSessionId: activeId });

    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(activePath)).toBe(true);
    expect(result.evictedAge).toBe(1);
  });
});

describe('sweepSessionSidecars — future savedAt clamped (Item 2)', () => {
  it('treats a future savedAt as age 0 and respects the grace window', async () => {
    const now = Date.now();
    // savedAt is 1 hour in the future — without clamping this produces
    // a negative ageMs that excludes the file from both passes permanently.
    // With clamping it becomes ageMs=0, which is within the grace window
    // (< GRACE_MS = 1h), so the file is kept — correctly.
    const path = makeSidecar('future-session', now + 60 * 60 * 1000);

    process.env['AFK_SESSION_MAX_AGE_DAYS'] = '0.001'; // extremely short age bound
    const result = await sweepSessionSidecars({ root, force: true });

    // File should survive: clamped to ageMs=0, inside grace window.
    expect(existsSync(path)).toBe(true);
    expect(result.evictedAge).toBe(0);
  });

  it('does not permanently exclude a file with a future savedAt from count eviction', async () => {
    const now = Date.now();
    // Two sidecars: one old (will be count-evicted), one with future savedAt.
    // The future-dated one gets ageMs=0 (inside grace window), so it is
    // NOT a count candidate — but the old one IS.
    const oldPath = makeSidecar('old-a', now - 10 * DAY_MS);
    makeSidecar('future-b', now + DAY_MS);

    process.env['AFK_SESSION_MAX_COUNT'] = '1';
    const result = await sweepSessionSidecars({ root, force: true });

    // old-a should be count-evicted; future-b stays (grace window).
    expect(existsSync(oldPath)).toBe(false);
    expect(result.evictedCount).toBe(1);
    expect(result.remaining).toBe(1);
  });
});

describe('sweepSessionSidecars — unlink failure counter correctness (Item 1)', () => {
  it('decrements evictedCount (not evictedAge) when a count-doomed unlink fails', async () => {
    const now = Date.now();
    // Three old sidecars; set maxCount=1 so two get count-doomed.
    const oldest = makeSidecar('oldest', now - 10 * DAY_MS);
    const middle = makeSidecar('middle', now - 5 * DAY_MS);
    makeSidecar('newest', now - 3 * DAY_MS);

    process.env['AFK_SESSION_MAX_COUNT'] = '1';

    // Inject a failing unlink for `oldest`; fall through to real unlink otherwise.
    const injectedUnlink = async (p: string): Promise<void> => {
      if (p === oldest) throw Object.assign(new Error('EPERM simulated'), { code: 'EPERM' });
      unlinkSync(p);
    };

    const result = await sweepSessionSidecars({ root, force: true, _unlink: injectedUnlink });

    // oldest unlink failed → evictedCount decremented from 2 back to 1.
    expect(result.evictedCount).toBe(1);
    expect(result.evictedAge).toBe(0);
    // oldest still on disk (unlink failed); middle removed.
    expect(existsSync(oldest)).toBe(true);
    expect(existsSync(middle)).toBe(false);
    // remaining = 3 total - 1 actually evicted = 2
    expect(result.remaining).toBe(2);
  });

  it('decrements evictedAge (not evictedCount) when an age-doomed unlink fails', async () => {
    const now = Date.now();
    // Two very old sidecars — both will be age-doomed.
    const target = makeSidecar('age-fail', now - 40 * DAY_MS);
    const other = makeSidecar('age-ok', now - 35 * DAY_MS);

    // Inject a failing unlink for `target` only; fall through to real unlink otherwise.
    const injectedUnlink = async (p: string): Promise<void> => {
      if (p === target) throw Object.assign(new Error('EACCES simulated'), { code: 'EACCES' });
      unlinkSync(p);
    };

    const result = await sweepSessionSidecars({ root, force: true, _unlink: injectedUnlink });

    // One age-unlink failed → evictedAge decremented from 2 to 1.
    expect(result.evictedAge).toBe(1);
    expect(result.evictedCount).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });
});

describe('sweepSessionSidecars — combined age + count eviction (Item 7)', () => {
  it('evicts some files by age and others by count in the same run', async () => {
    const now = Date.now();
    // ancient → age-evicted.
    const ancient = makeSidecar('ancient', now - 60 * DAY_MS);
    // old-a and old-b → count-evicted (survive age pass but over maxCount=1).
    const oldA = makeSidecar('old-a', now - 10 * DAY_MS);
    const oldB = makeSidecar('old-b', now - 5 * DAY_MS);
    // newest → survives both passes.
    const newest = makeSidecar('newest', now - 3 * DAY_MS);

    process.env['AFK_SESSION_MAX_COUNT'] = '1';
    const result = await sweepSessionSidecars({ root, force: true });

    expect(existsSync(ancient)).toBe(false);
    expect(existsSync(oldA)).toBe(false);
    expect(existsSync(oldB)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    // 1 age-evicted, 2 count-evicted.
    expect(result.evictedAge).toBe(1);
    expect(result.evictedCount).toBe(2);
    expect(result.remaining).toBe(1);
  });
});
