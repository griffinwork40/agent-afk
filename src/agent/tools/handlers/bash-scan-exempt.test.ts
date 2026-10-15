import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import { realpathSync } from 'fs';
import { isBashScanExemptPath, scanCandidatePaths, _resetScanExemptCacheForTests } from './bash-scan-exempt.js';

describe('scanCandidatePaths', () => {
  it('expands ~ and ~/..., and drops exempt sinks and scratch paths', () => {
    expect(
      scanCandidatePaths('cat ~/notes/a.txt /etc/hosts 2>/dev/null >/tmp/out; cd ~', '/home/u'),
    ).toEqual(['/home/u/notes/a.txt', '/etc/hosts', '/home/u']);
  });

  it('returns nothing for a command with only benign paths', () => {
    expect(scanCandidatePaths('ls 2>/dev/null | tee /tmp/x >/dev/stderr', '/home/u')).toEqual([]);
  });
});

describe('isBashScanExemptPath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetScanExemptCacheForTests();
  });

  it.each([
    '/dev/null',
    '/dev/zero',
    '/dev/stdin',
    '/dev/stdout',
    '/dev/stderr',
    '/dev/tty',
    '/dev/random',
    '/dev/urandom',
    '/dev/fd/0',
    '/dev/fd/63',
  ])('exempts device sink %s', (p) => {
    expect(isBashScanExemptPath(p)).toBe(true);
  });

  it.each(['/dev/disk2', '/dev/sda', '/dev/fd', '/dev/fd/x', '/dev/nullx', '/dev'])(
    'does NOT exempt non-allowlisted device path %s',
    (p) => {
      expect(isBashScanExemptPath(p)).toBe(false);
    },
  );

  it.each(['/tmp', '/tmp/x', '/tmp/a/b.txt', '/private/tmp/x', '/var/tmp/x'])(
    'exempts scratch path %s',
    (p) => {
      expect(isBashScanExemptPath(p)).toBe(true);
    },
  );

  it('exempts paths under os.tmpdir() and its realpath', () => {
    const tmp = os.tmpdir();
    expect(isBashScanExemptPath(`${tmp}/afk-probe.txt`)).toBe(true);
    expect(isBashScanExemptPath(`${realpathSync.native(tmp)}/afk-probe.txt`)).toBe(true);
  });

  it('honours a stubbed os.tmpdir() after the cache is reset', () => {
    vi.spyOn(os, 'tmpdir').mockReturnValue('/scratch/custom');
    _resetScanExemptCacheForTests();
    expect(isBashScanExemptPath('/scratch/custom/file')).toBe(true);
    expect(isBashScanExemptPath('/scratch/customer/file')).toBe(false);
  });

  it.each([
    '/tmp/../etc/hosts',
    '/tmpfoo/x',
    '/etc/hosts',
    '/Users/someone/project/file.ts',
    '/',
  ])('does NOT exempt %s', (p) => {
    expect(isBashScanExemptPath(p)).toBe(false);
  });

  it('does NOT exempt relative input', () => {
    expect(isBashScanExemptPath('tmp/x')).toBe(false);
    expect(isBashScanExemptPath('dev/null')).toBe(false);
  });
});
