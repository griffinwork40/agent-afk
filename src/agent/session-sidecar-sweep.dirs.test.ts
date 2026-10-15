/**
 * Tests for the `sessions/<id>/` directory pass of the session sweep.
 * Every test operates on a temp dir passed explicitly as `root`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepSessionDirs } from './session-sidecar-sweep.dirs.js';
import { sweepSessionSidecars } from './session-sidecar-sweep.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Mirrors the 30-day default (DEFAULT_MAX_AGE_DAYS in session-sidecar-sweep.ts).
const MAX_AGE_MS = 30 * DAY_MS;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'afk-session-dir-sweep-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env['AFK_SESSION_MAX_AGE_DAYS'];
  delete process.env['AFK_SESSION_RETENTION_DISABLE'];
});

function backdate(path: string, ms: number): void {
  const when = new Date(ms);
  utimesSync(path, when, when);
}

/** Session dir with a ledger, journal, and a nested blob, all aged to `mtimeMs`. */
function makeSessionDir(id: string, mtimeMs: number, journalMeta?: object): string {
  const dir = join(root, id);
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  const files = [join(dir, 'events.jsonl'), join(dir, 'journal.jsonl'), join(dir, 'blobs', 'abc.txt')];
  writeFileSync(files[0]!, '{}\n');
  writeFileSync(files[1]!, JSON.stringify(journalMeta ?? { v: 1, kind: 'meta', sessionId: id }) + '\n');
  writeFileSync(files[2]!, 'blob');
  for (const f of files) backdate(f, mtimeMs);
  backdate(join(dir, 'blobs'), mtimeMs);
  backdate(dir, mtimeMs);
  return dir;
}

const sweep = (extra: { activeSessionId?: string } = {}): Promise<number> =>
  sweepSessionDirs({ root, now: Date.now(), maxAgeMs: MAX_AGE_MS, graceMs: HOUR_MS, ...extra });

