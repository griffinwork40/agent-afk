/**
 * Real Windows ACL integration, no capture or desktop access. Like
 * backend.windows.integration.test.ts this is Windows-only; the R4 exception
 * is recorded by audit:posix:update. Unit tests exercise every OS everywhere.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ensurePrivateScreenshotDirectory } from './private-directory.js';

const execFileAsync = promisify(execFile);
let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

async function powershell(script: string): Promise<string> {
  const result = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64'),
  ], { timeout: 20_000, windowsHide: true });
  return result.stdout.trim();
}

function pathLiteral(dir: string): string {
  return `'${dir.replace(/'/g, "''")}'`;
}

interface AclSummary {
  protected: boolean;
  owner: string;
  sid: string;
  rules: { sid: string; type: string; inherited: boolean; rights: string }[];
}

async function inspectAcl(dir: string): Promise<AclSummary> {
  return JSON.parse(await powershell(`
$acl = Get-Acl -LiteralPath ${pathLiteral(dir)}
@{
  protected = $acl.AreAccessRulesProtected
  owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString() }
  })
} | ConvertTo-Json -Depth 4 -Compress
`)) as AclSummary;
}

function expectOwnerOnly(acl: AclSummary): void {
  expect(acl.owner).toBe(acl.sid);
  expect(acl.rules).toHaveLength(1);
  expect(acl.rules[0]).toMatchObject({ sid: acl.sid, type: 'Allow', rights: 'FullControl' });
}

describe('private screenshot directory, real Windows ACLs', () => {
  it.runIf(process.platform === 'win32')('replaces explicit broad grants, protects inheritance, and secures new files', { timeout: 120_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'afk-private-directory-'));
    // Quotes, spaces and wildcard syntax must be treated as literal path data.
    const dir = join(root, "screens 'quoted' [literal] 日本語");
    await mkdir(dir);
    await powershell(`
$dir = ${pathLiteral(dir)}
$acl = Get-Acl -LiteralPath $dir
foreach ($sidValue in @('S-1-1-0', 'S-1-5-32-545')) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new($sidValue),
    [Security.AccessControl.FileSystemRights]::ReadAndExecute,
    [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $dir -AclObject $acl
`);
    const before = await inspectAcl(dir);
    expect(before.rules.some((rule) => rule.sid === 'S-1-1-0' && !rule.inherited)).toBe(true);
    expect(before.rules.some((rule) => rule.sid === 'S-1-5-32-545' && !rule.inherited)).toBe(true);

    await ensurePrivateScreenshotDirectory(dir);
    const hardened = await inspectAcl(dir);
    expect(hardened.protected).toBe(true);
    expectOwnerOnly(hardened);
    expect(hardened.rules[0]?.inherited).toBe(false);
    // Idempotent even when all inherited and explicit other-user entries are gone.
    await ensurePrivateScreenshotDirectory(dir);

    const child = join(dir, 'not-a-screenshot.txt');
    await writeFile(child, 'privacy integration fixture');
    const childAcl = await inspectAcl(child);
    expectOwnerOnly(childAcl);
    expect(childAcl.rules[0]?.inherited).toBe(true);

    const fresh = join(root, 'new-directory');
    await ensurePrivateScreenshotDirectory(fresh);
    expectOwnerOnly(await inspectAcl(fresh));
  });
});
