import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashHandler, createBashHandler } from './bash.js';

describe('bashHandler', () => {
  /**
   * Helper to create an AbortSignal that won't be aborted.
   */
  function createSignal(): AbortSignal {
    const controller = new AbortController();
    return controller.signal;
  }

  /**
   * Helper to create an AbortSignal that will be aborted after a delay.
   */
  function createAbortableSignal(delayMs: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), delayMs);
    return controller.signal;
  }

  it('is a valid ToolHandler', () => {
    expect(typeof bashHandler).toBe('function');
  });

  describe('successful commands', () => {
    it('executes a simple echo command', async () => {
      const result = await bashHandler(
        { command: 'echo hello' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('hello');
    });

    it('returns combined stdout and stderr', async () => {
      const result = await bashHandler(
        { command: 'echo "out"; echo "err" >&2' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('out');
      expect(result.content).toContain('err');
    });

    it('preserves multiline output', async () => {
      const result = await bashHandler(
        { command: 'printf "line1\\nline2\\nline3"' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('line1');
      expect(result.content).toContain('line2');
      expect(result.content).toContain('line3');
    });

    it('trims trailing whitespace', async () => {
      const result = await bashHandler(
        { command: 'echo "test"   ' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).not.toMatch(/\s+$/);
    });
  });

  describe('stderr handling', () => {
    it('includes stderr in output (without isError flag)', async () => {
      const result = await bashHandler(
        { command: 'echo "error message" >&2' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('error message');
    });

    it('combines stdout and stderr', async () => {
      const result = await bashHandler(
        { command: 'echo "stdout"; echo "stderr" >&2' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toMatch(/stdout|stderr/);
    });
  });

  describe('exit codes', () => {
    it('returns isError and names exit code on non-zero exit', async () => {
      const result = await bashHandler(
        { command: 'exit 42' },
        createSignal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/exited with code/);
      expect(result.content).toContain('42');
    });

    it('includes stderr in failure message on non-zero exit', async () => {
      const result = await bashHandler(
        { command: 'echo "something went wrong" >&2; exit 1' },
        createSignal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/exited with code/);
      expect(result.content).toContain('something went wrong');
    });

    it('handles command not found with isError', async () => {
      const result = await bashHandler(
        { command: 'nonexistent_command_xyz' },
        createSignal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/exited with code/);
    });

    it('abort returns "Command aborted", not "exited with code"', async () => {
      const signal = createAbortableSignal(50);
      const result = await bashHandler(
        { command: 'sleep 60' },
        signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toBe('Command aborted');
      expect(result.content).not.toMatch(/exited with code/);
    });
  });

  describe('input validation', () => {
    it('throws on missing command', async () => {
      await expect(
        bashHandler({}, createSignal()),
      ).rejects.toThrow(/command.*string/i);
    });

    it('throws on non-string command', async () => {
      await expect(
        bashHandler({ command: 123 }, createSignal()),
      ).rejects.toThrow(/command.*string/i);
    });

    it('throws on non-object input', async () => {
      await expect(
        bashHandler('not an object', createSignal()),
      ).rejects.toThrow(/must be an object/i);
    });

    it('throws on invalid timeout_ms type', async () => {
      await expect(
        bashHandler({ command: 'echo test', timeout_ms: 'not a number' }, createSignal()),
      ).rejects.toThrow(/timeout_ms.*number/i);
    });

    it('throws on timeout_ms > 600000', async () => {
      await expect(
        bashHandler({ command: 'echo test', timeout_ms: 700000 }, createSignal()),
      ).rejects.toThrow(/timeout_ms.*600000/i);
    });

    it('throws on negative timeout_ms', async () => {
      await expect(
        bashHandler({ command: 'echo test', timeout_ms: -1 }, createSignal()),
      ).rejects.toThrow(/timeout_ms.*0.*600000/i);
    });

    it('accepts valid timeout_ms', async () => {
      const result = await bashHandler(
        { command: 'echo test', timeout_ms: 5000 },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('test');
    });

    it('uses default timeout when not provided', async () => {
      const result = await bashHandler(
        { command: 'echo test' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
    });
  });

  describe('timeout handling', () => {
    it('kills process on timeout and returns isError', async () => {
      const result = await bashHandler(
        { command: 'sleep 10', timeout_ms: 100 },
        createSignal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('timed out');
      expect(result.content).toContain('100');
    });

    it('respects short timeout', async () => {
      const start = Date.now();
      const result = await bashHandler(
        { command: 'sleep 60', timeout_ms: 50 },
        createSignal(),
      );

      const elapsed = Date.now() - start;

      expect(result.isError).toBe(true);
      expect(elapsed).toBeLessThan(1000); // Should timeout quickly, not sleep 60s
    });
  });

  describe('signal/abort handling', () => {
    it('aborts command when signal is aborted', async () => {
      const signal = createAbortableSignal(50);
      const result = await bashHandler(
        { command: 'sleep 60' },
        signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('aborted');
    });

    it('completes normally when signal is not aborted', async () => {
      const controller = new AbortController();
      const result = await bashHandler(
        { command: 'echo success' },
        controller.signal,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('success');
    });

    it('[TOCTOU] kills the child promptly when abort lands after the pre-flight check but before listener registration', async () => {
      // Regression: an abort firing in the window between the top-of-handler
      // `signal.aborted` pre-flight check (passes → the child IS spawned) and the
      // `addEventListener('abort', ...)` registration is never delivered to the
      // late-added listener (a real AbortSignal does not replay an
      // already-dispatched 'abort'). Without the post-registration re-check the
      // child runs to completion and leaks a late result. This fake signal
      // reproduces that exact race: `aborted` is false at the pre-flight read,
      // then flips true when the handler registers its listener.
      let aborted = false;
      const raceSignal = {
        get aborted() { return aborted; },
        addEventListener: (_type: string, _cb: () => void) => { aborted = true; },
        removeEventListener: () => {},
      } as unknown as AbortSignal;

      const start = Date.now();
      const result = await bashHandler({ command: 'sleep 5' }, raceSignal);
      const elapsed = Date.now() - start;

      expect(result.isError).toBe(true);
      expect(result.content).toBe('Command aborted');
      // The fix kills the child immediately; without it, the result would only
      // arrive after `sleep 5` exits on its own (~5s) via the close handler.
      expect(elapsed).toBeLessThan(3000);
    }, 15_000);
  });

  describe('ANSI stripping', () => {
    it('strips ANSI color codes', async () => {
      // \x1b[31m = red, \x1b[0m = reset
      const result = await bashHandler(
        { command: 'printf "\\x1b[31mred text\\x1b[0m"' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).not.toContain('\x1b');
      expect(result.content).toContain('red text');
    });

    it('strips complex ANSI sequences', async () => {
      // Various ANSI sequences: bold, colors, etc.
      const result = await bashHandler(
        { command: 'printf "\\x1b[1;32;40mBold Green\\x1b[0m"' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).not.toContain('\x1b[');
      expect(result.content).toContain('Bold Green');
    });
  });

  describe('output truncation', () => {
    it('truncates output at 100KB', async () => {
      // Generate ~110KB of output
      const largeLine = 'x'.repeat(110_000);
      const result = await bashHandler(
        { command: `printf "${largeLine}"` },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content.length).toBeLessThanOrEqual(100_000 + 50); // 100KB + truncation notice
      expect(result.content).toContain('truncated');
    });

    it('includes a head+tail truncation notice when output exceeds the model cap', async () => {
      const largeLine = 'x'.repeat(105_000);
      const result = await bashHandler(
        { command: `printf "${largeLine}"` },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      // The command completed well under the 8MB hard cap, so the close path
      // reduced its output to a head+tail view with a middle elision marker.
      expect(result.content).toContain('bytes truncated');
    });

    // Regression: subagents (and any caller) must be able to detect
    // truncation without substring-scanning content. Matching a sentinel
    // string is fragile — the wording varies by path (head+tail elision
    // marker vs hard-cap kill note), and handlers may emit the literal
    // string "truncated" in legitimate output (e.g. a log line about
    // database truncation). The structured flag is unambiguous.
    it('sets ToolResult.truncated=true when output exceeds 100KB', async () => {
      const largeLine = 'x'.repeat(105_000);
      const result = await bashHandler(
        { command: `printf "${largeLine}"` },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.truncated).toBe(true);
    });

    it('does not truncate output under 100KB', async () => {
      const mediumLine = 'x'.repeat(50_000);
      const result = await bashHandler(
        { command: `printf "${mediumLine}"` },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).not.toContain('truncated');
      expect(result.truncated).toBeUndefined();
    });

    // Regression: V8 max-string-length crash (RangeError: Invalid string
    // length). The accumulator is bounded at HARD_CAP_BYTES (8MB) and the
    // child is SIGKILL'd the instant combined output crosses it — a
    // genuine-runaway circuit-breaker (a `cat` of a huge binary, a runaway
    // `yes`). This proves the mid-stream kill fires BEFORE the process
    // finishes: we emit >8MB of 'q', then sleep 3s, then emit 'z'. If the
    // kill works, the child is terminated during the 'q' flood (before the
    // sleep), so we never see 'z', the call returns fast, and the hard-cap
    // kill sentinel ("… was terminated") is present. If the guard regressed
    // to letting the command complete, the close path would run instead —
    // emitting the ordinary head+tail marker (no "terminated" sentinel)
    // only after waiting out the 3s sleep. NB: 'q'/'z' are the phase markers
    // because neither letter appears in the truncation marker text — 'b',
    // for one, collides with the word "bytes".
    it('mid-stream hard cap: SIGKILLs a runaway before it completes (V8 overflow guard)', async () => {
      const start = Date.now();
      const result = await bashHandler(
        {
          // 9MB of 'q' crosses the 8MB hard cap; the kill fires mid-flood,
          // before the sleep and the 'z' emission are ever reached. Portable
          // on macOS + Linux without bash brace-expansion or sidecars.
          command:
            "head -c 9000000 /dev/zero | tr '\\0' 'q'; sleep 3; head -c 9000000 /dev/zero | tr '\\0' 'z'",
          timeout_ms: 20_000,
        },
        createSignal(),
      );
      const elapsedMs = Date.now() - start;

      expect(result.isError).toBeFalsy();
      // Hard-cap kill sentinel — ONLY the overflow-kill path emits this, so
      // it discriminates "killed mid-flood" from "ran to completion".
      expect(result.content).toContain('was terminated');
      // Structured truncation flag is the load-bearing signal for callers
      // (subagent traces, hooks).
      expect(result.truncated).toBe(true);
      // Got some 'q' before the kill; never reached the post-sleep 'z'.
      expect(result.content).toContain('q');
      expect(result.content).not.toContain('z');
      // Kill fired during the 'q' flood, before the 3s sleep elapsed.
      // Reading 8MB off a pipe is sub-second; 3000ms cleanly separates the
      // kill path from a "waited for the sleep" regression.
      expect(elapsedMs).toBeLessThan(3_000);
    }, 25_000);

    // Companion test: the same hard cap protects stderr accumulation. Many
    // long-running commands write progress to stderr (e.g. `find /` with
    // permission errors), so a stderr-only flood must also trigger the
    // mid-stream kill.
    it('mid-stream hard cap: protects stderr from unbounded accumulation', async () => {
      const start = Date.now();
      const result = await bashHandler(
        {
          command:
            "head -c 9000000 /dev/zero | tr '\\0' 'q' >&2; sleep 3; head -c 9000000 /dev/zero | tr '\\0' 'z' >&2",
          timeout_ms: 20_000,
        },
        createSignal(),
      );
      const elapsedMs = Date.now() - start;

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('was terminated');
      expect(result.truncated).toBe(true);
      expect(result.content).toContain('q');
      expect(result.content).not.toContain('z');
      expect(elapsedMs).toBeLessThan(3_000);
    }, 25_000);
  });

  describe('edge cases', () => {
    it('handles empty output', async () => {
      const result = await bashHandler(
        { command: 'true' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toBe('');
    });

    it('handles command with special characters', async () => {
      const result = await bashHandler(
        { command: 'echo "test\\"special\\"chars"' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
    });

    it('executes commands with pipes', async () => {
      const result = await bashHandler(
        { command: 'echo "hello world" | wc -w' },
        createSignal(),
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('2');
    });

    it('handles edge case commands gracefully', async () => {
      // Verify the handler returns valid ToolResult for any command
      const result = await bashHandler(
        { command: 'exit 127' },
        createSignal(),
      );

      expect(result).toHaveProperty('content');
      expect(typeof result.content).toBe('string');
      // Non-zero exit sets isError and names the exit code
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/exited with code/);
    });
  });

  describe('cwd scoping', () => {
    // These tests guard the worktree-isolation invariant: a session
    // configured with `cwd` must spawn its shell commands in that
    // directory, not in the Node host's `process.cwd()`. Without this,
    // two concurrent `afk interactive -w` terminals would both `git
    // stash` against the same shared working tree — the bug this
    // factory + parameter was introduced to fix.

    it('runs commands in the configured cwd, not process.cwd()', async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-cwd-'));
      try {
        const handler = createBashHandler('default', tmpRoot);
        const result = await handler({ command: 'pwd' }, createSignal());
        // realpath both sides — /tmp resolves to /private/tmp on macOS,
        // and shell `pwd` may report either form.
        const reportedCwd = await fs.realpath(result.content.trim());
        const expectedCwd = await fs.realpath(tmpRoot);
        expect(reportedCwd).toBe(expectedCwd);
        expect(reportedCwd).not.toBe(await fs.realpath(process.cwd()));
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    it('does NOT mutate process.cwd() of the host', async () => {
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-cwd-'));
      const hostCwdBefore = process.cwd();
      try {
        const handler = createBashHandler('default', tmpRoot);
        await handler({ command: 'pwd' }, createSignal());
        expect(process.cwd()).toBe(hostCwdBefore);
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    it('falls back to process.cwd() when no cwd is configured', async () => {
      const handler = createBashHandler('default');
      const result = await handler({ command: 'pwd' }, createSignal());
      const reportedCwd = await fs.realpath(result.content.trim());
      expect(reportedCwd).toBe(await fs.realpath(process.cwd()));
    });

    it('isolates two concurrent handlers with distinct cwds', async () => {
      // The actual concurrency bug: two sessions in different worktrees
      // must see distinct working directories at spawn time.
      const tmpA = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-cwd-a-'));
      const tmpB = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-cwd-b-'));
      try {
        const handlerA = createBashHandler('default', tmpA);
        const handlerB = createBashHandler('default', tmpB);
        const [resA, resB] = await Promise.all([
          handlerA({ command: 'pwd' }, createSignal()),
          handlerB({ command: 'pwd' }, createSignal()),
        ]);
        const reportedA = await fs.realpath(resA.content.trim());
        const reportedB = await fs.realpath(resB.content.trim());
        expect(reportedA).toBe(await fs.realpath(tmpA));
        expect(reportedB).toBe(await fs.realpath(tmpB));
        expect(reportedA).not.toBe(reportedB);
      } finally {
        await fs.rm(tmpA, { recursive: true, force: true });
        await fs.rm(tmpB, { recursive: true, force: true });
      }
    });

    it('names the dead working directory when cwd was deleted (ENOENT masquerade)', async () => {
      // Spawn with a deleted cwd rejects as `spawn /bin/sh ENOENT` — naming
      // the shell, not the missing directory. The handler must translate
      // this into an actionable error so agents stop retrying blindly
      // (production incident: 4 consecutive identical retries after a
      // worktree was reaped mid-session).
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-cwd-dead-'));
      await fs.rm(tmpRoot, { recursive: true, force: true });
      const handler = createBashHandler('default', tmpRoot);
      const result = await handler({ command: 'echo alive' }, createSignal());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('working directory does not exist');
      expect(result.content).toContain(tmpRoot);
      expect(result.content).toContain('deleted worktree?');
    });
  });

  describe('concurrent execution', () => {
    it('handles multiple concurrent commands', async () => {
      const results = await Promise.all([
        bashHandler({ command: 'echo "cmd1"' }, createSignal()),
        bashHandler({ command: 'echo "cmd2"' }, createSignal()),
        bashHandler({ command: 'echo "cmd3"' }, createSignal()),
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].content).toContain('cmd1');
      expect(results[1].content).toContain('cmd2');
      expect(results[2].content).toContain('cmd3');
    });
  });

  describe('context.cwd enforcement', () => {
    it('runs command in context.cwd when set', async () => {
      const handler = createBashHandler('default');
      const dir = mkdtempSync(path.join(os.tmpdir(), 'afk-bash-cwd-'));
      // On macOS /var is a symlink to /private/var — resolve to the real path
      // so we can compare against what pwd actually prints.
      const realDir = realpathSync(dir);

      const result = await handler(
        { command: 'pwd' },
        new AbortController().signal,
        { cwd: dir },
      );

      expect(result.isError).toBeFalsy();
      expect(result.content.trim()).toBe(realDir);
    });

    it('falls back to process.cwd() when context is undefined', async () => {
      const handler = createBashHandler('default');
      const result = await handler(
        { command: 'pwd' },
        new AbortController().signal,
        undefined,
      );
      expect(result.isError).toBeFalsy();
      expect(typeof result.content).toBe('string');
    });

    it('falls back to process.cwd() when context has no cwd', async () => {
      const handler = createBashHandler('default');
      const result = await handler(
        { command: 'pwd' },
        new AbortController().signal,
        {},
      );
      expect(result.isError).toBeFalsy();
    });
  });

  describe('env injection', () => {
    it('makes context.env vars visible to the spawned shell', async () => {
      const handler = createBashHandler('default');
      const result = await handler(
        { command: 'echo "PLUGIN_ROOT=$PLUGIN_ROOT"' },
        new AbortController().signal,
        { env: { PLUGIN_ROOT: '/fake/plugin/root' } },
      );
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('PLUGIN_ROOT=/fake/plugin/root');
    });

    it('context.env overrides process.env on collision', async () => {
      const originalValue = process.env['SCOPE_FREEZE_TEST_VAR'];
      process.env['SCOPE_FREEZE_TEST_VAR'] = 'process-env-value';
      try {
        const handler = createBashHandler('default');
        const result = await handler(
          { command: 'echo "VAR=$SCOPE_FREEZE_TEST_VAR"' },
          new AbortController().signal,
          { env: { SCOPE_FREEZE_TEST_VAR: 'context-env-wins' } },
        );
        expect(result.isError).toBeFalsy();
        expect(result.content).toContain('VAR=context-env-wins');
      } finally {
        if (originalValue === undefined) {
          delete process.env['SCOPE_FREEZE_TEST_VAR'];
        } else {
          process.env['SCOPE_FREEZE_TEST_VAR'] = originalValue;
        }
      }
    });

    it('process.env still passes through when context.env is unset', async () => {
      // When context.env is undefined, spawn inherits process.env by default.
      // Confirm we don't accidentally clobber it with a partial env object.
      const originalValue = process.env['SCOPE_FREEZE_INHERIT_TEST'];
      process.env['SCOPE_FREEZE_INHERIT_TEST'] = 'inherited';
      try {
        const handler = createBashHandler('default');
        const result = await handler(
          { command: 'echo "VAR=$SCOPE_FREEZE_INHERIT_TEST"' },
          new AbortController().signal,
          {},
        );
        expect(result.isError).toBeFalsy();
        expect(result.content).toContain('VAR=inherited');
      } finally {
        if (originalValue === undefined) {
          delete process.env['SCOPE_FREEZE_INHERIT_TEST'];
        } else {
          process.env['SCOPE_FREEZE_INHERIT_TEST'] = originalValue;
        }
      }
    });

    it('process.env still passes through when context.env IS set', async () => {
      // The merge `{ ...process.env, ...context.env }` must preserve
      // unrelated process.env vars, not just the overridden ones.
      const originalValue = process.env['SCOPE_FREEZE_COEXIST_TEST'];
      process.env['SCOPE_FREEZE_COEXIST_TEST'] = 'coexists';
      try {
        const handler = createBashHandler('default');
        const result = await handler(
          { command: 'echo "PLUGIN=$PLUGIN_ROOT,COEXIST=$SCOPE_FREEZE_COEXIST_TEST"' },
          new AbortController().signal,
          { env: { PLUGIN_ROOT: '/x' } },
        );
        expect(result.isError).toBeFalsy();
        expect(result.content).toContain('PLUGIN=/x');
        expect(result.content).toContain('COEXIST=coexists');
      } finally {
        if (originalValue === undefined) {
          delete process.env['SCOPE_FREEZE_COEXIST_TEST'];
        } else {
          process.env['SCOPE_FREEZE_COEXIST_TEST'] = originalValue;
        }
      }
    });
  });
});

describe('createBashHandler — cwd parameter', () => {
  function createSignal(): AbortSignal {
    return new AbortController().signal;
  }

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'bash-cwd-test-')));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('without cwd: spawns in process.cwd() (legacy behavior)', async () => {
    const handler = createBashHandler('default');
    const result = await handler({ command: 'pwd' }, createSignal());
    // No cwd opt → bash runs in process.cwd(), which is the test runner cwd.
    // Normalize both sides to resolve macOS /tmp → /private/tmp symlink.
    expect(realpathSync(result.content.trim())).toBe(realpathSync(process.cwd()));
  });

  it('with cwd: spawns in the configured directory', async () => {
    // Drop a sentinel file inside tmpDir so we can distinguish from process.cwd()
    await fs.writeFile(join(tmpDir, 'sentinel.txt'), 'hello', 'utf8');
    const handler = createBashHandler('default', tmpDir);

    const pwdResult = await handler({ command: 'pwd' }, createSignal());
    expect(pwdResult.content.trim()).toBe(tmpDir);

    // Verify relative file ops resolve against the configured cwd
    const catResult = await handler({ command: 'cat sentinel.txt' }, createSignal());
    expect(catResult.content.trim()).toBe('hello');
    expect(catResult.isError).toBeFalsy();
  });

  it('cwd is captured at handler creation, not at call time', async () => {
    // Build the handler closed over tmpDir, then call it without changing
    // anything else. The expectation is that even if process.cwd() differs
    // from tmpDir at call time, the handler still uses tmpDir.
    const handler = createBashHandler('default', tmpDir);
    await fs.writeFile(join(tmpDir, 'marker.txt'), 'present', 'utf8');

    const result = await handler({ command: 'ls' }, createSignal());
    expect(result.content).toContain('marker.txt');
  });
});

// ---------------------------------------------------------------------------
// S10: bash handler must send SIGKILL (not the default SIGTERM) on both the
// timeout path and the abort/signal path. SIGTERM can be caught and ignored
// by user processes; SIGKILL cannot.
//
// Observable-behaviour approach: run a shell command that explicitly traps
// SIGTERM and ignores it (`trap '' TERM`), then sleep. A handler that only
// sends SIGTERM would be unable to kill this process and would hang (or
// produce a large elapsed time). A handler that sends SIGKILL terminates it
// promptly regardless of signal disposition.
// ---------------------------------------------------------------------------
describe('bash SIGKILL — S10', () => {
  function createSignal(): AbortSignal {
    return new AbortController().signal;
  }

  it('[timeout path] terminates a SIGTERM-immune process within the timeout window', async () => {
    // The command traps SIGTERM and ignores it, then sleeps 60s.
    // If proc.kill() sends SIGTERM (the no-arg default), the process would
    // survive and the handler would hang waiting for it to die naturally —
    // the test would time out at 60s. With SIGKILL the process dies immediately
    // and the result arrives well within the 2s safety margin below.
    const start = Date.now();
    const result = await createBashHandler('default')(
      { command: "trap '' TERM; sleep 60", timeout_ms: 150 },
      createSignal(),
    );
    const elapsed = Date.now() - start;

    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
    // Must complete quickly — SIGKILL terminates the process immediately;
    // SIGTERM would leave it running for up to 60s.
    expect(elapsed).toBeLessThan(2000);
  }, { timeout: 5000 });

  it('[abort path] terminates a SIGTERM-immune process when AbortSignal fires', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const start = Date.now();
    const result = await createBashHandler('default')(
      // trap '' TERM makes SIGTERM a no-op; only SIGKILL will kill this.
      { command: "trap '' TERM; sleep 60" },
      controller.signal,
    );
    const elapsed = Date.now() - start;

    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
    // Same reasoning: SIGKILL terminates promptly; SIGTERM would not.
    expect(elapsed).toBeLessThan(2000);
  }, { timeout: 5000 });

  it(
    '[process-group kill] reaps descendant processes, not just the direct child',
    async () => {
      // Launch a shell that backgrounds a long-lived grandchild and prints its
      // PID, then waits.  The process-group kill (kill -SIGKILL -<pgid>) must
      // reach the grandchild too; a bare proc.kill() on the shell PID would
      // leave `sleep 9999` running as an orphan.
      //
      // Command breakdown:
      //   sleep 9999 &   — start a long-running grandchild in the background
      //   echo $!        — print its PID to stdout so the test can capture it
      //   wait           — keep the shell alive (so it can be killed by the handler)
      const result = await createBashHandler('default')(
        { command: 'sleep 9999 & echo $!; wait', timeout_ms: 300 },
        new AbortController().signal,
      );

      // The handler must have timed out (isError) and the stdout must contain
      // at least one numeric PID printed by `echo $!`.
      expect(result.isError).toBe(true);
      expect(result.content).toContain('timed out');

      // Extract the first decimal integer from output — that is the grandchild PID.
      const pidMatch = (result.content as string).match(/\d+/);
      expect(pidMatch).not.toBeNull();
      const grandchildPid = pidMatch![0];

      // Give the OS a moment to fully reap every member of the killed process
      // group before we probe.  100 ms is ample; the group kill is synchronous.
      await new Promise<void>((r) => setTimeout(r, 100));

      // `kill -0 <pid>` succeeds (exit 0) if the process exists, fails (exit 1)
      // if it is gone.  We want it to be gone — any other result means the
      // process-group kill missed the grandchild.
      //
      // Risk: PID reuse — in pathological CI environments a new unrelated
      // process could recycle this PID within the 100 ms window, causing a
      // false-negative (test passes when grandchild leaked).  This is
      // intentionally acceptable; the inverse false-positive (test fails when
      // grandchild is gone) cannot occur because kill -0 is non-destructive.
      const probe = spawnSync('kill', ['-0', grandchildPid]);
      expect(probe.status).toBe(1); // exit 1 → process is gone (correctly reaped)
    },
    5000, // vitest per-test timeout: 5 s (handler kills at 300 ms + 100 ms reap window + headroom)
  );
});

// ---------------------------------------------------------------------------
// C4 (#354): best-effort readRoots/writeRoots path-containment scan.
//
// The scan is ADVISORY-ONLY: when a command references an absolute/home-relative
// path outside the session's writeRoots it emits one `[security]` console.warn
// (and a telemetry row) but STILL executes the command — it never blocks. These
// tests assert both halves: the warning fires (or is suppressed) as specified,
// AND the command runs to completion either way.
//
// NB: appendRoutingDecision is a no-op under vitest (env.VITEST guard), so we
// spy on console.warn — the reliable, synchronous signal that the escape path
// was taken. `warnIfBypassPermissions` also writes a `[security]` line, so we
// match specifically on the path-escape substring to disambiguate.
// ---------------------------------------------------------------------------
describe('bash path-containment scan — C4 (#354)', () => {
  function createSignal(): AbortSignal {
    return new AbortController().signal;
  }

  const ESCAPE_MARKER = 'command references path(s) outside writeRoots';

  let root: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Real temp dir so realpathSafe (inside wouldBeRestricted) resolves.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'bash-contain-')));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function escapeWarnings(): string[] {
    return warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes(ESCAPE_MARKER));
  }

  it('warns AND still executes when a command references a path outside writeRoots', async () => {
    // 'default' mode → allowAll is NOT set, so containment is enforced/advised.
    const handler = createBashHandler('default', root);
    const result = await handler(
      { command: 'echo hi /etc/hosts' },
      createSignal(),
      { resolveBase: root, readRoots: [root], writeRoots: [root], allowAll: false },
    );

    // Warned about the escape…
    const warnings = escapeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/etc/hosts');
    expect(warnings[0]).toContain('best-effort');

    // …but the command STILL ran (advisory-only, not a block).
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hi');
  });

  it('expands ~/… and warns when a home-relative path escapes writeRoots', async () => {
    // End-to-end exercise of scanPathsBestEffort's ~ / ~/… expansion branch:
    // `~/.ssh/id_rsa` expands to os.homedir()/.ssh/id_rsa — outside the temp-dir
    // writeRoots — so it warns (and still executes). Had expansion NOT fired, the
    // token would anchor to resolveBase (in-root) and produce zero warnings, so
    // the single warning is itself proof the expansion happened.
    const handler = createBashHandler('default', root);
    const result = await handler(
      { command: 'echo hi ~/.ssh/id_rsa' },
      createSignal(),
      { resolveBase: root, readRoots: [root], writeRoots: [root], allowAll: false },
    );

    const warnings = escapeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(os.homedir(), '.ssh/id_rsa'));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hi');
  });

  it('does NOT warn when allowAll (bypass) is set, even for an out-of-root path', async () => {
    const handler = createBashHandler('default', root);
    const result = await handler(
      { command: 'echo hi /etc/hosts' },
      createSignal(),
      { resolveBase: root, readRoots: [root], writeRoots: [root], allowAll: true },
    );

    expect(escapeWarnings()).toHaveLength(0);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hi');
  });

  it('does NOT warn when the command references only in-root paths', async () => {
    const inRoot = join(root, 'file.txt');
    const handler = createBashHandler('default', root);
    const result = await handler(
      { command: `echo hi ${inRoot}` },
      createSignal(),
      { resolveBase: root, readRoots: [root], writeRoots: [root], allowAll: false },
    );

    expect(escapeWarnings()).toHaveLength(0);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hi');
  });

  it('warns at most once per handler instance (one-time latch)', async () => {
    const handler = createBashHandler('default', root);
    const ctx = { resolveBase: root, readRoots: [root], writeRoots: [root], allowAll: false };
    await handler({ command: 'cat /etc/hosts' }, createSignal(), ctx);
    await handler({ command: 'cat /etc/passwd' }, createSignal(), ctx);

    // Latch means the second escaping command does not re-warn.
    expect(escapeWarnings()).toHaveLength(1);
  });

  it('does NOT warn when no context is supplied (inline/back-compat call)', async () => {
    const handler = createBashHandler('default', root);
    const result = await handler({ command: 'echo hi /etc/hosts' }, createSignal());
    expect(escapeWarnings()).toHaveLength(0);
    expect(result.isError).toBeFalsy();
  });
});


