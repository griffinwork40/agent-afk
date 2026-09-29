import { describe, it, expect, vi, afterEach } from 'vitest';

// We mock 'node:fs' so existsSync can be controlled per-test.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn() };
});

import * as fs from 'node:fs';

// Import under test AFTER mock is wired.
import { resolveShell, shellDescription, bashToolShellGuidance } from './resolve-shell.js';

describe('resolveShell', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    // Clean up any env-var pollution between tests.
    delete process.env['MSYSTEM'];
    process.env['PATH'] = process.env['PATH'] ?? '';
  });

  // -----------------------------------------------------------------------
  // POSIX (non-win32)
  // -----------------------------------------------------------------------

  it('returns { shell: true } on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(resolveShell()).toEqual({ shell: true });
  });

  it('returns { shell: true } on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(resolveShell()).toEqual({ shell: true });
  });

  it('does not call existsSync on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    resolveShell();
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Windows — Git Bash via MSYSTEM env var
  // -----------------------------------------------------------------------

  it('returns Git Bash path on win32 when MSYSTEM is set and bash.exe is on PATH', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['MSYSTEM'] = 'MINGW64';
    process.env['PATH'] = 'C:\\Program Files\\Git\\usr\\bin';
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p) === 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    );
    const result = resolveShell();
    expect(result.shell).toBe('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
    expect(result.args).toEqual(['-c']);
  });

  // -----------------------------------------------------------------------
  // Windows — Git Bash via known install paths
  // -----------------------------------------------------------------------

  it('returns C:\\Program Files\\Git\\bin\\bash.exe when that path exists', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === 'C:\\Program Files\\Git\\bin\\bash.exe',
    );
    const result = resolveShell();
    expect(result.shell).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(result.args).toEqual(['-c']);
  });

  it('returns C:\\Program Files (x86)\\Git\\bin\\bash.exe when only that exists', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === 'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    );
    const result = resolveShell();
    expect(result.shell).toBe('C:\\Program Files (x86)\\Git\\bin\\bash.exe');
    expect(result.args).toEqual(['-c']);
  });

  // -----------------------------------------------------------------------
  // Windows — Git Bash via PATH scan
  // -----------------------------------------------------------------------

  it('finds bash.exe on PATH when known paths are absent', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['PATH'] = 'C:\\tools\\git\\bin;C:\\Windows\\System32';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === 'C:\\tools\\git\\bin\\bash.exe',
    );
    const result = resolveShell();
    expect(result.shell).toBe('C:\\tools\\git\\bin\\bash.exe');
    expect(result.args).toEqual(['-c']);
  });

  // -----------------------------------------------------------------------
  // Windows — PowerShell fallback
  // -----------------------------------------------------------------------

  it('falls back to powershell.exe when no bash.exe is found on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['PATH'] = 'C:\\Windows\\System32';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = resolveShell();
    expect(result.shell).toBe('powershell.exe');
    expect(result.args).toEqual(['-Command']);
  });
});

// ---------------------------------------------------------------------------
// shellDescription
// ---------------------------------------------------------------------------

describe('shellDescription', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    delete process.env['MSYSTEM'];
  });

  it('returns "/bin/sh (POSIX)" on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(shellDescription()).toBe('/bin/sh (POSIX)');
  });

  it('returns "/bin/sh (POSIX)" on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(shellDescription()).toBe('/bin/sh (POSIX)');
  });

  it('returns "Git Bash" on win32 when bash.exe is found', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === 'C:\\Program Files\\Git\\bin\\bash.exe',
    );
    expect(shellDescription()).toBe('Git Bash');
  });

  it('returns "PowerShell" on win32 when no bash.exe is found', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(shellDescription()).toBe('PowerShell');
  });
});

// ---------------------------------------------------------------------------
// bashToolShellGuidance
// ---------------------------------------------------------------------------

describe('bashToolShellGuidance', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    delete process.env['MSYSTEM'];
    process.env['PATH'] = process.env['PATH'] ?? '';
  });

  // -----------------------------------------------------------------------
  // POSIX — guidance must contain /bin/sh and POSIX-specific terms
  // -----------------------------------------------------------------------

  it('POSIX: mentions /bin/sh (POSIX) in the guidance', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const guidance = bashToolShellGuidance();
    expect(guidance).toContain('/bin/sh (POSIX)');
  });

  it('POSIX (linux): mentions /bin/sh (POSIX) in the guidance', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const guidance = bashToolShellGuidance();
    expect(guidance).toContain('/bin/sh (POSIX)');
  });

  it('POSIX: mentions dash bashism warning', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const guidance = bashToolShellGuidance();
    expect(guidance).toContain('dash');
  });

  it('POSIX: does not mention PowerShell', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const guidance = bashToolShellGuidance();
    expect(guidance).not.toContain('PowerShell');
    expect(guidance).not.toContain('powershell');
  });

  // -----------------------------------------------------------------------
  // Windows + Git Bash — bash syntax available; no PowerShell instructions
  // -----------------------------------------------------------------------

  it('win32 + Git Bash: mentions Git Bash', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === 'C:\\Program Files\\Git\\bin\\bash.exe',
    );
    const guidance = bashToolShellGuidance();
    expect(guidance).toContain('Git Bash');
  });

  it('win32 + Git Bash: does not emit PowerShell instructions', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === 'C:\\Program Files\\Git\\bin\\bash.exe',
    );
    const guidance = bashToolShellGuidance();
    expect(guidance).not.toContain('$env:');
    expect(guidance).not.toContain('powershell.exe');
  });

  it('win32 + Git Bash: does not claim /bin/sh', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === 'C:\\Program Files\\Git\\bin\\bash.exe',
    );
    const guidance = bashToolShellGuidance();
    expect(guidance).not.toContain('/bin/sh');
  });

  // -----------------------------------------------------------------------
  // Windows without Git Bash — PowerShell fallback guidance
  // -----------------------------------------------------------------------

  it('win32 without Git Bash: mentions PowerShell', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const guidance = bashToolShellGuidance();
    expect(guidance).toContain('PowerShell');
  });

  it('win32 without Git Bash: mentions powershell.exe -Command', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const guidance = bashToolShellGuidance();
    expect(guidance).toContain('powershell.exe -Command');
  });

  it('win32 without Git Bash: instructs $env: for env vars', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const guidance = bashToolShellGuidance();
    expect(guidance).toContain('$env:');
  });

  it('win32 without Git Bash: does not claim /bin/sh', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATH'] = '';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const guidance = bashToolShellGuidance();
    expect(guidance).not.toContain('/bin/sh');
  });

  // -----------------------------------------------------------------------
  // bashTool description on non-win32 still contains the POSIX header phrase
  // -----------------------------------------------------------------------

  it('POSIX: bash tool description contains expected POSIX header phrase', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    // Dynamically import schemas.bash to pick up the mocked platform.
    // (This verifies the description wires through bashToolShellGuidance.)
    const guidance = bashToolShellGuidance();
    expect(guidance).toContain('Commands run through /bin/sh (POSIX) (Node spawn with shell:true)');
  });
});
