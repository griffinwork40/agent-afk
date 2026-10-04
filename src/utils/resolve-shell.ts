/**
 * Cross-platform shell resolver for the bash tool.
 *
 * The bash tool is named "bash" and the system prompt instructs the model to
 * emit POSIX shell commands. On POSIX (Linux/macOS) `spawn(cmd, { shell: true })`
 * correctly routes through `/bin/sh`. On Windows, Node resolves `shell: true` to
 * `cmd.exe` via `%ComSpec%`, which cannot interpret POSIX commands.
 *
 * This module resolves the best available POSIX-compatible shell on Windows:
 *   1. Git Bash (preferred — full POSIX compatibility)
 *   2. PowerShell (fallback — better than cmd.exe, partial POSIX support)
 *
 * On POSIX platforms the resolver is a no-op: it returns `{ shell: true }` so
 * Node's own shell-resolution logic runs unchanged.
 *
 * @module utils/resolve-shell
 */

import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/** Return type for {@link resolveShell}. */
export interface ShellResolution {
  /** The shell executable, or `true` to let Node pick the platform default. */
  shell: string | true;
  /** Arguments to pass to the shell BEFORE the command string (e.g. `['-c']`). */
  args?: string[];
}

/** Well-known Git Bash installation paths on Windows. */
const GIT_BASH_PATHS: readonly string[] = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

/**
 * Path segment prefixes that identify WSL / Windows-App-Execution-Alias
 * bash.exe copies that are NOT Git Bash.  Comparisons are case-insensitive
 * because Windows paths are case-insensitive.
 *
 * - `%SystemRoot%\System32` holds the old WSL 1 bash.exe shim.
 * - `%LOCALAPPDATA%\Microsoft\WindowsApps` holds the WSL App Execution Alias
 *   (an exe placeholder that redirects into WSL).
 *
 * We derive these from env vars at call time rather than hard-coding
 * `C:\Windows` so they work on machines with non-default Windows roots and
 * so tests can inject arbitrary values.
 */
function wslPrefixes(): readonly string[] {
  const sysroot = (process.env['SystemRoot'] ?? 'C:\\Windows').toLowerCase();
  const localAppData = (process.env['LOCALAPPDATA'] ?? '').toLowerCase();
  const prefixes = [`${sysroot}\\system32`];
  if (localAppData) {
    prefixes.push(`${localAppData}\\microsoft\\windowsapps`);
  }
  return prefixes;
}

/**
 * Return true when `candidate` is a WSL-owned bash.exe that should be skipped.
 * Matching is prefix-based and case-insensitive.
 *
 * Invariant: each prefix is compared with a trailing backslash so that a
 * sibling directory sharing the same base (e.g. System32Git) is NOT
 * misclassified.  The trailing separator is appended inside this function so
 * callers never need to think about it.
 */
function isWslBash(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  return wslPrefixes().some((prefix) => lower.startsWith(prefix + '\\'));
}

/**
 * Try to locate bash.exe by finding `git.exe` on PATH and resolving the
 * sibling `bin\bash.exe`.  Git for Windows always ships bash.exe alongside
 * git.exe, so `<git-root>\cmd\git.exe` → `<git-root>\bin\bash.exe`.
 *
 * This catches non-standard Git installs (e.g. bundled under %LOCALAPPDATA%)
 * that are not covered by the hard-coded Program Files paths.
 *
 * @returns Absolute path to bash.exe derived from git.exe, or `undefined`.
 */
