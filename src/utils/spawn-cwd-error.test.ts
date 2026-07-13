/**
 * Tests for spawn-cwd error enrichment ({@link describeSpawnCwdError}).
 *
 * Covers the ENOENT masquerade: Node's spawn/execFile with a dead `cwd`
 * rejects with an error naming the BINARY (`spawn git ENOENT`), not the
 * missing directory. The helper translates that into an actionable message
 * — but ONLY when the cwd is actually missing, so a genuinely missing
 * binary is never mislabeled.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  describeSpawnCwdError,
  isSpawnEnoent,
  cwdIsMissing,
} from './spawn-cwd-error.js';

const execFile = promisify(execFileCallback);

/** Build a realistic spawn-ENOENT error object (shape Node emits). */
function spawnEnoentError(binary: string): Error {
  const err = new Error(`spawn ${binary} ENOENT`) as Error & {
    code: string;
    errno: number;
    syscall: string;
    path: string;
  };
  err.code = 'ENOENT';
  err.errno = -2;
  err.syscall = `spawn ${binary}`;
  err.path = binary;
  return err;
}

describe('isSpawnEnoent', () => {
  it('matches a spawn-phase ENOENT error', () => {
    expect(isSpawnEnoent(spawnEnoentError('git'))).toBe(true);
  });

  it('rejects non-spawn ENOENT (e.g. fs read)', () => {
    const err = new Error('ENOENT: no such file') as Error & { code: string; syscall: string };
    err.code = 'ENOENT';
    err.syscall = 'open';
    expect(isSpawnEnoent(err)).toBe(false);
  });

  it('rejects non-ENOENT errors and non-objects', () => {
    expect(isSpawnEnoent(new Error('boom'))).toBe(false);
    expect(isSpawnEnoent('spawn git ENOENT')).toBe(false);
    expect(isSpawnEnoent(null)).toBe(false);
    expect(isSpawnEnoent(undefined)).toBe(false);
  });
});

describe('cwdIsMissing', () => {
  it('returns false for undefined and for an existing directory', () => {
    expect(cwdIsMissing(undefined)).toBe(false);
    expect(cwdIsMissing(tmpdir())).toBe(false);
  });

  it('returns true for a deleted directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-cwd-test-'));
    rmSync(dir, { recursive: true, force: true });
    expect(cwdIsMissing(dir)).toBe(true);
  });
});

describe('describeSpawnCwdError', () => {
  it('rewrites a spawn ENOENT when the cwd is dead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-cwd-test-'));
    rmSync(dir, { recursive: true, force: true });
    const msg = describeSpawnCwdError(spawnEnoentError('git'), dir);
    expect(msg).toContain(`working directory does not exist: ${dir}`);
    expect(msg).toContain('deleted worktree?');
    expect(msg).toContain('spawn git ENOENT'); // original preserved
  });

  it('passes through a spawn ENOENT when the cwd is alive (genuinely missing binary)', () => {
    const msg = describeSpawnCwdError(
      spawnEnoentError('definitely-not-a-real-binary'),
      tmpdir(),
    );
    expect(msg).toBe('spawn definitely-not-a-real-binary ENOENT');
  });

  it('passes through non-ENOENT errors unchanged', () => {
    expect(describeSpawnCwdError(new Error('exit code 1'), '/nonexistent')).toBe('exit code 1');
  });

  it('stringifies non-Error inputs', () => {
    expect(describeSpawnCwdError('weird', undefined)).toBe('weird');
  });

  it('enriches a REAL execFile rejection from a dead cwd (integration)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-cwd-test-'));
    rmSync(dir, { recursive: true, force: true });
    let caught: unknown;
    try {
      await execFile('git', ['--version'], { cwd: dir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const msg = describeSpawnCwdError(caught, dir);
    expect(msg).toContain(`working directory does not exist: ${dir}`);
  });

  it("enriches a REAL spawn 'error' event from a dead cwd (integration)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-cwd-test-'));
    rmSync(dir, { recursive: true, force: true });
    const err = await new Promise<Error>((resolve) => {
      const proc = spawn('echo alive', { shell: true, cwd: dir });
      proc.on('error', resolve);
    });
    expect(err.message).toContain('ENOENT');
    const msg = describeSpawnCwdError(err, dir);
    expect(msg).toContain(`working directory does not exist: ${dir}`);
  });
});
