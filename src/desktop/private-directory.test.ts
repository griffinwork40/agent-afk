import { beforeEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePrivateScreenshotDirectory,
  type PrivateDirectoryExecFile,
} from './private-directory.js';

vi.mock('node:fs/promises', () => ({
  open: vi.fn(),
  mkdir: vi.fn(),
  lstat: vi.fn(),
}));

const handle = {
  stat: vi.fn(),
  chmod: vi.fn(),
  close: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(mkdir).mockResolvedValue(undefined);
  handle.stat.mockResolvedValue({ isDirectory: () => true, uid: 123 });
  handle.chmod.mockResolvedValue(undefined);
  handle.close.mockResolvedValue(undefined);
  vi.stubGlobal('process', Object.assign(Object.create(process), { getuid: () => 123 }));
  vi.mocked(open).mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof open>>);
  vi.mocked(lstat).mockResolvedValue({
    isDirectory: () => true,
    isSymbolicLink: () => false,
  } as Awaited<ReturnType<typeof lstat>>);
});

const platforms: NodeJS.Platform[] = ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'];

describe('private screenshot directory', () => {
  it.each(platforms)('hardens new AND existing directories on %s', async (platform) => {
    const exec = vi.fn<PrivateDirectoryExecFile>().mockResolvedValue({ stdout: '', stderr: '' });
    await ensurePrivateScreenshotDirectory('directory with spaces', { platform, execFile: exec });
    expect(mkdir).toHaveBeenCalledWith('directory with spaces', { recursive: true, mode: 0o700 });
    if (platform === 'win32') {
      expect(lstat).toHaveBeenCalledWith('directory with spaces');
      expect(open).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]?.[0]).toBe('powershell.exe');
      expect(exec.mock.calls[0]?.[2]).toEqual({ timeout: 20_000, windowsHide: true, signal: undefined });
    } else {
      expect(open).toHaveBeenCalledWith('directory with spaces', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      expect(handle.chmod).toHaveBeenCalledWith(0o700);
      expect(handle.close).toHaveBeenCalledOnce();
      expect(lstat).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it('uses module-free .NET ACL methods, verifies ACL, and isolates path data', async () => {
    const dir = "C:\\screenshots\\a 'quoted' [wildcard] ; $name 日本語";
    const exec = vi.fn<PrivateDirectoryExecFile>().mockResolvedValue({ stdout: '', stderr: '' });
    await ensurePrivateScreenshotDirectory(dir, { platform: 'win32', execFile: exec });
    const args = exec.mock.calls[0]![1];
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
    expect(script).toContain(Buffer.from(dir, 'utf8').toString('base64'));
    expect(script).not.toContain(dir);
    expect(script).toContain('[IO.DirectoryInfo]::new($dir)');
    expect(script).toContain('WindowsIdentity]::GetCurrent().User');
    expect(script).toContain('DirectorySecurity]::new()');
    expect(script).toContain('SetAccessRuleProtection($true, $false)');
    expect(script).toContain('SetOwner($sid)');
    expect(script).toContain('ContainerInherit, ObjectInherit');
    expect(script).toContain('$item.SetAccessControl($acl)');
    expect(script).toContain('$item.GetAccessControl()');
    expect(script).toContain("privacy step '$step' failed");
    expect(script).toContain('$rules.Count -ne 1');
    expect(script).toContain('$r.IdentityReference.Value -ne $sid.Value');
    expect(script).toContain('$r.InheritanceFlags -ne $rule.InheritanceFlags');
    expect(script).not.toMatch(/Get-Item|Set-Acl|Get-Acl|env:|USERNAME|USERDOMAIN/);
  });

  it.each([
    Object.assign(new Error('exit 1'), { code: 1, stderr: 'Access denied' }),
    Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('timed out'), { killed: true }),
  ])('propagates Windows ACL failure: $message', async (error) => {
    const exec = vi.fn<PrivateDirectoryExecFile>().mockRejectedValue(error);
    await expect(ensurePrivateScreenshotDirectory('dir', { platform: 'win32', execFile: exec })).rejects.toBe(error);
    expect(handle.chmod).not.toHaveBeenCalled();
  });

  it('passes the abort signal to the Windows child process and propagates cancellation', async () => {
    const controller = new AbortController();
    const error = new Error('AbortError');
    const exec = vi.fn<PrivateDirectoryExecFile>().mockImplementation(async (_file, _args, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort('cancelled');
      throw error;
    });
    await expect(ensurePrivateScreenshotDirectory('dir', {
      platform: 'win32', execFile: exec, signal: controller.signal,
    })).rejects.toBe(error);
  });

  it('propagates mkdir failure before invoking the ACL command', async () => {
    const error = new Error('mkdir denied');
    vi.mocked(mkdir).mockRejectedValue(error);
    const exec = vi.fn<PrivateDirectoryExecFile>();
    await expect(ensurePrivateScreenshotDirectory('dir', { platform: 'win32', execFile: exec })).rejects.toBe(error);
    expect(exec).not.toHaveBeenCalled();
  });

  it('closes the handle and refuses capture on POSIX chmod failure', async () => {
    const error = new Error('chmod denied');
    handle.chmod.mockRejectedValue(error);
    await expect(ensurePrivateScreenshotDirectory('dir', { platform: 'linux' })).rejects.toBe(error);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each([
    { isDirectory: () => false, uid: 123 },
    { isDirectory: () => true, uid: 456 },
  ])('refuses non-directories or another user\'s directory through the open handle', async (info) => {
    handle.stat.mockResolvedValue(info);
    await expect(ensurePrivateScreenshotDirectory('dir', { platform: 'linux' })).rejects.toThrow('owned by the current user');
    expect(handle.chmod).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('refuses a real directory symlink without changing its target mode', async () => {
    vi.unstubAllGlobals();
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-private-symlink-'));
    try {
      const target = join(root, 'target');
      const link = join(root, 'link');
      await fs.mkdir(target, { mode: 0o755 });
      await fs.symlink(target, link, 'junction');
      const before = (await fs.stat(target)).mode;
      vi.mocked(mkdir).mockImplementationOnce(fs.mkdir);
      vi.mocked(open).mockImplementationOnce(fs.open);
      vi.mocked(lstat).mockImplementationOnce(fs.lstat);
      const exec = vi.fn<PrivateDirectoryExecFile>();
      await expect(ensurePrivateScreenshotDirectory(link, { execFile: exec })).rejects.toThrow();
      expect((await fs.stat(target)).mode).toBe(before);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])('rejects Windows links and non-directories (link=%s)', async (link) => {
    vi.mocked(lstat).mockResolvedValue({
      isDirectory: () => link,
      isSymbolicLink: () => link,
    } as Awaited<ReturnType<typeof lstat>>);
    const exec = vi.fn<PrivateDirectoryExecFile>();
    await expect(ensurePrivateScreenshotDirectory('dir', { platform: 'win32', execFile: exec })).rejects.toThrow('real directory');
    expect(exec).not.toHaveBeenCalled();
  });
});
