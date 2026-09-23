import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { atomicWriteFile, atomicWriteFileAsync } from './atomic-write.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'afk-atomic-write-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// atomicWriteFile (sync)
// ---------------------------------------------------------------------------

describe('atomicWriteFile (sync)', () => {
  it('writes content to the target path', () => {
    const filePath = join(testDir, 'out.txt');
    atomicWriteFile(filePath, 'hello world');
    expect(readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('overwrites an existing file atomically', () => {
    const filePath = join(testDir, 'out.txt');
    writeFileSync(filePath, 'old content');
    atomicWriteFile(filePath, 'new content');
    expect(readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('creates parent directories by default (mkdirp: true)', () => {
    const filePath = join(testDir, 'deep', 'nested', 'dir', 'out.txt');
    atomicWriteFile(filePath, 'deep write');
    expect(readFileSync(filePath, 'utf-8')).toBe('deep write');
  });

  it('respects mkdirp: false when directory already exists', () => {
    const filePath = join(testDir, 'out.txt');
    atomicWriteFile(filePath, 'content', { mkdirp: false });
    expect(readFileSync(filePath, 'utf-8')).toBe('content');
  });

  it('throws when mkdirp: false and directory does not exist', () => {
    const filePath = join(testDir, 'nonexistent', 'out.txt');
    expect(() => atomicWriteFile(filePath, 'x', { mkdirp: false })).toThrow();
  });

  it('applies mode 0o600 by default', () => {
    const filePath = join(testDir, 'secret.txt');
    atomicWriteFile(filePath, 'secret');
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('applies a custom mode', () => {
    const filePath = join(testDir, 'public.txt');
    atomicWriteFile(filePath, 'public', { mode: 0o644 });
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  it('leaves no temp file behind on success', () => {
    const filePath = join(testDir, 'out.txt');
    atomicWriteFile(filePath, 'content');
    const files = require('fs').readdirSync(testDir);
    expect(files).toEqual(['out.txt']);
  });

  it('leaves no temp file behind on failure (mkdirp: false, missing dir)', () => {
    const filePath = join(testDir, 'missing', 'out.txt');
    try {
      atomicWriteFile(filePath, 'x', { mkdirp: false });
    } catch {
      /* expected */
    }
    // The parent dir doesn't exist so nothing could have been written anyway
    expect(existsSync(testDir + '/missing')).toBe(false);
  });

  it('respects a custom encoding', () => {
    const filePath = join(testDir, 'out.txt');
    atomicWriteFile(filePath, 'héllo', { encoding: 'utf-8' });
    expect(readFileSync(filePath, 'utf-8')).toBe('héllo');
  });
});

// ---------------------------------------------------------------------------
// atomicWriteFile with secure: true (O_EXCL)
// ---------------------------------------------------------------------------

describe('atomicWriteFile with secure: true (O_EXCL)', () => {
  it('writes successfully when no temp file pre-exists', () => {
    const filePath = join(testDir, 'secure.txt');
    atomicWriteFile(filePath, 'secure content', { secure: true });
    expect(readFileSync(filePath, 'utf-8')).toBe('secure content');
  });

  it('succeeds when the TARGET already exists (rename overwrites)', () => {
    const filePath = join(testDir, 'secure.txt');
    writeFileSync(filePath, 'original');
    atomicWriteFile(filePath, 'updated', { secure: true });
    expect(readFileSync(filePath, 'utf-8')).toBe('updated');
  });

  it('does not leave a temp file on success', () => {
    const filePath = join(testDir, 'secure.txt');
    atomicWriteFile(filePath, 'data', { secure: true });
    const files = require('fs').readdirSync(testDir);
    expect(files).toEqual(['secure.txt']);
  });
});

// ---------------------------------------------------------------------------
// atomicWriteFileAsync (async)
// ---------------------------------------------------------------------------

describe('atomicWriteFileAsync (async)', () => {
  it('writes content to the target path', async () => {
    const filePath = join(testDir, 'async.txt');
    await atomicWriteFileAsync(filePath, 'async hello');
    expect(readFileSync(filePath, 'utf-8')).toBe('async hello');
  });

  it('overwrites an existing file atomically', async () => {
    const filePath = join(testDir, 'async.txt');
    writeFileSync(filePath, 'old');
    await atomicWriteFileAsync(filePath, 'new');
    expect(readFileSync(filePath, 'utf-8')).toBe('new');
  });

  it('creates parent directories by default', async () => {
    const filePath = join(testDir, 'async', 'nested', 'out.txt');
    await atomicWriteFileAsync(filePath, 'nested async');
    expect(readFileSync(filePath, 'utf-8')).toBe('nested async');
  });

  it('applies mode 0o600 by default', async () => {
    const filePath = join(testDir, 'async-secret.txt');
    await atomicWriteFileAsync(filePath, 'secret');
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('leaves no temp file behind on success', async () => {
    const filePath = join(testDir, 'async.txt');
    await atomicWriteFileAsync(filePath, 'content');
    const files = require('fs').readdirSync(testDir);
    expect(files).toEqual(['async.txt']);
  });

  it('throws when mkdirp: false and directory does not exist', async () => {
    const filePath = join(testDir, 'missing', 'async.txt');
    await expect(atomicWriteFileAsync(filePath, 'x', { mkdirp: false })).rejects.toThrow();
  });

  it('serialized concurrent writes both land (last-write wins on content)', async () => {
    const filePath = join(testDir, 'concurrent.txt');
    // Fire two concurrent writes — both must resolve without error.
    await Promise.all([
      atomicWriteFileAsync(filePath, 'write-A'),
      atomicWriteFileAsync(filePath, 'write-B'),
    ]);
    const result = readFileSync(filePath, 'utf-8');
    expect(['write-A', 'write-B']).toContain(result);
  });

  it('uses secure: true (O_EXCL) without error when no temp collides', async () => {
    const filePath = join(testDir, 'async-secure.txt');
    await atomicWriteFileAsync(filePath, 'secure async', { secure: true });
    expect(readFileSync(filePath, 'utf-8')).toBe('secure async');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles an empty content string', () => {
    const filePath = join(testDir, 'empty.txt');
    atomicWriteFile(filePath, '');
    expect(readFileSync(filePath, 'utf-8')).toBe('');
  });

  it('handles content with embedded newlines', () => {
    const filePath = join(testDir, 'multiline.txt');
    const content = 'line1\nline2\nline3\n';
    atomicWriteFile(filePath, content);
    expect(readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('handles a pre-existing deeply nested target directory', () => {
    const deep = join(testDir, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    const filePath = join(deep, 'out.json');
    atomicWriteFile(filePath, '{"ok":true}');
    expect(readFileSync(filePath, 'utf-8')).toBe('{"ok":true}');
  });
});
