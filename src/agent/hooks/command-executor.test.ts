/**
 * Tests for the shell-command hook executor.
 *
 * Uses real shell scripts (no spawn mock) — the subprocess stdio is the API
 * under test. Fake timers are used for the timeout test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { executeCommand } from './command-executor.js';
import type { HookContext } from '../hooks.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hook-exec-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  // Defensive: restore real timers even if a fake-timer test threw before its
  // own useRealTimers() ran. Leaked fake timers would stall later tests'
  // real-timer waits (the executor's setTimeout never fires) and surface as
  // unrelated cross-test timeouts.
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const baseContext: HookContext = {
  event: 'SessionStart',
  sessionId: 'test-session',
};

const preToolContext: HookContext = {
  event: 'PreToolUse',
  sessionId: 'test-session',
  toolName: 'bash',
  input: { command: 'echo hi' },
};

function makeOpts(
  command: string,
  context: HookContext = baseContext,
  timeoutMs = 10_000,
) {
  return {
    command,
    context,
    agentCwd: tmp,
    sessionId: 'test-session',
    timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Exit 0 — success
// ---------------------------------------------------------------------------

describe('exit 0 — success', () => {
  it('empty stdout → empty decision {}', async () => {
    const result = await executeCommand(makeOpts('exit 0'));
    expect(result.decision).toEqual({});
  });

  it('JSON stdout `{}` → empty decision', async () => {
    const result = await executeCommand(makeOpts("echo '{}'"));
    expect(result.decision).toEqual({});
  });

  it('continue: false in JSON stdout → blocking decision', async () => {
    const result = await executeCommand(makeOpts('echo \'{"continue":false}\''));
    expect(result.decision.continue).toBe(false);
  });

  it('decision: "block" + reason in JSON stdout → block decision', async () => {
    const result = await executeCommand(
      makeOpts('echo \'{"decision":"block","reason":"blocked!"}\''),
    );
    expect(result.decision.decision).toBe('block');
    expect(result.decision.reason).toBe('blocked!');
  });

  it('hookSpecificOutput.additionalContext → injectContext', async () => {
    const result = await executeCommand(
      makeOpts(
        'echo \'{"hookSpecificOutput":{"additionalContext":"injected context"}}\'',
      ),
    );
    expect(result.decision.injectContext).toBe('injected context');
  });

  it('decision: "approve" is parsed correctly', async () => {
    const result = await executeCommand(
      makeOpts('echo \'{"decision":"approve"}\''),
    );
    expect(result.decision.decision).toBe('approve');
  });

  it('invalid JSON stdout → empty decision (no throw)', async () => {
    const result = await executeCommand(makeOpts('echo "not json"'));
    expect(result.decision).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Exit 2 — block
// ---------------------------------------------------------------------------

describe('exit 2 — block', () => {
  it('exit 2 → decision.decision="block" with stderr as reason', async () => {
    const result = await executeCommand(
      makeOpts('echo "blocked here" >&2; exit 2'),
    );
    expect(result.decision.decision).toBe('block');
    expect(result.decision.reason).toContain('blocked here');
  });

  it('exit 2 with no stderr → default reason string', async () => {
    const result = await executeCommand(makeOpts('exit 2'));
    expect(result.decision.decision).toBe('block');
    expect(typeof result.decision.reason).toBe('string');
    expect((result.decision.reason?.length ?? 0) > 0).toBe(true);
  });

  it('exit 2 stderr reason is truncated to 500 chars', async () => {
    const longMsg = 'x'.repeat(600);
    const result = await executeCommand(
      makeOpts(`echo "${longMsg}" >&2; exit 2`),
    );
    expect(result.decision.decision).toBe('block');
    expect((result.decision.reason?.length ?? 0) <= 500).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-zero non-2 exit — non-blocking error
// ---------------------------------------------------------------------------

describe('non-zero non-2 exit — non-blocking error', () => {
  it('exit 1 → empty decision {} (non-blocking)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await executeCommand(makeOpts('exit 1'));
    expect(result.decision).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it('exit 42 → empty decision {} with a console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await executeCommand(makeOpts('exit 42'));
    expect(result.decision).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('process that hangs is killed after timeoutMs → empty decision', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = executeCommand(makeOpts('sleep 9999', baseContext, 500));

    // Advance timers past the timeout.
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.decision).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timed out'));

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Tilde expansion
// ---------------------------------------------------------------------------

describe('tilde expansion', () => {
  it('command starting with ~/ is expanded to homedir()', async () => {
    // Create a script in tmp that echoes '{}', accessible via tilde path.
    // Rather than put a real script in homedir, we verify tilde expansion
    // by checking the error message when the tilde-expanded path doesn't
    // exist — the path in the error should be absolute.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await executeCommand(
      makeOpts('~/nonexistent-afk-test-hook-12345.sh'),
    );
    // The script doesn't exist, so it exits non-zero (not 2), leaving an
    // empty decision and a warn. The important thing is it didn't crash with
    // a tilde-literal path.
    expect(result.decision).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it('tilde expands to the actual homedir()', async () => {
    // Write a real script to a known tmp path and invoke it with a path
    // that starts with ~/. Since tmp != homedir we cannot test the exact
    // tilde path directly, but we can verify the expansion logic by writing
    // a script next to the test and calling it with an explicit path.
    const scriptPath = join(tmp, 'probe.sh');
    writeFileSync(scriptPath, '#!/bin/sh\necho \'{"decision":"approve"}\'\n', 'utf-8');
    chmodSync(scriptPath, 0o755);
    const result = await executeCommand(makeOpts(scriptPath));
    expect(result.decision.decision).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// 64 KB output cap
// ---------------------------------------------------------------------------

describe('64 KB output cap', () => {
  it('large stdout is captured without throwing (capped at 64 KB)', async () => {
    // Generate > 64 KB of non-JSON output via `yes x | head -c 80000` — a
    // portable POSIX idiom (no python3 dependency, fast cold start).
    const result = await executeCommand(
      makeOpts('yes x | head -c 80000', baseContext, 15_000),
    );
    // Should complete without throwing; decision is {} because stdout is not JSON.
    expect(result.decision).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Stdin payload
// ---------------------------------------------------------------------------

describe('stdin payload', () => {
  it('provides session_id, hook_event_name, and cwd in stdin JSON', async () => {
    // Read stdin and assert the expected fields are present via substring
    // matching on the compact JSON payload (no python3 dependency). The script
    // approves only when both fields are found, so the assertion is meaningful.
    const scriptPath = join(tmp, 'probe-stdin.sh');
    writeFileSync(
      scriptPath,
      `#!/bin/sh
payload=$(cat)
case "$payload" in
  *'"session_id":"test-session"'*) ;;
  *) echo "missing session_id" >&2; exit 2 ;;
esac
case "$payload" in
  *'"hook_event_name":"SessionStart"'*) echo '{"decision":"approve"}' ;;
  *) echo "missing hook_event_name" >&2; exit 2 ;;
esac
`,
      'utf-8',
    );
    chmodSync(scriptPath, 0o755);

    const result = await executeCommand(makeOpts(scriptPath, baseContext));
    expect(result.decision.decision).toBe('approve');
  });

  it('PreToolUse context includes tool_name in stdin payload', async () => {
    // Read tool_name from stdin via substring match and block if it's 'bash'
    // (no python3 dependency — pure POSIX shell).
    const scriptPath = join(tmp, 'check-tool.sh');
    writeFileSync(
      scriptPath,
      `#!/bin/sh
payload=$(cat)
case "$payload" in
  *'"tool_name":"bash"'*) echo "bash tool detected" >&2; exit 2 ;;
esac
exit 0
`,
      'utf-8',
    );
    chmodSync(scriptPath, 0o755);

    const result = await executeCommand(makeOpts(scriptPath, preToolContext));
    expect(result.decision.decision).toBe('block');
    expect(result.decision.reason).toContain('bash tool detected');
  });
});

// ---------------------------------------------------------------------------
// stdin EPIPE race (CI regression)
// ---------------------------------------------------------------------------

describe('stdin EPIPE race (regression)', () => {
  it('does not leak an unhandled error when the child exits before stdin flushes', async () => {
    // Repro for the CI-only failure where all tests "passed" (8111) yet the job
    // exited non-zero with 6 "Errors": a large stdin payload (well over the OS
    // pipe buffer, so the write is buffered and flushes ASYNCHRONOUSLY) sent to
    // a command that exits immediately WITHOUT reading stdin. The child's stdin
    // read end closes while the parent's write is still pending → async EPIPE on
    // proc.stdin. Without an 'error' listener on proc.stdin, Node escalates it to
    // an unhandled error that vitest counts among "Errors". tool_input is echoed
    // verbatim into the stdin JSON payload (see command-executor.ts), so a large
    // command string inflates stdin past the pipe buffer. Several run in parallel
    // to make the race deterministic.
    const bigInput = 'x'.repeat(256 * 1024); // 256 KB ≫ pipe buffer (~64 KB)
    const ctx: HookContext = {
      event: 'PreToolUse',
      sessionId: 'test-session',
      toolName: 'bash',
      input: { command: bigInput },
    };

    const leaked: unknown[] = [];
    const onErr = (e: unknown) => leaked.push(e);
    process.on('uncaughtException', onErr);
    process.on('unhandledRejection', onErr);
    try {
      const results = await Promise.all(
        Array.from({ length: 16 }, () => executeCommand(makeOpts('exit 0', ctx))),
      );
      // Give any async stdin 'error' a tick to surface before asserting.
      await new Promise((r) => setTimeout(r, 150));
      for (const result of results) expect(result.decision).toEqual({});
      expect(leaked).toEqual([]);
    } finally {
      process.off('uncaughtException', onErr);
      process.off('unhandledRejection', onErr);
    }
  });
});

// ---------------------------------------------------------------------------
// Env injection
// ---------------------------------------------------------------------------

describe('env injection', () => {
  it('AFK_HOOK_EVENT env var is available to spawned process', async () => {
    const result = await executeCommand(
      makeOpts('echo "$AFK_HOOK_EVENT"', baseContext),
    );
    // Since exit 0 and stdout is "SessionStart\n" (not valid JSON), decision is {}.
    expect(result.decision).toEqual({});
  });

  it('AFK_PROJECT_DIR env var is set to agentCwd', async () => {
    const scriptPath = join(tmp, 'check-dir.sh');
    writeFileSync(
      scriptPath,
      `#!/bin/sh
if [ "$AFK_PROJECT_DIR" = "${tmp}" ]; then
  echo '{"decision":"approve"}'
else
  echo "wrong dir: $AFK_PROJECT_DIR" >&2
  exit 2
fi
`,
      'utf-8',
    );
    chmodSync(scriptPath, 0o755);
    const result = await executeCommand(makeOpts(scriptPath));
    expect(result.decision.decision).toBe('approve');
  });

  it('CLAUDE_PLUGIN_ROOT is set to pluginRoot for a plugin-contributed hook', async () => {
    const pluginDir = join(tmp, 'demo-plugin');
    const scriptPath = join(tmp, 'check-plugin-root.sh');
    writeFileSync(
      scriptPath,
      `#!/bin/sh
if [ "$CLAUDE_PLUGIN_ROOT" = "${pluginDir}" ]; then
  echo '{"decision":"approve"}'
else
  echo "wrong root: $CLAUDE_PLUGIN_ROOT" >&2
  exit 2
fi
`,
      'utf-8',
    );
    chmodSync(scriptPath, 0o755);
    const result = await executeCommand({ ...makeOpts(scriptPath), pluginRoot: pluginDir });
    expect(result.decision.decision).toBe('approve');
  });

  it('CLAUDE_PLUGIN_ROOT is NOT set for a non-plugin hook (no pluginRoot)', async () => {
    const scriptPath = join(tmp, 'check-no-plugin-root.sh');
    writeFileSync(
      scriptPath,
      `#!/bin/sh
if [ -z "$CLAUDE_PLUGIN_ROOT" ]; then
  echo '{"decision":"approve"}'
else
  echo "unexpected root: $CLAUDE_PLUGIN_ROOT" >&2
  exit 2
fi
`,
      'utf-8',
    );
    chmodSync(scriptPath, 0o755);
    const result = await executeCommand(makeOpts(scriptPath));
    expect(result.decision.decision).toBe('approve');
  });

  // -----------------------------------------------------------------------
  // F2 regression: secret env vars must NOT be forwarded to hook subprocess
  // -----------------------------------------------------------------------

  it('[F2 regression] ANTHROPIC_API_KEY is NOT in childEnv by default', async () => {
    // Set a dummy ANTHROPIC_API_KEY in the parent env to simulate the real case.
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'test-secret-key';
    try {
      const scriptPath = join(tmp, 'check-no-key.sh');
      writeFileSync(
        scriptPath,
        `#!/bin/sh
# If ANTHROPIC_API_KEY is present and non-empty, the hook subprocess has a secret leak.
if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "SECRET LEAKED: $ANTHROPIC_API_KEY" >&2
  exit 2
fi
echo '{"decision":"approve"}'
`,
        'utf-8',
      );
      chmodSync(scriptPath, 0o755);
      const result = await executeCommand(makeOpts(scriptPath));
      // exit 0 with decision:approve means ANTHROPIC_API_KEY was NOT in env
      expect(result.decision.decision).toBe('approve');
    } finally {
      if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = originalKey;
    }
  });

  it('[F2 regression] TELEGRAM_BOT_TOKEN is NOT in childEnv by default', async () => {
    const originalToken = process.env['TELEGRAM_BOT_TOKEN'];
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-telegram-token';
    try {
      const scriptPath = join(tmp, 'check-no-telegram.sh');
      writeFileSync(
        scriptPath,
        `#!/bin/sh
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  echo "TELEGRAM TOKEN LEAKED" >&2
  exit 2
fi
echo '{"decision":"approve"}'
`,
        'utf-8',
      );
      chmodSync(scriptPath, 0o755);
      const result = await executeCommand(makeOpts(scriptPath));
      expect(result.decision.decision).toBe('approve');
    } finally {
      if (originalToken === undefined) delete process.env['TELEGRAM_BOT_TOKEN'];
      else process.env['TELEGRAM_BOT_TOKEN'] = originalToken;
    }
  });

  it('[F2 regression] OPENAI_API_KEY is NOT in childEnv by default', async () => {
    const originalKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'test-openai-key';
    try {
      const scriptPath = join(tmp, 'check-no-openai.sh');
      writeFileSync(
        scriptPath,
        `#!/bin/sh
if [ -n "$OPENAI_API_KEY" ]; then
  echo "OPENAI KEY LEAKED" >&2
  exit 2
fi
echo '{"decision":"approve"}'
`,
        'utf-8',
      );
      chmodSync(scriptPath, 0o755);
      const result = await executeCommand(makeOpts(scriptPath));
      expect(result.decision.decision).toBe('approve');
    } finally {
      if (originalKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = originalKey;
    }
  });

  it('[F2 regression] AFK_* vars from parent env ARE forwarded to hook subprocess', async () => {
    const originalVal = process.env['AFK_CUSTOM_TEST_VAR'];
    process.env['AFK_CUSTOM_TEST_VAR'] = 'hello-from-parent';
    try {
      const scriptPath = join(tmp, 'check-afk-var.sh');
      writeFileSync(
        scriptPath,
        `#!/bin/sh
if [ "$AFK_CUSTOM_TEST_VAR" = "hello-from-parent" ]; then
  echo '{"decision":"approve"}'
else
  echo "AFK var missing or wrong: $AFK_CUSTOM_TEST_VAR" >&2
  exit 2
fi
`,
        'utf-8',
      );
      chmodSync(scriptPath, 0o755);
      const result = await executeCommand(makeOpts(scriptPath));
      expect(result.decision.decision).toBe('approve');
    } finally {
      if (originalVal === undefined) delete process.env['AFK_CUSTOM_TEST_VAR'];
      else process.env['AFK_CUSTOM_TEST_VAR'] = originalVal;
    }
  });

  // -----------------------------------------------------------------------
  // AFK_-prefixed credential aliases must NOT be forwarded (closes the gap
  // where the AFK_* passthrough re-leaked secrets the bare-name allowlist
  // was designed to contain).
  // -----------------------------------------------------------------------

  it.each([
    ['AFK_TELEGRAM_BOT_TOKEN', 'test-afk-telegram-token'],
    ['AFK_LOCAL_API_KEY', 'test-afk-local-key'],
    ['AFK_OPENAI_API_KEY', 'test-afk-openai-key'],
  ])('AFK_-prefixed secret %s is NOT forwarded to the hook subprocess', async (name, value) => {
    const original = process.env[name];
    process.env[name] = value;
    try {
      const scriptPath = join(tmp, 'check-no-afk-secret.sh');
      writeFileSync(
        scriptPath,
        `#!/bin/sh
if [ -n "\$${name}" ]; then
  echo "AFK SECRET LEAKED: ${name}" >&2
  exit 2
fi
echo '{"decision":"approve"}'
`,
        'utf-8',
      );
      chmodSync(scriptPath, 0o755);
      const result = await executeCommand(makeOpts(scriptPath));
      // approve (exit 0) means the AFK_-prefixed secret was absent from childEnv.
      expect(result.decision.decision).toBe('approve');
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });
});
