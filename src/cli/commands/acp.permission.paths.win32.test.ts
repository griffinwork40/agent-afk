/**
 * Windows containment semantics, exercised on every platform through the
 * explicit `path.win32` / `path.posix` flavour parameter (POSIX-assumption
 * guard: no platform skips). "Inside" for an outside target is a security bug;
 * "outside" for an inside target only asks the user.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isContained, outsidePaths } from './acp.permission.paths.js';
import { grantFits } from './acp.permission.grants.js';

const w = path.win32;
const ROOT = 'C:\\proj';

describe('win32 isContained', () => {
  it('ASCII case, mixed and trailing separators and redundant segments stay inside', () => {
    expect(isContained(ROOT, 'c:\\PROJ\\a.txt', w)).toBe(true);
    expect(isContained('C:\\proj\\', 'C:/proj/src/', w)).toBe(true);
    expect(isContained(ROOT, 'C:\\proj\\x\\..\\y', w)).toBe(true);
    expect(isContained(ROOT, 'c:\\proj', w)).toBe(true);
    expect(isContained('C:\\', 'C:\\anything\\x', w)).toBe(true);
  });
  it('another drive, a prefix sibling, the parent and a drive-relative escape are outside', () => {
    expect(isContained(ROOT, 'D:\\proj\\a.txt', w)).toBe(false);
    expect(isContained(ROOT, 'C:\\proj-evil\\a', w)).toBe(false);
    expect(isContained(ROOT, 'C:\\proj\\..\\other', w)).toBe(false);
    expect(isContained(ROOT, 'C:\\', w)).toBe(false);
  });
  it('UNC: same share inside (any case, either slash), another share or server outside', () => {
    const share = '\\\\srv\\sh\\proj';
    expect(isContained(share, '\\\\SRV\\SH\\proj\\x', w)).toBe(true);
    expect(isContained(share, '//srv/sh/proj/x', w)).toBe(true);
    expect(isContained(share, '\\\\srv\\sh2\\proj\\x', w)).toBe(false);
    expect(isContained(share, '\\\\other\\sh\\proj\\x', w)).toBe(false);
    expect(isContained(ROOT, '\\\\localhost\\C$\\proj\\x', w)).toBe(false);
  });
  it('device and long-path prefixes and 8.3 short names are outside (asked, never allowed)', () => {
    expect(isContained(ROOT, '\\\\?\\C:\\proj\\x', w)).toBe(false);
    expect(isContained(ROOT, '\\\\.\\C:\\proj\\x', w)).toBe(false);
    expect(isContained('C:\\Users\\runneradmin\\t', 'C:\\Users\\RUNNER~1\\t\\x', w)).toBe(false);
  });
  it('a non-ASCII case fold NTFS does not apply is outside (KELVIN SIGN is not k)', () => {
    // path.win32.relative lower-cases with String.toLowerCase: U+212A -> 'k'.
    expect(w.relative('C:\\work', 'C:\\wor\u212A\\x')).toBe('x');
    expect(isContained('C:\\work', 'C:\\wor\u212A\\x', w)).toBe(false);
    expect(isContained('C:\\i', 'C:\\\u0130\\x', w)).toBe(false);
  });
  it('a segment Win32 would trim (trailing dot or space) is outside', () => {
    expect(isContained(ROOT, 'C:\\proj\\.. \\x', w)).toBe(false);
    expect(isContained(ROOT, 'C:\\proj\\...\\x', w)).toBe(false);
    expect(isContained(ROOT, 'C:\\proj\\a. \\x', w)).toBe(false);
  });
  it('posix flavour is unchanged: case-sensitive, no trimming', () => {
    expect(isContained('/proj', '/proj/a', path.posix)).toBe(true);
    expect(isContained('/proj', '/PROJ/a', path.posix)).toBe(false);
    expect(isContained('/proj', '/proj/... /x', path.posix)).toBe(true);
  });
});

describe('win32 outsidePaths and grants', () => {
  it('drive-relative paths resolve on their own drive', () => {
    expect(outsidePaths('read_file', { file_path: 'C:a.txt' }, ROOT, undefined, w)).toEqual([]);
    expect(outsidePaths('read_file', { file_path: 'D:a.txt' }, ROOT, undefined, w)).toHaveLength(1);
  });
  it('a rooted path without a drive is outside: it names the process drive, not the session drive', () => {
    expect(outsidePaths('read_file', { file_path: '\\proj\\a.txt' }, ROOT, undefined, w)).toEqual(['\\proj\\a.txt']);
    expect(outsidePaths('read_file', { file_path: '/proj/a.txt' }, ROOT, undefined, w)).toEqual(['/proj/a.txt']);
    expect(grantFits('write_file', { file_path: '\\proj\\a.txt' }, ROOT, undefined, w)).toBe(false);
  });
  it('a drive-root glob walks from the drive root, not the session cwd', () => {
    expect(outsidePaths('glob', { pattern: 'C:/**/*.ts' }, ROOT, undefined, w)).toEqual(['C:\\']);
    expect(outsidePaths('glob', { pattern: 'D:\\**' }, ROOT, undefined, w)).toEqual(['D:\\']);
    expect(outsidePaths('glob', { pattern: 'C:/proj/src/**' }, ROOT, undefined, w)).toEqual([]);
  });
  it('grants: case and separator variants fit, another drive or share does not', () => {
    expect(grantFits('write_file', { file_path: 'c:/PROJ/a.txt' }, ROOT, undefined, w)).toBe(true);
    expect(grantFits('write_file', { file_path: 'sub\\a.txt' }, ROOT, undefined, w)).toBe(true);
    expect(grantFits('write_file', { file_path: 'D:\\proj\\a.txt' }, ROOT, undefined, w)).toBe(false);
    expect(grantFits('write_file', { file_path: '\\\\srv\\sh\\a.txt' }, ROOT, undefined, w)).toBe(false);
    expect(grantFits('write_file', { file_path: 'a.txt' }, '\\proj', undefined, w)).toBe(false);
  });
});
