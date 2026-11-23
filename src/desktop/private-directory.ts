import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Async execFile seam: implementations must reject on nonzero exit or spawn failure. */
export type PrivateDirectoryExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export interface PrivateScreenshotDirectoryOptions {
  platform?: NodeJS.Platform;
  execFile?: PrivateDirectoryExecFile;
}

/**
 * Create/harden the sidecar directory BEFORE any screenshot is captured.
 * Existing explicit Windows ACEs must be replaced, not merely supplemented:
 * disabling inheritance plus granting the owner does not remove other users.
 */
export async function ensurePrivateScreenshotDirectory(
  dir: string,
  options: PrivateScreenshotDirectoryOptions = {},
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Screenshot directory must be a real directory, not a link');
  }
  if ((options.platform ?? process.platform) !== 'win32') {
    await chmod(dir, 0o700);
    return;
  }

  // Encode data separately from code: quotes, wildcard characters and Unicode in
  // a directory name cannot become PowerShell syntax or expand to other paths.
  const pathData = Buffer.from(dir, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$dir = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathData}'))
$item = Get-Item -LiteralPath $dir -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Screenshot directory is a reparse point' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $sid) { throw 'No current Windows user SID' }
# Start with an EMPTY DACL: no inherited OR pre-existing explicit grants survive.
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $sid, [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $dir -AclObject $acl
$actual = Get-Acl -LiteralPath $dir
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) {
  throw 'Screenshot directory ACL verification failed'
}
$r = $rules[0]
if ($r.IdentityReference.Value -ne $sid.Value -or $r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.FileSystemRights -ne $rule.FileSystemRights -or $r.InheritanceFlags -ne $rule.InheritanceFlags -or $r.PropagationFlags -ne 'None') {
  throw 'Screenshot directory is not owner-only and inheritable'
}
`.trim();
  await (options.execFile ?? execFileAsync)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 20_000, windowsHide: true },
  );
}
