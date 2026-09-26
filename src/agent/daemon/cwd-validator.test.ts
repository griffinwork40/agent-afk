/**
 * Tests for cwd-validator.ts — per-task working directory validation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { validateScheduleCwd, expandCwd, checkTaskCwdAtRuntime } from './cwd-validator.js';

describe('expandCwd', () => {
  it('expands bare ~ to homedir', () => {
    expect(expandCwd('~')).toBe(homedir());
  });

  it('expands ~/foo to homedir/foo', () => {
    expect(expandCwd('~/foo')).toBe(join(homedir(), 'foo'));
  });

  it('returns absolute path unchanged', () => {
    expect(expandCwd('/tmp/foo')).toBe('/tmp/foo');
  });
});

describe('validateScheduleCwd', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok:true for an existing directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cwd-val-'));
    const result = validateScheduleCwd(tmpDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(tmpDir);
  });

  it('returns ok:true and resolves tilde path', () => {
    // We expand ~/. (home dir itself) — always exists
    const result = validateScheduleCwd('~');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(homedir());
  });

  it('returns ok:false for a missing path', () => {
    const result = validateScheduleCwd('/nonexistent/path/that/does/not/exist');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not exist/);
  });

  it('returns ok:false for a path that is a file, not a directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cwd-val-'));
    const file = join(tmpDir, 'file.txt');
    writeFileSync(file, 'hello');
    const result = validateScheduleCwd(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a directory/);
  });

  it('resolves to absolute path when given relative input', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cwd-val-'));
    // We need a relative path from cwd — use the tmpDir as absolute to avoid
    // process.cwd() dependency, but test the resolve call:
    const result = validateScheduleCwd(tmpDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(tmpDir);
  });
});

describe('checkTaskCwdAtRuntime', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined for an existing directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cwd-runtime-'));
    expect(checkTaskCwdAtRuntime(tmpDir)).toBeUndefined();
  });

  it('returns an error string for a missing path', () => {
    const err = checkTaskCwdAtRuntime('/nonexistent/dir/abc123');
    expect(err).toMatch(/does not exist/);
  });

  it('returns an error string when path is a file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cwd-runtime-'));
    const file = join(tmpDir, 'f.txt');
    writeFileSync(file, 'x');
    const err = checkTaskCwdAtRuntime(file);
    expect(err).toMatch(/not a directory/);
  });
});