function findGitBashViaGitExe(): string | undefined {
  const pathDirs = (process.env['PATH'] ?? '').split(';');
  for (const dir of pathDirs) {
    const gitExe = win32.join(dir, 'git.exe');
    if (!existsSync(gitExe)) continue;
    // Git for Windows layout: <root>\cmd\git.exe  →  <root>\bin\bash.exe
    const gitRoot = win32.dirname(win32.dirname(gitExe));
    const candidate = win32.join(gitRoot, 'bin', 'bash.exe');
    if (!isWslBash(candidate) && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Locate `bash.exe` on Windows by checking `MSYSTEM`, known install paths,
 * a `git.exe`-derived path, and then every directory in `%PATH%` (excluding
 * WSL-owned bash.exe copies).
 *
 * Candidates under `%SystemRoot%\System32` and
 * `%LOCALAPPDATA%\Microsoft\WindowsApps` are always skipped because those
 * paths host the WSL bash shim / App Execution Alias, not Git Bash.
 *
 * @returns Absolute path to bash.exe, or `undefined` if not found.
 */
function findGitBashOnWindows(): string | undefined {
  // MSYSTEM is set by Git Bash environments — if it is present we are almost
  // certainly running inside Git Bash already, so `bash.exe` is on PATH.
  // Use win32.join so path construction is correct even when tests run on macOS.
  if (process.env['MSYSTEM'] !== undefined) {
    const pathDirs = (process.env['PATH'] ?? '').split(';');
    for (const dir of pathDirs) {
      const candidate = win32.join(dir, 'bash.exe');
      if (!isWslBash(candidate) && existsSync(candidate)) return candidate;
    }
  }

  // Check well-known Git for Windows install locations.
  for (const p of GIT_BASH_PATHS) {
    if (existsSync(p)) return p;
  }

  // Derive from git.exe on PATH — catches non-standard install locations
  // (e.g. %LOCALAPPDATA%\Programs\Git) before falling back to a raw PATH scan.
  const viaGit = findGitBashViaGitExe();
  if (viaGit !== undefined) return viaGit;

  // Last resort: scan PATH, skipping WSL-owned bash.exe copies.
  const pathDirs = (process.env['PATH'] ?? '').split(';');
  for (const dir of pathDirs) {
    const candidate = win32.join(dir, 'bash.exe');
    if (!isWslBash(candidate) && existsSync(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Resolve the best available shell for the current platform.
 *
 * - **POSIX** (Linux, macOS, etc.): returns `{ shell: true }` — Node picks
 *   `/bin/sh` as usual, behaviour is unchanged.
 * - **Windows with Git Bash**: returns `{ shell: '<path>', args: ['-c'] }`.
 * - **Windows without Git Bash**: returns `{ shell: 'powershell.exe', args: ['-Command'] }`
 *   as a fallback. `cmd.exe` is explicitly avoided: its 8 191-character command
 *   line limit and lack of POSIX compatibility make it unsuitable.
 */
export function resolveShell(): ShellResolution {
  if (process.platform !== 'win32') {
    return { shell: true };
  }

  const gitBash = findGitBashOnWindows();
  if (gitBash !== undefined) {
    return { shell: gitBash, args: ['-c'] };
  }

  return { shell: 'powershell.exe', args: ['-Command'] };
}

/**
 * Return a short human-readable description of the resolved shell.
 * Used by the bash tool description so the model knows which shell it is
 * targeting (important: POSIX instructions differ from PowerShell syntax).
 *
 * Examples: `"/bin/sh (POSIX)"`, `"Git Bash"`, `"PowerShell"`.
 */
export function shellDescription(): string {
  if (process.platform !== 'win32') {
    return '/bin/sh (POSIX)';
  }
  const gitBash = findGitBashOnWindows();
  return gitBash !== undefined ? 'Git Bash' : 'PowerShell';
}

/**
 * Return the shell-specific syntax guidance fragment embedded in the bash
 * tool description so the model generates commands compatible with the
 * active shell.
 *
 * - **POSIX** (`/bin/sh`): the existing POSIX/dash bashism guidance —
 *   byte-identical to the pre-Windows text so macOS/Linux behaviour is
 *   unchanged.
 * - **Git Bash** (win32, bash.exe found): bash syntax is available; POSIX
 *   coreutils supplied by Git for Windows.
 * - **PowerShell** (win32, no bash.exe): explicit PowerShell 5.1 syntax
 *   instructions — variable access, sequencing, cmdlets, quoting rules.
 */
export function bashToolShellGuidance(): string {
  if (process.platform !== 'win32') {
    // POSIX path — text is byte-identical to the original description fragment.
    return (
      `Commands run through /bin/sh (POSIX) (Node spawn with shell:true) — NOT bash and NOT your $SHELL; /bin/sh is bash-in-POSIX-mode on macOS but dash on Debian/Ubuntu. ` +
      'Only process substitution <(...) reliably fails closed (exit 2, nothing runs). Other bashisms are nonportable and are NOT dependable refusals: ' +
      '[[ ]] runs on macOS but is a not-found command on dash while the rest of the line still executes; {a,b} expands on macOS but passes through literally on dash (silently wrong argument); arrays run on macOS but are a syntax error on dash. ' +
      'So never assume a bashism-containing command was side-effect-free — prefer a temp file or a POSIX equivalent.'
    );
  }

  const gitBash = findGitBashOnWindows();

  if (gitBash !== undefined) {
    // Git Bash path — bash syntax, POSIX coreutils from Git for Windows.
    return (
      `Commands run through Git Bash (Node spawn with shell:true) — bash syntax is available and POSIX coreutils (ls, grep, sed, awk, find, …) are provided by Git for Windows. ` +
      'Write standard bash commands; POSIX process substitution <(...) works. ' +
      'Bashisms ([[ ]], arrays, {a,b} brace expansion) are supported. ' +
      'Use $VAR or ${VAR} for environment variables.'
    );
  }

  // PowerShell fallback — no Git Bash found; give accurate PowerShell 5.1 guidance.
  return (
    `Commands run through powershell.exe -Command (Node spawn with shell:true) — NOT a POSIX shell. Use PowerShell syntax and cmdlets: ` +
    'use $env:VAR (not $VAR) for environment variables; ' +
    'use ; to sequence commands (&& only works in PowerShell 7+, not 5.1); ' +
    'use Get-ChildItem (or dir) instead of ls, Select-String instead of grep, Get-Content instead of cat; ' +
    'no POSIX utilities (sed, awk, find, xargs) — use PowerShell equivalents or Where-Object/ForEach-Object pipelines; ' +
    'quoting: use single quotes for literal strings, double quotes for interpolation; ' +
    'subexpressions use $(...) syntax. Avoid POSIX-only constructs entirely.'
  );
}
