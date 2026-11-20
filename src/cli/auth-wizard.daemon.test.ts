import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDaemonRunning } from './auth-wizard.daemon.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'afk-auth-daemon-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('isDaemonRunning', () => {
  it('is false when there is no lock file', () => {
    expect(isDaemonRunning(join(dir, 'daemon.lock'))).toBe(false);
  });
  it('is true when the lock names a live process', () => {
    const lock = join(dir, 'daemon.lock');
    writeFileSync(lock, `${process.pid}\n`);
    expect(isDaemonRunning(lock)).toBe(true);
  });
  it.each(['', 'not-a-pid', '0', '-4'])('is false for unusable lock content %j', (content) => {
    const lock = join(dir, 'daemon.lock');
    writeFileSync(lock, content);
    expect(isDaemonRunning(lock)).toBe(false);
  });
  it('is false when the lock names a process that is gone', () => {
    const lock = join(dir, 'daemon.lock');
    // Far above any real pid range on the supported platforms.
    writeFileSync(lock, '2147483646');
    expect(isDaemonRunning(lock)).toBe(false);
  });
});
