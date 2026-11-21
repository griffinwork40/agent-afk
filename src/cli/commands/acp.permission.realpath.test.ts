/**
 * "Always allow" grant fit by REAL path (profile section 6, D18): a symbolic
 * link or junction inside the session directory must not carry a remembered
 * grant outside it or onto a sensitive target. Real filesystem under the OS
 * temp directory (itself a symlink on macOS); no platform skips. Where Windows
 * refuses a directory symlink (EPERM without the privilege) a junction is used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantFits } from './acp.permission.grants.js';
import { nativeProbe, realTarget, type FsProbe } from './acp.permission.realpath.js';

let top = '';
let cwd = '';
let outside = '';

function linkDir(target: string, link: string): void {
  try {
    fs.symlinkSync(target, link, 'dir');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    fs.symlinkSync(target, link, 'junction');
  }
}

beforeAll(() => {
  top = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-grant-real-'));
  cwd = path.join(top, 'session');
  outside = path.join(top, 'elsewhere');
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.git', 'config'), '');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'victim.txt'), '');
  linkDir(outside, path.join(cwd, 'ext'));
  linkDir(path.join(cwd, '.git'), path.join(cwd, 'cfg'));
  linkDir(cwd, path.join(top, 'alias'));
  linkDir(path.join(outside, 'missing'), path.join(cwd, 'dangle'));
});

afterAll(() => {
  fs.rmSync(top, { recursive: true, force: true });
});

const write = (file_path: string) => ({ file_path, content: 'x' });

describe('grant fit by real path (A1)', () => {
  it('a write under a link that points outside the session directory is not covered', () => {
    expect(grantFits('write_file', write('ext/victim.txt'), cwd)).toBe(false);
    expect(grantFits('write_file', write(path.join(cwd, 'ext', 'victim.txt')), cwd)).toBe(false);
    expect(grantFits('edit_file', { file_path: 'ext/victim.txt', old_string: 'a', new_string: 'b' }, cwd)).toBe(false);
    expect(grantFits('patch_apply', { changes: [{ path: 'sub/ok.txt' }, { path: 'ext/victim.txt' }] }, cwd)).toBe(false);
  });

  it('a link to a directory holding a sensitive file is not covered', () => {
    expect(grantFits('write_file', write('cfg/config'), cwd)).toBe(false);
    expect(grantFits('write_file', write('cfg/hooks/pre-commit'), cwd)).toBe(false);
  });

  it('a link straight to a sensitive file is not covered (file links faked: Windows may refuse them)', () => {
    const probe: FsProbe = {
      realpath: (p) => {
        if (p === path.join(cwd, 'notes.md')) return path.join(cwd, '.git', 'config');
        return nativeProbe.realpath(p);
      },
      lexists: nativeProbe.lexists,
    };
    expect(grantFits('write_file', write('notes.md'), cwd, undefined, path, probe)).toBe(false);
  });

  it('a not-yet-existing file below a linked directory is not covered', () => {
    expect(grantFits('write_file', write('ext/new/dir/file.txt'), cwd)).toBe(false);
    expect(grantFits('write_file', write('ext/new.txt'), cwd)).toBe(false);
  });

  it('a dangling link is not covered (writing through it creates its target)', () => {
    expect(grantFits('write_file', write('dangle'), cwd)).toBe(false);
    expect(grantFits('write_file', write('dangle/x.txt'), cwd)).toBe(false);
  });

  it('ordinary new files in ordinary subdirectories are still covered', () => {
    expect(grantFits('write_file', write('sub/new.txt'), cwd)).toBe(true);
    expect(grantFits('write_file', write('sub/deeper/still/new.txt'), cwd)).toBe(true);
    expect(grantFits('write_file', write(path.join(cwd, 'top.txt')), cwd)).toBe(true);
  });

  it('a session directory reached through a symlinked path still covers ordinary writes', () => {
    const alias = path.join(top, 'alias');
    expect(grantFits('write_file', write('sub/new.txt'), alias)).toBe(true);
    expect(grantFits('write_file', write(path.join(alias, 'sub', 'new.txt')), alias)).toBe(true);
    // Mixed spellings are lexically outside first, so they are asked (an annoyance, never an unsafe allow).
    expect(grantFits('write_file', write(path.join(cwd, 'sub', 'new.txt')), alias)).toBe(false);
    expect(grantFits('write_file', write(path.join(alias, 'ext', 'victim.txt')), alias)).toBe(false);
  });

  it('resolution failure or doubt fails closed', () => {
    const throwing: FsProbe = { realpath: () => { throw new Error('EACCES'); }, lexists: () => { throw new Error('EACCES'); } };
    expect(grantFits('write_file', write('sub/new.txt'), cwd, undefined, path, throwing)).toBe(false);
    const relative: FsProbe = { realpath: () => 'not/absolute', lexists: () => true };
    expect(grantFits('write_file', write('sub/new.txt'), cwd, undefined, path, relative)).toBe(false);
    // A component that exists but cannot be resolved (loop, dangling link) is not walked past.
    const loop: FsProbe = { realpath: () => { throw new Error('ELOOP'); }, lexists: () => true };
    expect(grantFits('write_file', write('sub/new.txt'), cwd, undefined, path, loop)).toBe(false);
  });
});

describe('realTarget (pure, injected file system)', () => {
  const fake = (links: Record<string, string>, existing: string[]): FsProbe => ({
    realpath: (p) => {
      const to = links[p];
      if (to !== undefined) return to;
      if (existing.includes(p)) return p;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    lexists: (p) => existing.includes(p) || Object.keys(links).includes(p),
  });

  it('re-appends the part that does not exist yet to the nearest existing ancestor', () => {
    const probe = fake({ '/tmp': '/private/tmp' }, ['/', '/tmp']);
    expect(realTarget('/tmp/a/b.txt', path.posix, probe)).toBe('/private/tmp/a/b.txt');
    expect(realTarget('/tmp', path.posix, probe)).toBe('/private/tmp');
  });

  it('Windows flavour: a junction is followed and a missing tail re-appended', () => {
    const probe: FsProbe = {
      realpath: (p) => {
        if (p === 'C:\\proj\\j') return 'D:\\far';
        if (p === 'C:\\proj' || p === 'C:\\') return p;
        throw new Error('ENOENT');
      },
      lexists: (p) => ['C:\\proj', 'C:\\proj\\j', 'C:\\'].includes(p),
    };
    expect(realTarget('C:\\proj\\j\\new\\x.txt', path.win32, probe)).toBe('D:\\far\\new\\x.txt');
    expect(grantFits('write_file', write('j\\new\\x.txt'), 'C:\\proj', undefined, path.win32, probe)).toBe(false);
    expect(grantFits('write_file', write('ok\\x.txt'), 'C:\\proj', undefined, path.win32, probe)).toBe(true);
  });
});
