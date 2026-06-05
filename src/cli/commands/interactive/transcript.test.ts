/**
 * Regression tests for S2 (transcript file permissions 0o600).
 *
 * Asserts that transcript files (created by startTranscript / appendTurn /
 * appendEnded / rotateOnClear) are written with mode 0o600 so their contents
 * are not world-readable.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Helper: mask off sticky/setuid/setgid bits to get rwxrwxrwx.
function permBits(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

describe('transcript — S2 file mode 0o600 regression', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('startTranscript creates file with mode 0o600', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-transcript-test-'));
    const { startTranscript } = await import('./transcript.js');
    const filePath = await startTranscript(tmpDir, 'claude-3-5-haiku-20241022');
    expect(permBits(filePath)).toBe(0o600);
  });

  it('initTranscript appendTurn writes to a file with mode 0o600', async () => {
    // Override AFK_STATE_DIR so transcript lands in our temp directory.
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-transcript-test-'));
    const savedEnv = process.env['AFK_STATE_DIR'];
    process.env['AFK_STATE_DIR'] = tmpDir;
    try {
      const { initTranscript } = await import('./transcript.js');
      const handle = await initTranscript(() => 'claude-3-5-haiku-20241022');
      await handle.appendTurn('hello', 'world');
      expect(permBits(handle.path())).toBe(0o600);
    } finally {
      if (savedEnv === undefined) {
        delete process.env['AFK_STATE_DIR'];
      } else {
        process.env['AFK_STATE_DIR'] = savedEnv;
      }
    }
  });
});
