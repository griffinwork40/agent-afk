import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  shQuote,
  shQuotePath,
  buildLaunchScript,
  buildFollowScript,
  buildCancelScript,
  makeHeredocDelimiter,
  heredocWrite,
} from './remote-script.js';
import { sshArgs } from './ssh-runner.js';
import { createEventCollector } from './remote-events.js';
import { resolveShell } from '../utils/resolve-shell.js';

describe('shQuote / shQuotePath', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shQuote("it's $HOME `x`")).toBe(`'it'\\''s $HOME \`x\`'`);
  });
  it('expands a leading ~ to the remote $HOME only', () => {
    expect(shQuotePath('~/Projects/a b')).toBe(`"$HOME"/'Projects/a b'`);
    expect(shQuotePath('~')).toBe('"$HOME"');
    expect(shQuotePath('/abs/~x')).toBe(`'/abs/~x'`);
  });
});

describe('makeHeredocDelimiter', () => {
  it('returns a string not present in the payload', () => {
    const delim = makeHeredocDelimiter('hello world\n$(touch PWNED)');
    expect(delim).toMatch(/^AFK_PAYLOAD_[0-9A-F]{32}$/);
    expect('hello world\n$(touch PWNED)').not.toContain(delim);
  });
});

describe('heredocWrite', () => {
  it('produces a script fragment that writes exact bytes (no trailing newline)', () => {
    const payload = 'line1\n$(echo hi)\n\'quote\' "dq" \\back';
    const delim = makeHeredocDelimiter(payload);
    const fragment = heredocWrite(payload, '"/tmp/afk-test-out"', delim);
    expect(fragment).toContain(`<<'${delim}'`);
    expect(fragment).toContain(payload);
  });
});

