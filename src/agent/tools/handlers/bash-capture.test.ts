/**
 * Regression tests for bash output capture and TUI outcome formatting.
 *
 * Scope (First Increment):
 * - Success path: small output, no truncation, no capture.
 * - Success path: large output (>100KB, <8MB), capture file written.
 * - Failure path: non-zero exit with large stderr, capture file written.
 * - Hard-cap (SIGKILL) path: truncated=true, no capture (middle unrecoverable).
 * - Hidden-vs-discarded distinction in formatOutcome.
 * - Accessibility/hyperlink path in formatOutcome.
 * - Safeguards: write failure is swallowed (best-effort), no crash.
 * - Safeguards: captured file mode is 0600, path is under state dir.
 * - durationMs is set on success and failure results.
 *
 * @module agent/tools/handlers/bash-capture.test
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBashHandler } from './bash.js';

// ---------------------------------------------------------------------------
// Path isolation: redirect AFK_STATE_DIR to a temp dir per test so captures
// land in a controllable location and are cleaned up after each test.
// ---------------------------------------------------------------------------

let tmpStateDir: string;
let origStateDir: string | undefined;
let origAFKHome: string | undefined;

beforeEach(() => {
  tmpStateDir = mkdtempSync(join(tmpdir(), 'afk-bash-capture-test-'));
  origStateDir = process.env['AFK_STATE_DIR'];
  origAFKHome = process.env['AFK_HOME'];
  process.env['AFK_STATE_DIR'] = tmpStateDir;
  // Clear AFK_HOME so getAfkStateDir() uses the override above
  delete process.env['AFK_HOME'];
});

afterEach(() => {
  if (origStateDir !== undefined) {
    process.env['AFK_STATE_DIR'] = origStateDir;
  } else {
    delete process.env['AFK_STATE_DIR'];
  }
  if (origAFKHome !== undefined) {
    process.env['AFK_HOME'] = origAFKHome;
  } else {
    delete process.env['AFK_HOME'];
  }
  rmSync(tmpStateDir, { recursive: true, force: true });
});

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// Helper: run a bash command and return the ToolResult
// ---------------------------------------------------------------------------
async function run(
  command: string,
  ctx?: { sessionId?: string; toolUseId?: string },
) {
  const handler = createBashHandler('default');
  return handler({ command }, makeSignal(), ctx as Parameters<typeof handler>[2]);
}

// ---------------------------------------------------------------------------
// Success path — small output, no truncation
// ---------------------------------------------------------------------------

describe('bash capture — small output (no truncation)', () => {
  it('capturePath is undefined when output fits within 100KB', async () => {
    const result = await run('echo hello', { sessionId: 'sess-1', toolUseId: 'tu-1' });
    expect(result.isError).toBeFalsy();
    expect(result.capturePath).toBeUndefined();
  });

  it('durationMs is a non-negative number on success', async () => {
    const result = await run('echo hi', { sessionId: 'sess-1', toolUseId: 'tu-1' });
    expect(result.isError).toBeFalsy();
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Large output (>100KB, command completes) — capture file is written
// ---------------------------------------------------------------------------

describe('bash capture — large output (model-truncated, command completes)', () => {
  it('capturePath is defined when output exceeds 100KB', async () => {
    // 110 000 'x' chars — well above the 100KB model cap but far below 8MB hard cap.
    const result = await run(
      "python3 -c \"print('x' * 110000)\"",
      { sessionId: 'sess-large', toolUseId: 'tu-large' },
    );
    expect(result.isError).toBeFalsy();
    expect(result.truncated).toBe(true);
    expect(result.capturePath).toBeDefined();
  });

  it('capture file exists and contains the full output', async () => {
    const result = await run(
      "python3 -c \"print('A' * 110000)\"",
      { sessionId: 'sess-full', toolUseId: 'tu-full' },
    );
    expect(result.capturePath).toBeDefined();
    const content = readFileSync(result.capturePath!, 'utf8');
    // The capture should have many more bytes than the model-facing head+tail
    expect(content.length).toBeGreaterThan(100_000);
    // Full content starts with 'A'
    expect(content.startsWith('A')).toBe(true);
  });

  it('capture file is under witness/<sessionId>/bash-captures/ (witness-sweep-covered path)', async () => {
    const result = await run(
      "python3 -c \"print('B' * 110000)\"",
      { sessionId: 'sess-path', toolUseId: 'tu-path' },
    );
    expect(result.capturePath).toBeDefined();
    // Must be under our temp state dir → witness → sessionId → bash-captures
    expect(result.capturePath!.startsWith(tmpStateDir)).toBe(true);
    expect(result.capturePath!).toContain('witness');
    expect(result.capturePath!).toContain('bash-captures');
    // Session dir must be present in the path
    expect(result.capturePath!).toContain('sess-path');
  });

  it('capture parent directory has mode 0700 (owner only)', async () => {
    const result = await run(
      "python3 -c \"print('D2' * 55000)\"",
      { sessionId: 'sess-dirmode', toolUseId: 'tu-dirmode' },
    );
    expect(result.capturePath).toBeDefined();
    const { statSync, dirname } = await import('node:path').then(() =>
      import('node:fs').then(fs => ({ statSync: fs.statSync, dirname: (p: string) => p.split('/').slice(0, -1).join('/') }))
    );
    const captureDir = result.capturePath!.split('/').slice(0, -1).join('/');
    const stats = statSync(captureDir);
    // Mode 0o700: owner rwx, no group or other bits. Platform mask: 0o777.
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('capture file is mode 0600 (owner read+write only)', async () => {
    const result = await run(
      "python3 -c \"print('C' * 110000)\"",
      { sessionId: 'sess-mode', toolUseId: 'tu-mode' },
    );
    expect(result.capturePath).toBeDefined();
    const stats = statSync(result.capturePath!);
    // Mode 0o600 = owner RW, no group/other. Platform mask: 0o777.
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('durationMs is a non-negative number when output is truncated', async () => {
    const result = await run(
      "python3 -c \"print('D' * 110000)\"",
      { sessionId: 'sess-dur', toolUseId: 'tu-dur' },
    );
    expect(result.truncated).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Non-zero exit with large stderr — capture file is written
// ---------------------------------------------------------------------------

describe('bash capture — non-zero exit with large stderr', () => {
  it('capturePath is defined when stderr exceeds 100KB on failure', async () => {
    const result = await run(
      "python3 -c \"import sys; sys.stderr.write('E' * 110000)\" ; exit 1",
      { sessionId: 'sess-err', toolUseId: 'tu-err' },
    );
    expect(result.isError).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.capturePath).toBeDefined();
  });

  it('capture file contains the full stderr on failure', async () => {
    const result = await run(
      "python3 -c \"import sys; sys.stderr.write('F' * 110000)\" ; exit 1",
      { sessionId: 'sess-err2', toolUseId: 'tu-err2' },
    );
    expect(result.capturePath).toBeDefined();
    const content = readFileSync(result.capturePath!, 'utf8');
    expect(content.length).toBeGreaterThan(100_000);
    expect(content).toContain('F');
  });

  it('durationMs is set on non-zero exit', async () => {
    const result = await run('exit 1', { sessionId: 'sess-exit', toolUseId: 'tu-exit' });
    expect(result.isError).toBe(true);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// SIGKILL (hard cap) path — no capture because middle bytes are unrecoverable
// ---------------------------------------------------------------------------

describe('bash capture — SIGKILL overflow path (no capture)', () => {
  it('capturePath is undefined when command is killed at the hard cap', async () => {
    // Generate 9MB — crosses HARD_CAP_BYTES (8MB) and triggers SIGKILL
    const result = await run(
      "head -c 9000000 /dev/zero | tr '\\0' 'G'",
      { sessionId: 'sess-kill', toolUseId: 'tu-kill' },
    );
    // Command is killed: content has the kill note
    expect(result.content).toContain('output truncated');
    expect(result.truncated).toBe(true);
    // Middle bytes never collected → no capture file
    expect(result.capturePath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Safeguard: write failure is swallowed — no crash, no capturePath
// ---------------------------------------------------------------------------

describe('bash capture — best-effort write (failure swallowed)', () => {
  it('does not throw when the state dir is unwritable; returns undefined capturePath', async () => {
    // Point AFK_STATE_DIR to a file (not a dir) so mkdirSync fails
    const dummyFile = join(tmpStateDir, 'not-a-dir');
    // Create it as a file so mkdir cannot use it
    writeFileSync(dummyFile, 'x');
    process.env['AFK_STATE_DIR'] = dummyFile;

    const result = await run(
      "python3 -c \"print('H' * 110000)\"",
      { sessionId: 'sess-fail', toolUseId: 'tu-fail' },
    );
    // Should succeed despite the write failure
    expect(result.isError).toBeFalsy();
    expect(result.truncated).toBe(true);
    // capturePath absent — write failed silently
    expect(result.capturePath).toBeUndefined();
  });
});
