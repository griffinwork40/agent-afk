/**
 * File-checkpoint retention sweep (#4271): age + byte bounds, identity
 * exclusion of the active session, grace window, rewind lock, stamp throttle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRewindLock, sweepFileCheckpoints, FILE_CHECKPOINT_GRACE_MS } from './retention.js';

const DAY = 24 * 60 * 60 * 1000;
let root: string;
const NOW = Date.UTC(2026, 9, 22);

beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'afk-ckpt-retention-')); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

/** A session dir whose only file has the given age and size. */
function session(name: string, ageMs: number, bytes = 10): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'turn'), { recursive: true });
  const f = path.join(dir, 'turn', 'content');
  writeFileSync(f, Buffer.alloc(bytes));
  const t = (NOW - ageMs) / 1000;
  utimesSync(f, t, t);
  return dir;
}

describe('sweepFileCheckpoints', () => {
  it('evicts sessions past the age bound and keeps fresh ones', async () => {
    const old = session('old', 30 * DAY);
    const fresh = session('fresh', 2 * DAY);
    const result = await sweepFileCheckpoints({ root, now: NOW, force: true, maxAgeDays: 14 });
    expect(result.evicted).toEqual(['old']);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('evicts oldest-first until under the byte cap, never the active session or one inside grace', async () => {
    session('a-oldest', 5 * DAY, 100);
    session('b-active', 4 * DAY, 100);
    session('c-middle', 3 * DAY, 100);
    session('d-grace', FILE_CHECKPOINT_GRACE_MS / 2, 100);
    const result = await sweepFileCheckpoints({ root, now: NOW, force: true, maxBytes: 150, activeSessionId: 'b-active' });
    expect(result.evicted).toEqual(['a-oldest', 'c-middle']);
    expect(existsSync(path.join(root, 'b-active'))).toBe(true);
    expect(existsSync(path.join(root, 'd-grace'))).toBe(true);
  });

  it('skips a session holding a rewind lock from a live process', async () => {
    const dir = session('locked', 30 * DAY);
    // A pid that is really alive on every platform: pid 1 does not exist on
    // Windows, so a literal '1' only passed on POSIX.
    writeFileSync(path.join(dir, '.rewind-lock'), `${process.pid}\n`);
    const lockTime = (NOW - 30 * DAY) / 1000;
    utimesSync(path.join(dir, '.rewind-lock'), lockTime, lockTime);
    const result = await sweepFileCheckpoints({ root, now: NOW, force: true });
    expect(result.evicted).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('a lock or owner left by a dead process does not pin a directory', async () => {
    const dir = session('crashed', 30 * DAY);
    const deadPid = '2147483646\n';
    writeFileSync(path.join(dir, '.rewind-lock'), deadPid);
    writeFileSync(path.join(dir, '.owner'), deadPid);
    const t = (NOW - 30 * DAY) / 1000;
    utimesSync(path.join(dir, '.rewind-lock'), t, t);
    utimesSync(path.join(dir, '.owner'), t, t);
    expect((await sweepFileCheckpoints({ root, now: NOW, force: true })).evicted).toEqual(['crashed']);
  });

  it('never evicts a session whose owner process is alive, even when idle past grace and over the cap', async () => {
    const dir = session('other-repl', 3 * DAY, 500);
    writeFileSync(path.join(dir, '.owner'), `${process.pid}\n`);
    const t = (NOW - 3 * DAY) / 1000;
    utimesSync(path.join(dir, '.owner'), t, t);
    const result = await sweepFileCheckpoints({ root, now: NOW, force: true, maxBytes: 10 });
    expect(result.evicted).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('is throttled by the stamp file unless forced', async () => {
    session('old', 30 * DAY);
    writeFileSync(path.join(root, '.last-sweep'), 'x');
    expect((await sweepFileCheckpoints({ root, now: Date.now() })).skipped).toBe(true);
    expect(existsSync(path.join(root, 'old'))).toBe(true);
  });

  it('is disabled by AFK_FILE_CHECKPOINT_RETENTION_DISABLE=1 and never throws on a missing root', async () => {
    session('old', 30 * DAY);
    vi.stubEnv('AFK_FILE_CHECKPOINT_RETENTION_DISABLE', '1');
    expect((await sweepFileCheckpoints({ root, now: NOW, force: true })).skipped).toBe(true);
    vi.unstubAllEnvs();
    const missing = await sweepFileCheckpoints({ root: path.join(root, 'nope'), now: NOW, force: true });
    expect(missing.evicted).toEqual([]);
  });
});

describe('acquireRewindLock', () => {
  it('creates the lock in the session dir and releases it', () => {
    const release = acquireRewindLock('s1', root);
    const lock = path.join(root, 'file-checkpoints', 's1', '.rewind-lock');
    expect(existsSync(lock)).toBe(true);
    release();
    expect(existsSync(lock)).toBe(false);
  });
});
