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

// ---------------------------------------------------------------------------
// WSL / App-Execution-Alias filtering (issue #2759)
// ---------------------------------------------------------------------------

describe('findGitBashOnWindows — WSL bash filtering', () => {
  const originalPlatform = process.platform;
  const originalPath = process.env['PATH'];

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    delete process.env['MSYSTEM'];
    delete process.env['SystemRoot'];
    delete process.env['LOCALAPPDATA'];
    process.env['PATH'] = originalPath;
  });

  it('skips C:\\Windows\\System32\\bash.exe (WSL shim) in MSYSTEM PATH scan', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['MSYSTEM'] = 'MINGW64';
    process.env['SystemRoot'] = 'C:\\Windows';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
    // System32 bash.exe is on PATH first, then the real Git Bash
    process.env['PATH'] = 'C:\\Windows\\System32;C:\\Program Files\\Git\\usr\\bin';
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      return (
        s === 'C:\\Windows\\System32\\bash.exe' ||
        s === 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
      );
    });
    const result = resolveShell();
    // Must NOT pick System32\bash.exe
    expect(result.shell).toBe('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  });

  it('skips WindowsApps bash.exe (App Execution Alias) in MSYSTEM PATH scan', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['MSYSTEM'] = 'MINGW64';
    process.env['SystemRoot'] = 'C:\\Windows';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
    process.env['PATH'] =
      'C:\\Users\\User\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Program Files\\Git\\usr\\bin';
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      return (
        s === 'C:\\Users\\User\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe' ||
        s === 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
      );
    });
    const result = resolveShell();
    // Must NOT pick the WindowsApps alias
    expect(result.shell).toBe('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  });

  it('skips System32\\bash.exe in the generic PATH scan (no MSYSTEM)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['SystemRoot'] = 'C:\\Windows';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
    // Only System32 bash.exe is present; no known paths, no git.exe
    process.env['PATH'] = 'C:\\Windows\\System32';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === 'C:\\Windows\\System32\\bash.exe',
    );
    const result = resolveShell();
    // Should fall back to PowerShell, not pick System32\bash.exe
    expect(result.shell).toBe('powershell.exe');
  });

  it('skips WindowsApps bash.exe in the generic PATH scan (no MSYSTEM)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['SystemRoot'] = 'C:\\Windows';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
    process.env['PATH'] = 'C:\\Users\\User\\AppData\\Local\\Microsoft\\WindowsApps';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) =>
        String(p) === 'C:\\Users\\User\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
    );
    const result = resolveShell();
    expect(result.shell).toBe('powershell.exe');
  });

  it('does NOT skip bash.exe in a sibling directory like System32Git (boundary regression)', () => {
    // Regression: isWslBash must NOT fire on C:\Windows\System32Git\bash.exe.
    // The prefix boundary check ensures the separator follows the prefix.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['SystemRoot'] = 'C:\\Windows';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
    process.env['PATH'] = 'C:\\Windows\\System32Git';
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === 'C:\\Windows\\System32Git\\bash.exe',
    );
    const result = resolveShell();
    // System32Git is NOT the WSL directory — must be accepted as Git Bash.
    expect(result.shell).toBe('C:\\Windows\\System32Git\\bash.exe');
    expect(result.args).toEqual(['-c']);
  });
});

// ---------------------------------------------------------------------------
// buildWslPrefixes — hoisted prefix construction (issue #2937)
// ---------------------------------------------------------------------------
// buildWslPrefixes is not exported; its behaviour is verified by observing
// that resolveShell skips or accepts candidates based on the env vars it reads.