describe('sweepSessionDirs', () => {
  it('removes a dir whose newest content is older than the max age', async () => {
    // 40 days — beyond the 30-day MAX_AGE_MS used by the default sweep.
    const old = makeSessionDir('old-session', Date.now() - 40 * DAY_MS);
    expect(await sweep()).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it('keeps a dir whose newest content is within the 30-day window', async () => {
    // 20 days is inside the 30-day window; must survive.
    const fresh = makeSessionDir('fresh-session', Date.now() - 20 * DAY_MS);
    expect(await sweep()).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it('keeps a dir just inside the 30-day window (29 days old)', async () => {
    // 29 days is safely below the 30-day MAX_AGE_MS; the dir must survive.
    // (An exact 30-day fixture is timing-sensitive because sweep() calls Date.now()
    // independently from backdate(), so we use 29 days for a stable test.)
    const boundary = makeSessionDir('just-inside-session', Date.now() - 29 * DAY_MS);
    expect(await sweep()).toBe(0);
    expect(existsSync(boundary)).toBe(true);
  });

  it('removes a dir at 31 days (just past the 30-day boundary)', async () => {
    const past = makeSessionDir('just-past', Date.now() - 31 * DAY_MS);
    const within = makeSessionDir('within-window', Date.now() - 29 * DAY_MS);
    expect(await sweep()).toBe(1);
    expect(existsSync(past)).toBe(false);
    expect(existsSync(within)).toBe(true);
  });

  it('keeps a dir touched inside the grace window even when max age is tiny', async () => {
    const recent = makeSessionDir('grace-session', Date.now() - 10 * 60 * 1000);
    const removed = await sweepSessionDirs({ root, now: Date.now(), maxAgeMs: 1, graceMs: HOUR_MS });
    expect(removed).toBe(0);
    expect(existsSync(recent)).toBe(true);
  });

  it('keeps the active session dir by identity, however old', async () => {
    const active = makeSessionDir('active-session', Date.now() - 40 * DAY_MS);
    expect(await sweep({ activeSessionId: 'active-session' })).toBe(0);
    expect(existsSync(active)).toBe(true);
  });

  it('keeps an old dir whose journal was appended to recently (dir mtime stays old)', async () => {
    const dir = makeSessionDir('appended-session', Date.now() - 40 * DAY_MS);
    appendFileSync(join(dir, 'journal.jsonl'), '{"kind":"append"}\n');
    // Appending does not bump the directory mtime; force it old to be sure.
    backdate(dir, Date.now() - 40 * DAY_MS);
    expect(await sweep()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps an old dir whose nested file was written recently', async () => {
    const dir = makeSessionDir('nested-session', Date.now() - 40 * DAY_MS);
    mkdirSync(join(dir, 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'subagents', 'child.jsonl'), '{}\n');
    backdate(dir, Date.now() - 40 * DAY_MS);
    expect(await sweep()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps an old fork parent whose blobs a surviving fork journal references', async () => {
    const parent = makeSessionDir('parent-session', Date.now() - 40 * DAY_MS);
    const child = makeSessionDir('child-session', Date.now() - 2 * DAY_MS, {
      v: 1, kind: 'meta', sessionId: 'child-session', forkedFrom: { sessionId: 'parent-session', length: 2 },
    });
    const unrelated = makeSessionDir('unrelated-session', Date.now() - 40 * DAY_MS);
    expect(await sweep()).toBe(1);
    expect(existsSync(parent)).toBe(true);
    expect(existsSync(child)).toBe(true);
    expect(existsSync(unrelated)).toBe(false);
  });

  it('protects the ACTIVE fork child\'s stale parent chain but never removes the active dir', async () => {
    const grandparent = makeSessionDir('gp-session', Date.now() - 50 * DAY_MS);
    const parent = makeSessionDir('parent-session', Date.now() - 40 * DAY_MS, {
      v: 1, kind: 'meta', sessionId: 'parent-session', forkedFrom: { sessionId: 'gp-session', length: 1 },
    });
    // The running session is itself an old /fork child: excluded from removal
    // by identity, but its forkedFrom chain must still be kept.
    const active = makeSessionDir('active-fork', Date.now() - 40 * DAY_MS, {
      v: 1, kind: 'meta', sessionId: 'active-fork', forkedFrom: { sessionId: 'parent-session', length: 2 },
    });
    const unrelated = makeSessionDir('unrelated-session', Date.now() - 40 * DAY_MS);
    expect(await sweep({ activeSessionId: 'active-fork' })).toBe(1);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(parent)).toBe(true);
    expect(existsSync(grandparent)).toBe(true);
    expect(existsSync(unrelated)).toBe(false);
  });

  it('never touches flat sidecar files or unsafe names', async () => {
    const sidecar = join(root, 'old.json');
    writeFileSync(sidecar, '{}');
    backdate(sidecar, Date.now() - 40 * DAY_MS);
    const weird = join(root, 'has.dot');
    mkdirSync(weird);
    backdate(weird, Date.now() - 40 * DAY_MS);
    expect(await sweep()).toBe(0);
    expect(existsSync(sidecar)).toBe(true);
    expect(existsSync(weird)).toBe(true);
  });

  it('counts a failed removal as not removed and never throws', async () => {
    makeSessionDir('old-session', Date.now() - 40 * DAY_MS);
    const removed = await sweepSessionDirs({
      root, now: Date.now(), maxAgeMs: MAX_AGE_MS, graceMs: HOUR_MS,
      _rm: () => Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })),
    });
    expect(removed).toBe(0);
  });

  it('returns 0 for a missing root', async () => {
    const removed = await sweepSessionDirs({ root: join(root, 'nope'), now: Date.now(), maxAgeMs: MAX_AGE_MS, graceMs: HOUR_MS });
    expect(removed).toBe(0);
  });
});

describe('sweepSessionSidecars — directory pass wiring', () => {
  it('removes old session dirs (40 days > 30-day default), honours activeSessionId, and reports evictedDirs', async () => {
    const old = makeSessionDir('old-session', Date.now() - 40 * DAY_MS);
    const active = makeSessionDir('active-session', Date.now() - 40 * DAY_MS);
    const result = await sweepSessionSidecars({ root, force: true, activeSessionId: 'active-session' });
    expect(result.evictedDirs).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(active)).toBe(true);
  });

  it('evicts a 40-day-old session dir under the 30-day default', async () => {
    // 40 days exceeds the 30-day default; must be evicted.
    const dir = makeSessionDir('forty-day-session', Date.now() - 40 * DAY_MS);
    const result = await sweepSessionSidecars({ root, force: true });
    expect(result.evictedDirs).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('explicit 60-day override preserves a 40-day journal dir that the 30-day default evicts', async () => {
    // Confirms the env override is honoured and differs from the 30-day default.
    process.env['AFK_SESSION_MAX_AGE_DAYS'] = '60';
    const dir = makeSessionDir('forty-day-session', Date.now() - 40 * DAY_MS);
    const result = await sweepSessionSidecars({ root, force: true });
    expect(result.evictedDirs).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a journal dir at 29 days (just inside the 30-day window)', async () => {
    // 29 days is safely below the default 30-day threshold; must survive.
    // (An exact 30-day fixture is timing-sensitive because sweepSessionSidecars
    // calls Date.now() independently from backdate(); 29 days gives a stable margin.)
    const dir = makeSessionDir('just-inside-session', Date.now() - 29 * DAY_MS);
    const result = await sweepSessionSidecars({ root, force: true });
    expect(result.evictedDirs).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('removes a journal dir at 31 days (just past the 30-day boundary)', async () => {
    const dir = makeSessionDir('just-past-session', Date.now() - 31 * DAY_MS);
    const result = await sweepSessionSidecars({ root, force: true });
    expect(result.evictedDirs).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('skips the directory pass when the stamp is fresh', async () => {
    const dir = makeSessionDir('old-session', Date.now() - 40 * DAY_MS);
    writeFileSync(join(root, '.last-sweep-sidecars'), 'now\n');
    const result = await sweepSessionSidecars({ root });
    expect(result.skipped).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});
