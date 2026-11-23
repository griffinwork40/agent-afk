import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import {
  ensurePrivateScreenshotDirectory,
  type PrivateDirectoryExecFile,
} from './private-directory.js';

vi.mock('node:fs/promises', () => ({
  chmod: vi.fn(),
  mkdir: vi.fn(),
  lstat: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(mkdir).mockResolvedValue(undefined);
  vi.mocked(chmod).mockResolvedValue(undefined);
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
    expect(lstat).toHaveBeenCalledWith('directory with spaces');
    if (platform === 'win32') {
      expect(chmod).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]?.[0]).toBe('powershell.exe');
      expect(exec.mock.calls[0]?.[2]).toEqual({ timeout: 20_000, windowsHide: true });
    } else {
      expect(chmod).toHaveBeenCalledWith('directory with spaces', 0o700);
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it('uses current token SID, replaces every ACE, verifies ACL, and isolates path data', async () => {
    const dir = "C:\\screenshots\\a 'quoted' [wildcard] ; $name 日本語";
    const exec = vi.fn<PrivateDirectoryExecFile>().mockResolvedValue({ stdout: '', stderr: '' });
    await ensurePrivateScreenshotDirectory(dir, { platform: 'win32', execFile: exec });
    const args = exec.mock.calls[0]![1];
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
    expect(script).toContain(Buffer.from(dir, 'utf8').toString('base64'));
    expect(script).not.toContain(dir);
    expect(script).toContain('WindowsIdentity]::GetCurrent().User');
    expect(script).toContain('DirectorySecurity]::new()');
    expect(script).toContain('SetAccessRuleProtection($true, $false)');
    expect(script).toContain('SetOwner($sid)');
    expect(script).toContain('ContainerInherit, ObjectInherit');
    expect(script).toContain('Set-Acl -LiteralPath $dir -AclObject $acl');
    expect(script).toContain('$rules.Count -ne 1');
    expect(script).toContain('$r.IdentityReference.Value -ne $sid.Value');
    expect(script).toContain('$r.InheritanceFlags -ne $rule.InheritanceFlags');
    expect(script).not.toMatch(/env:|USERNAME|USERDOMAIN/);
  });

  it.each([
    Object.assign(new Error('exit 1'), { code: 1, stderr: 'Access denied' }),
    Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('timed out'), { killed: true }),
  ])('propagates Windows ACL failure: $message', async (error) => {
    const exec = vi.fn<PrivateDirectoryExecFile>().mockRejectedValue(error);
    await expect(ensurePrivateScreenshotDirectory('dir', { platform: 'win32', execFile: exec })).rejects.toBe(error);
    expect(chmod).not.toHaveBeenCalled();
  });

  it('propagates mkdir failure before invoking the ACL command', async () => {
    const error = new Error('mkdir denied');
    vi.mocked(mkdir).mockRejectedValue(error);
    const exec = vi.fn<PrivateDirectoryExecFile>();
    await expect(ensurePrivateScreenshotDirectory('dir', { platform: 'win32', execFile: exec })).rejects.toBe(error);
    expect(exec).not.toHaveBeenCalled();
  });

  it('propagates POSIX chmod failure rather than permitting capture', async () => {
    const error = new Error('chmod denied');
    vi.mocked(chmod).mockRejectedValue(error);
    await expect(ensurePrivateScreenshotDirectory('dir', { platform: 'linux' })).rejects.toBe(error);
  });

  it.each([true, false])('rejects links and non-directories (link=%s)', async (link) => {
    vi.mocked(lstat).mockResolvedValue({
      isDirectory: () => link,
      isSymbolicLink: () => link,
    } as Awaited<ReturnType<typeof lstat>>);
    const exec = vi.fn<PrivateDirectoryExecFile>();
    await expect(ensurePrivateScreenshotDirectory('dir', { platform: 'win32', execFile: exec })).rejects.toThrow('real directory');
    expect(exec).not.toHaveBeenCalled();
  });
});