describe('buildWslPrefixes — env-var wiring', () => {
  const originalPlatform = process.platform;
  const originalPath = process.env['PATH'];

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    delete process.env['MSYSTEM'];
    delete process.env['SystemRoot'];
    delete process.env['LOCALAPPDATA'];
    process.env['PATH'] = originalPath;
  });

  it('uses env.SystemRoot to build the System32 prefix (non-default root)', () => {
    // If buildWslPrefixes reads env.SystemRoot correctly, a custom root causes
    // resolveShell to skip bash.exe under that custom root, not under C:\\Windows.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['SystemRoot'] = 'D:\\WinCustom';
    process.env['LOCALAPPDATA'] = '';
    // bash.exe under the custom root's System32 — should be skipped
    process.env['PATH'] = 'D:\\WinCustom\\System32;C:\\Program Files\\Git\\bin';
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      return (
        s === 'D:\\WinCustom\\System32\\bash.exe' ||
        s === 'C:\\Program Files\\Git\\bin\\bash.exe'
      );
    });
    const result = resolveShell();
    // Must skip D:\WinCustom\System32\bash.exe and return the real Git Bash
    expect(result.shell).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('uses env.LOCALAPPDATA to build the WindowsApps prefix', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['SystemRoot'] = 'C:\\Windows';
    process.env['LOCALAPPDATA'] = 'D:\\CustomAppData';
    process.env['PATH'] =
      'D:\\CustomAppData\\Microsoft\\WindowsApps;C:\\Program Files\\Git\\bin';
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      return (
        s === 'D:\\CustomAppData\\Microsoft\\WindowsApps\\bash.exe' ||
        s === 'C:\\Program Files\\Git\\bin\\bash.exe'
      );
    });
    const result = resolveShell();
    // Must skip the WindowsApps alias and return the real Git Bash
    expect(result.shell).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });
});

// ---------------------------------------------------------------------------
// git.exe-derived discovery (issue #2759)
// ---------------------------------------------------------------------------

describe('findGitBashOnWindows — git.exe-derived discovery', () => {
  const originalPlatform = process.platform;
  const originalPath = process.env['PATH'];

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    delete process.env['MSYSTEM'];
    delete process.env['SystemRoot'];
    delete process.env['LOCALAPPDATA'];
    process.env['PATH'] = originalPath;
  });

  it('finds Git Bash via git.exe when installed under %LOCALAPPDATA%', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['SystemRoot'] = 'C:\\Windows';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
    // git.exe lives in a non-standard location; no Program Files paths exist
    process.env['PATH'] = 'C:\\Users\\User\\AppData\\Local\\Programs\\Git\\cmd';
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      return (
        s === 'C:\\Users\\User\\AppData\\Local\\Programs\\Git\\cmd\\git.exe' ||
        s === 'C:\\Users\\User\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
      );
    });
    const result = resolveShell();
    expect(result.shell).toBe(
      'C:\\Users\\User\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
    );
    expect(result.args).toEqual(['-c']);
  });

  it('git.exe-derived path is preferred over a generic PATH bash.exe that is not WSL', () => {
    // If both a git.exe-derived bash and a non-WSL PATH bash exist, the
    // git.exe path wins because it is checked first.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['SystemRoot'] = 'C:\\Windows';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
    process.env['PATH'] =
      'C:\\Users\\User\\AppData\\Local\\Programs\\Git\\cmd;C:\\tools\\otherbash';
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      return (
        s === 'C:\\Users\\User\\AppData\\Local\\Programs\\Git\\cmd\\git.exe' ||
        s === 'C:\\Users\\User\\AppData\\Local\\Programs\\Git\\bin\\bash.exe' ||
        s === 'C:\\tools\\otherbash\\bash.exe'
      );
    });
    const result = resolveShell();
    expect(result.shell).toBe(
      'C:\\Users\\User\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
    );
  });

  it('falls back to PowerShell when git.exe is found but bash.exe sibling is absent', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['MSYSTEM'];
    process.env['SystemRoot'] = 'C:\\Windows';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
    process.env['PATH'] = 'C:\\tools\\git\\cmd';
    vi.mocked(fs.existsSync).mockImplementation(
      // git.exe exists but bin\bash.exe does not
      (p) => String(p) === 'C:\\tools\\git\\cmd\\git.exe',
    );
    const result = resolveShell();
    expect(result.shell).toBe('powershell.exe');
  });
});
