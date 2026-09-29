// Regression (#703 Windows leg): on win32, host `path.resolve('/dev/null')` is
// `D:\dev\null`, so no POSIX device sink or scratch root ever matched and every
// `2>/dev/null` fired the path-escape advisory. This file runs the module
// against win32 `path` semantics on any host. It is a separate file because
// `vi.mock` is file-scoped, and because on a POSIX host `path === path.posix`,
// so spying on `path.resolve` would also clobber the posix resolver the fix uses.
import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  const win = { ...actual.win32, posix: actual.posix, win32: actual.win32 };
  return { ...win, default: win };
});

const { isBashScanExemptPath, _resetScanExemptCacheForTests } = await import('./bash-scan-exempt.js');

const WIN_TMP = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';

describe('isBashScanExemptPath under win32 path semantics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetScanExemptCacheForTests();
  });

  function stubWinTmp(): void {
    vi.spyOn(os, 'tmpdir').mockReturnValue(WIN_TMP);
    _resetScanExemptCacheForTests();
  }

  it.each(['/dev/null', '/dev/stderr', '/dev/fd/63', '/tmp', '/tmp/x', '/var/tmp/x', '/private/tmp/x'])(
    'exempts POSIX-shaped benign path %s',
    (p) => {
      stubWinTmp();
      expect(isBashScanExemptPath(p)).toBe(true);
    },
  );

  it.each(['/tmp/../etc/hosts', '/etc/hosts', '/dev/sda', '/tmpfoo/x'])(
    'does NOT exempt POSIX-shaped path %s',
    (p) => {
      stubWinTmp();
      expect(isBashScanExemptPath(p)).toBe(false);
    },
  );

  it('keeps host semantics for native win32 paths under os.tmpdir()', () => {
    stubWinTmp();
    expect(isBashScanExemptPath(`${WIN_TMP}\\afk-probe.txt`)).toBe(true);
    expect(isBashScanExemptPath(`${WIN_TMP}\\..\\secrets.txt`)).toBe(false);
    expect(isBashScanExemptPath('C:\\Users\\someone\\project\\a.ts')).toBe(false);
  });
});