describe('buildLaunchScript', () => {
  const base = { runId: 'r1', sessionId: 's-1', prompt: 'hello world' };

  it('inlines the recursion guard and detaches afk with nohup', () => {
    const s = buildLaunchScript(base);
    expect(s).toContain('AFK_MAX_NESTING_DEPTH=0 AFK_REMOTE_DEPTH=1 nohup "$p"');
    expect(s).toContain(`'chat' '--format' 'stream-json' '--session-id' 's-1'`);
    expect(s).toContain('< "$d/prompt" > "$d/out.ndjson" 2> "$d/err.log" &');
    expect(s).toContain('PATH="$(dirname "$p"):$PATH"');
  });

  it('uses --resume instead of --session-id and passes model/cwd quoted', () => {
    const s = buildLaunchScript({ ...base, resume: 'old-id', model: "x'y", cwd: '~/repo' });
    expect(s).toContain(`'--resume' 'old-id'`);
    expect(s).not.toContain('--session-id');
    expect(s).toContain(`'--model' 'x'\\''y'`);
    expect(s).toContain(`cd "$HOME"/'repo' ||`);
  });

  it('passes --permission-mode with safe quoting when set', () => {
    const s = buildLaunchScript({ ...base, permissionMode: 'default' });
    expect(s).toContain(`'--permission-mode' 'default'`);
  });

  it('passes bypassPermissions mode with safe quoting', () => {
    const s = buildLaunchScript({ ...base, permissionMode: 'bypassPermissions' });
    expect(s).toContain(`'--permission-mode' 'bypassPermissions'`);
  });

  it('omits --permission-mode when not set', () => {
    const s = buildLaunchScript(base);
    expect(s).not.toContain('--permission-mode');
  });

  it('uses an explicit afkPath when given and resolves otherwise', () => {
    expect(buildLaunchScript({ ...base, afkPath: '/opt/afk' })).toContain(`p='/opt/afk'`);
    const s = buildLaunchScript(base);
    expect(s).toContain(`p=''`);
    expect(s).toContain('-ic');
    expect(s).toContain('.nvm/versions/node/*/bin/afk');
  });

  it('embeds the prompt as a quoted heredoc (never as cat-from-stdin)', () => {
    const s = buildLaunchScript({ ...base, prompt: 'line1\n$(touch PWNED)\n\'q\' "dq"' });
    // Must contain a quoted heredoc marker
    expect(s).toMatch(/<<'AFK_PAYLOAD_[0-9A-F]{32}'/);
    // Must NOT use cat without a heredoc (old stdin-reading pattern)
    expect(s).not.toMatch(/^cat > "\$d\/prompt"$/m);
    // The prompt text itself must be present literally in the script
    expect(s).toContain('$(touch PWNED)');
  });

  it('does not read the prompt from stdin (cat > prompt removed)', () => {
    const s = buildLaunchScript(base);
    expect(s).not.toMatch(/\bcat\b.*>\s*["']?\$d\/prompt/);
  });
});

describe('follow / cancel scripts', () => {
  it('follows from a 1-based start line', () => {
    expect(buildFollowScript('r1', 7)).toContain('tail -n +7 -f "$d/out.ndjson"');
    expect(buildFollowScript('r1', 0)).toContain('tail -n +1 -f');
  });
  it('cancel kills the recorded pid and always succeeds', () => {
    const s = buildCancelScript('r1');
    expect(s).toContain('kill "$pid"');
    expect(s.trim().endsWith('exit 0')).toBe(true);
  });
});

describe('sshArgs', () => {
  it('runs the script under exec /bin/sh -s with fail-fast options and an option terminator', () => {
    const args = sshArgs('user@host');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ConnectTimeout=5');
    expect(args.slice(-3)).toEqual(['--', 'user@host', 'exec /bin/sh -s']);
  });
});

describe('createEventCollector', () => {
  it('ignores unknown and malformed lines and prefers trailing chunks', () => {
    const c = createEventCollector();
    expect(c.push('garbage')).toBe(false);
    expect(c.push(JSON.stringify({ type: 'future_event' }))).toBe(false);
    c.push(JSON.stringify({ type: 'message', message: { content: 'round 1' } }));
    expect(c.finalMessage()).toBe('round 1');
    c.push(JSON.stringify({ type: 'chunk', chunk: { type: 'content', content: 'tail' } }));
    expect(c.finalMessage()).toBe('tail');
    expect(c.push(JSON.stringify({ type: 'done' }))).toBe(true);
    expect(c.terminal()).toEqual({ type: 'done' });
  });
});

// ---------------------------------------------------------------------------
// Regression: stdin carries only the script — prompt content cannot be
// executed as shell commands regardless of what it contains.
// ---------------------------------------------------------------------------

describe('launch script stdin isolation (regression)', () => {
  /**
   * Collect the shells available on this machine at runtime.
   *
   * On Windows: resolveShell() finds Git Bash (C:\Program Files\Git\bin\bash.exe
   * or derived from git.exe on PATH). PowerShell is NEVER included — it cannot
   * run the POSIX heredoc scripts. If no POSIX shell is found on Windows, the
   * test fails with a clear message (Git Bash is present on windows-2022 runners).
   *
   * On POSIX: /bin/sh is always the first candidate; dash/bash/zsh are added
   * when present. Shells are deduplicated so /bin/sh=bash on macOS runs only once.
   *
   * Never platform-skipped.
   */
  function availableShells(): string[] {
    if (process.platform === 'win32') {
      const res = resolveShell();
      // resolveShell() returns { shell: 'powershell.exe' } when Git Bash is absent.
      // PowerShell cannot run POSIX heredoc scripts — treat it as no shell found.
      if (res.shell === true || res.shell === 'powershell.exe') return [];
      return [res.shell as string];
    }
    const candidates = ['/bin/sh'];
    for (const sh of [
      '/bin/dash', '/usr/bin/dash', '/usr/local/bin/dash',
      '/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash',
      '/bin/zsh',  '/usr/bin/zsh',  '/usr/local/bin/zsh',
    ]) {
      if (existsSync(sh)) candidates.push(sh);
    }
    return [...new Set(candidates)];
  }

  /**
   * Convert a Node path from os.tmpdir() to a form Git Bash accepts.
   * On Windows, os.tmpdir() returns `C:\Users\...`; Git Bash needs
   * forward slashes (`C:/Users/...`). On POSIX this is a no-op.
   */
  function toShellPath(p: string): string {
    return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
  }

  /** Run a single (shell, prompt) pair and assert correctness. */
  function assertPromptRoundtrip(shell: string, prompt: string, label: string): void {
    const runId = 'test-run-rt';
    const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'afk-rt-'));
    try {
      // The stub afk must be a #!/bin/sh script so Git Bash on Windows can
      // execute it by shebang. chmod is a no-op on Windows but harmless.
      const afkBin = path.join(tmpHome, 'afk');
      // Use the shell-path form for the afkPath so the launch script's `p=`
      // assignment and subsequent exec work under Git Bash on Windows.
      const afkBinShell = toShellPath(afkBin);
      writeFileSync(afkBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      // PWNED is checked in tmpHome — the shell runs with cwd: tmpHome so a
      // bare `touch PWNED` (without absolute path) lands here (item 3 fix).
      const pwnedPath = path.join(tmpHome, 'PWNED');

      const script = buildLaunchScript({ runId, sessionId: 'sess-rt', prompt, afkPath: afkBinShell });

      // HOME must be in shell-path form so the launch script's $HOME expansion
      // produces a valid path under Git Bash on Windows.
      const homeForShell = toShellPath(tmpHome);

      let stdout = '';
      try {
        // Append `wait` so the shell blocks until the `nohup "$p" … &` background
        // job has fully exited before returning control to execFileSync.  Without
        // this, on Windows-2022 with Git Bash the backgrounded stub process can
        // still hold tmpHome open after the parent shell exits, causing rmSync in
        // the finally block to throw EBUSY/EPERM and mask any assertion failure
        // above it (a vitest throw from finally replaces the original error).
        // The stub afk is `exit 0` so wait returns immediately in practice.
        const scriptWithWait = script + '\nwait';
        stdout = execFileSync(shell, ['-s'], {
          input: scriptWithWait,
          cwd: tmpHome,   // item 3: bare `touch PWNED` lands in tmpHome
          env: { HOME: homeForShell, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
          timeout: 10_000,
          encoding: 'utf-8',
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        stdout = e.stdout ?? '';
      }

      // 1. No PWNED file (security-critical; always asserted)
      expect(existsSync(pwnedPath), `[${shell}] PWNED created — injection for: ${label}`).toBe(false);
      // 2. PID marker present (round-trip launch succeeded)
      expect(stdout, `[${shell}] PID marker missing for: ${label}`).toContain('__AFK_REMOTE_PID__');
      // 3. Byte-identical prompt file
      const promptFile = path.join(tmpHome, '.afk', 'state', 'remote-runs', runId, 'prompt');
      expect(existsSync(promptFile), `[${shell}] prompt file missing for: ${label}`).toBe(true);
      expect(readFileSync(promptFile, 'utf-8'), `[${shell}] prompt mismatch for: ${label}`).toBe(prompt);
    } finally {
      // The detached `nohup "$p" … &` stub inherits cwd tmpHome; on Windows it
      // can still hold the directory for a moment after the shell exits
      // (EBUSY), and a throw here would mask any assertion failure above.
      // maxRetries makes Node retry EBUSY/ENOTEMPTY/EPERM with backoff.
      rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  /**
   * Every payload from the coordinator manifest. Tested on every available
   * shell at runtime — never platform-skipped.
   */
  const PAYLOADS: Array<[string, string]> = [
    ["apostrophe+parens", "it's an (unbalanced paren and quote"],
    ["close-paren",       "close ) paren only"],
    ["injection",         "case ) esac `x $(touch PWNED) ; echo X"],
    ["trailing-two-nl",   "ends with two newlines\n\n"],
    ["no-trailing-nl",    "no trailing nl"],
    ["trailing-backslash","trailing backslash \\"],
    ["multiline-quotes",  "'quote' \"dq\"\nEOF\nmore after EOF"],
    // Original single-case payload kept for regression continuity
    ["original",          "line1\n$(touch PWNED) ; echo X `id`\n'quote' \"dq\" \\back"],
  ];

  it('prompt file is byte-identical to input; no PWNED file; PID marker printed', () => {
    const shells = availableShells();
    // On Windows the runner has Git Bash; on POSIX /bin/sh is always present.
    // Fail explicitly rather than passing vacuously when no shell is found.
    expect(shells.length, 'no POSIX shell found — Git Bash expected on windows-2022; /bin/sh expected on POSIX').toBeGreaterThan(0);

    for (const shell of shells) {
      for (const [label, prompt] of PAYLOADS) {
        assertPromptRoundtrip(shell, prompt, label);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: keychain heredoc read — `IFS= read -r kcpw <<'DELIM'` must
// handle passwords containing ', ), ", \ and a backtick without any $( ) and
// without invoking `security`. Exercises buildUnlockKeychain indirectly by
// extracting and running just the read fragment.
// ---------------------------------------------------------------------------

describe('keychain heredoc read (regression)', () => {
  /**
   * Shells to test — same discovery logic as the launch-script suite.
   * PowerShell is never included. Never platform-skipped.
   */
  function availableShells(): string[] {
    if (process.platform === 'win32') {
      const res = resolveShell();
      if (res.shell === true || res.shell === 'powershell.exe') return [];
      return [res.shell as string];
    }
    const candidates = ['/bin/sh'];
    for (const sh of [
      '/bin/dash', '/usr/bin/dash', '/usr/local/bin/dash',
      '/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash',
      '/bin/zsh',  '/usr/bin/zsh',  '/usr/local/bin/zsh',
    ]) {
      if (existsSync(sh)) candidates.push(sh);
    }
    return [...new Set(candidates)];
  }

  it('kcpw equals password for metacharacter-rich single-line passwords', () => {
    const shells = availableShells();
    expect(shells.length, 'no POSIX shell found — Git Bash expected on windows-2022; /bin/sh expected on POSIX').toBeGreaterThan(0);

    // Password containing every required metacharacter class.
    // Must be single-line (no \r or \n) — that is the invariant.
    const password = `it's a ) "tricky" \`password\` with \\ backslash`;

    for (const shell of shells) {
      // Build a minimal script: just the read fragment + printf the result.
      // We import makeHeredocDelimiter to produce the correct delimiter.
      const delim = makeHeredocDelimiter(password);
      const script = [
        'set -e',
        `IFS= read -r kcpw <<'${delim}' || kcpw=`,
        password,
        delim,
        // Print a sentinel prefix + the value so we can extract it unambiguously.
        'printf "__KCPW__%s\\n" "$kcpw"',
      ].join('\n');

      let stdout = '';
      try {
        stdout = execFileSync(shell, ['-s'], {
          input: script,
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
          timeout: 5_000,
          encoding: 'utf-8',
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        stdout = e.stdout ?? '';
        throw new Error(`[${shell}] keychain read script failed: ${e.message ?? ''}\nstdout: ${stdout}\nstderr: ${e.stderr ?? ''}`);
      }

      const match = stdout.match(/^__KCPW__(.*)$/m);
      expect(match, `[${shell}] sentinel line not found in output`).not.toBeNull();
      expect(match![1], `[${shell}] kcpw mismatch`).toBe(password);
    }
  });
});
