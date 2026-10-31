import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const fixtures = vi.hoisted(() => ({ floor: [] as string[] }));
vi.mock('./write-denylist.js', () => ({ getUnresolvedWriteDenylist: () => fixtures.floor }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
import { buildSandboxedCommand, _resetBwrapCacheForTests } from './bash-sandbox.js';
import { canonicalSandboxPath, sandboxSchemeString } from './bash-sandbox.paths.js';

let root: string;
let cwd: string;
let temp: string;
let platform: PropertyDescriptor;
beforeEach(() => {
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'afk-sandbox-builder-')));
  cwd = path.join(root, 'workspace');
  temp = path.join(root, 'temp');
  mkdirSync(cwd);
  mkdirSync(temp);
  fixtures.floor = [path.join(root, 'protected')];
  _resetBwrapCacheForTests();
  vi.mocked(execFileSync).mockReset();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  rmSync(root, { recursive: true, force: true });
});
function usePlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('sandbox write-floor security builders (synthetic floor only)', () => {
  it('places every macOS floor deny after the cwd AND temp grants', () => {
    usePlatform('darwin');
    fixtures.floor.push(path.join(cwd, 'absent-token'));
    const profile = buildSandboxedCommand('true', 'workspace-write', cwd, temp).args[1]!;
    const lastGrant = profile.lastIndexOf('(allow file-write*');
    for (const entry of fixtures.floor) {
      expect(profile.indexOf(`(deny file-write* (subpath ${sandboxSchemeString(entry)})`)).toBeGreaterThan(lastGrant);
    }
    expect(profile).toContain('(allow default)');
    expect(profile).toContain('(allow network*)');
  });

  it('encodes quote/backslash payloads as one Scheme string and rejects controls', () => {
    usePlatform('darwin');
    const payload = path.join(cwd, 'x")) (allow file-write*) ;\\tail');
    const profile = buildSandboxedCommand('true', 'workspace-write', payload, temp).args[1]!;
    expect(profile).toContain(`(subpath ${sandboxSchemeString(payload)})`);
    expect(sandboxSchemeString('"\\')).toBe('"\\"\\\\"');
    expect(() => sandboxSchemeString('line\nfeed')).toThrow(/control/);
    expect(() => buildSandboxedCommand('true', 'workspace-write', `${cwd}\n`, temp)).toThrow(/control/);
  });

  it('canonicalizes cwd/temp aliases and missing floor leaves', () => {
    usePlatform('darwin');
    const alias = path.join(root, 'alias');
    symlinkSync(cwd, alias, 'dir');
    fixtures.floor = [path.join(alias, 'missing', 'token')];
    const profile = buildSandboxedCommand('true', 'workspace-write', alias, temp).args[1]!;
    expect(profile).toContain(`(allow file-write* (subpath ${sandboxSchemeString(cwd)}))`);
    expect(profile).toContain(sandboxSchemeString(path.join(cwd, 'missing', 'token')));
    expect(profile).toContain(sandboxSchemeString(fixtures.floor[0]!));
  });

  it('anchors relative child TMPDIR to the effective cwd', () => {
    usePlatform('darwin');
    const profile = buildSandboxedCommand('true', 'workspace-write', cwd, 'relative-temp').args[1]!;
    expect(profile).toContain(sandboxSchemeString(path.join(cwd, 'relative-temp')));
  });

  it('uses implicit process cwd when the caller omits cwd', () => {
    usePlatform('darwin');
    const profile = buildSandboxedCommand('true', 'workspace-write', undefined, temp).args[1]!;
    expect(profile).toContain(sandboxSchemeString(realpathSync(process.cwd())));
  });

  it.each(['cwd-equal', 'cwd-ancestor', 'cwd-descendant', 'cwd-alias', 'temp-equal', 'temp-ancestor', 'temp-descendant', 'temp-alias'])('Linux refuses %s overlap, including absent protected entries', (mode) => {
    usePlatform('linux');
    const grant = mode.startsWith('cwd') ? cwd : temp;
    if (mode.endsWith('equal')) fixtures.floor = [grant];
    if (mode.endsWith('ancestor')) fixtures.floor = [path.join(grant, 'missing-token')];
    if (mode.endsWith('descendant')) fixtures.floor = [root];
    if (mode.endsWith('alias')) {
      const alias = path.join(root, 'alias');
      symlinkSync(grant, alias, 'dir');
      fixtures.floor = [path.join(alias, 'absent-token')];
    }
    expect(() => buildSandboxedCommand('true', 'workspace-write', cwd, temp)).toThrow(/overlaps protected/);
  });

  it('Linux probes and caches the same trusted absolute binary used for execution', () => {
    usePlatform('linux');
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('absent'); });
    const result = buildSandboxedCommand('true', 'read-only', cwd, temp);
    expect(result.shell).toBe('/usr/local/bin/bwrap');
    expect(vi.mocked(execFileSync).mock.calls.map(([binary]) => binary)).toEqual(['/usr/bin/bwrap', '/usr/local/bin/bwrap']);
    expect(execFileSync).toHaveBeenLastCalledWith(result.shell, ['--version'], { stdio: 'ignore', timeout: 3_000 });
    expect(buildSandboxedCommand('true', 'read-only', cwd, temp).shell).toBe(result.shell);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('Linux fails closed when no trusted binary works, without a PATH lookup', () => {
    usePlatform('linux');
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('absent'); });
    expect(() => buildSandboxedCommand('true', 'read-only', cwd, temp)).toThrow(/no sandbox mechanism/);
    expect(vi.mocked(execFileSync).mock.calls.map(([binary]) => binary)).toEqual(['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/usr/sbin/bwrap']);
    expect(() => buildSandboxedCommand('true', 'read-only', cwd, temp)).toThrow(/no sandbox mechanism/);
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it.each(['workspace-write', 'read-only'] as const)('Linux restores descriptor aliases before sealing /dev for %s', (policy) => {
    usePlatform('linux');
    const { args } = buildSandboxedCommand('printf ok > /dev/stdout', policy, cwd, temp);
    const start = args.indexOf('--symlink');
    expect(args.slice(start, start + 14)).toEqual([
      '--symlink', '/proc/self/fd', '/dev/fd',
      '--symlink', '/proc/self/fd/0', '/dev/stdin',
      '--symlink', '/proc/self/fd/1', '/dev/stdout',
      '--symlink', '/proc/self/fd/2', '/dev/stderr',
      '--remount-ro', '/dev',
    ]);
    expect(start).toBeGreaterThan(args.lastIndexOf('--dev-bind'));
  });

  it('Linux binds only disjoint cwd/temp; private proc/dev are remounted read-only', () => {
    usePlatform('linux');
    const result = buildSandboxedCommand('true', 'workspace-write', cwd, temp);
    expect(result.args.slice(0, 10)).toEqual(['--ro-bind', '/', '/', '--cap-drop', 'ALL', '--unshare-pid', '--proc', '/proc', '--remount-ro', '/proc']);
    expect(result.args.slice(-9)).toEqual(['--bind', cwd, cwd, '--bind', temp, temp, '--', '/bin/sh', '-c']);
    expect(result.args.join(' ')).toContain('--remount-ro /dev');
    const devices = result.args.flatMap((arg, i) => arg === '--dev-bind' ? [result.args[i + 1]] : []);
    expect(devices).toEqual(['/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom']);
  });

  it.each(['darwin', 'linux'])('read-only on %s grants no writable filesystems', (os) => {
    usePlatform(os);
    const result = buildSandboxedCommand('true', 'read-only', cwd, temp);
    expect(result.args.join(' ')).not.toContain('(allow file-write*');
    expect(result.args).not.toContain('--bind');
    if (os === 'linux') expect(result.args.join(' ')).toContain('--tmpfs /dev');
    expect(result.args).not.toContain('--dev');
    if (os === 'linux') {
      expect(result.args).toContain('--unshare-pid');
      expect(result.args.slice(result.args.indexOf('--proc'), result.args.indexOf('--proc') + 4)).toEqual(['--proc', '/proc', '--remount-ro', '/proc']);
    }
  });

  it.each(['/proc', '/proc/self', '/dev', '/sys', '/'])('Linux refuses kernel-interface grant %s even as child temp', (grant) => {
    usePlatform('linux');
    expect(() => buildSandboxedCommand('true', 'workspace-write', grant, temp)).toThrow(/overlaps protected/);
    expect(() => buildSandboxedCommand('true', 'workspace-write', cwd, grant)).toThrow(/overlaps protected/);
  });

  it('fails closed on dangling links rather than inventing a lexical target', () => {
    const alias = path.join(root, 'dangling');
    symlinkSync(path.join(root, 'absent'), alias);
    expect(() => canonicalSandboxPath(path.join(alias, 'token'))).toThrow(/dangling/);
  });

  it('unsupported POSIX platforms never use bwrap as an accidental fallback', () => {
    usePlatform('freebsd');
    expect(() => buildSandboxedCommand('true', 'read-only', cwd, temp)).toThrow(/no sandbox mechanism/);
  });
});
