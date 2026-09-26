/**
 * Tests for cwd-validator.ts — per-task working directory validation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
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
    const rel = relative(process.cwd(), tmpDir);
    const result = validateScheduleCwd(rel);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(tmpDir);
  });

  it('returns ok:false for ~user/foo unsupported tilde form', () => {
    const result = validateScheduleCwd('~otheruser/projects');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unsupported tilde form/);
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

  it('detects a swapped symlink (TOCTOU guard)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cwd-symlink-'));
    const realDir = join(tmpDir, 'real');
    mkdirSync(realDir);
    const link = join(tmpDir, 'link');
    symlinkSync(realDir, link);
    // Symlink is valid — should pass
    expect(checkTaskCwdAtRuntime(link)).toBeUndefined();
    // Remove the real target — symlink is now dangling
    rmSync(realDir, { recursive: true, force: true });
    const err = checkTaskCwdAtRuntime(link);
    expect(err).toMatch(/does not resolve|does not exist|not a directory/);
  });
});
