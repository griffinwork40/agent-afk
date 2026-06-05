/**
 * Unit tests for the write_file tool handler.
 *
 * Tests the handler's ability to write files, create parent directories,
 * overwrite existing files, validate input, and handle errors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync, chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileHandler } from './write-file.js';
import type { ToolHandlerContext } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-write-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('writeFileHandler', () => {
  it('writes content to a new file', async () => {
    const filePath = join(tmpDir, 'test.txt');
    const content = 'Hello, World!';

    const result = await writeFileHandler(
      { file_path: filePath, content },
      AbortSignal.timeout(5000),
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('Wrote');
    expect(result.content).toContain(filePath);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe(content);
  });

  it('creates parent directories that do not exist', async () => {
    const filePath = join(tmpDir, 'a', 'b', 'c', 'test.txt');
    const content = 'nested file';

    const result = await writeFileHandler(
      { file_path: filePath, content },
      AbortSignal.timeout(5000),
    );

    expect(result.isError).not.toBe(true);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe(content);
  });

  it('overwrites an existing file', async () => {
    const filePath = join(tmpDir, 'overwrite.txt');
    const originalContent = 'original';
    const newContent = 'replaced';

    // Write original
    await writeFileHandler(
      { file_path: filePath, content: originalContent },
      AbortSignal.timeout(5000),
    );
    expect(readFileSync(filePath, 'utf8')).toBe(originalContent);

    // Overwrite
    const result = await writeFileHandler(
      { file_path: filePath, content: newContent },
      AbortSignal.timeout(5000),
    );

    expect(result.isError).not.toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe(newContent);
  });

  it('returns byte count in success message', async () => {
    const filePath = join(tmpDir, 'bytes.txt');
    const content = 'Test';

    const result = await writeFileHandler(
      { file_path: filePath, content },
      AbortSignal.timeout(5000),
    );

    const byteCount = Buffer.byteLength(content, 'utf8');
    expect(result.content).toContain(`Wrote ${byteCount} bytes`);
  });

  it('handles empty content (0 bytes)', async () => {
    const filePath = join(tmpDir, 'empty.txt');
    const content = '';

    const result = await writeFileHandler(
      { file_path: filePath, content },
      AbortSignal.timeout(5000),
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('Wrote 0 bytes');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('');
  });

  it('throws when file_path is missing', async () => {
    const input = { content: 'test' };

    await expect(
      writeFileHandler(input, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/file_path/);
  });

  it('throws when content is missing', async () => {
    const filePath = join(tmpDir, 'test.txt');
    const input = { file_path: filePath };

    await expect(
      writeFileHandler(input, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/content/);
  });

  it('throws when file_path is not a string', async () => {
    const input = { file_path: 123, content: 'test' };

    await expect(
      writeFileHandler(input, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/file_path/);
  });

  it('throws when content is not a string', async () => {
    const filePath = join(tmpDir, 'test.txt');
    const input = { file_path: filePath, content: { nested: 'object' } };

    await expect(
      writeFileHandler(input, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/content/);
  });

  it('throws when input is not an object', async () => {
    await expect(
      writeFileHandler('not an object', AbortSignal.timeout(5000)),
    ).rejects.toThrow(/object/);
  });

  it('throws when input is null', async () => {
    await expect(
      writeFileHandler(null, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/object/);
  });

  it('returns aborted message when signal is already aborted', async () => {
    const filePath = join(tmpDir, 'test.txt');
    const controller = new AbortController();
    controller.abort();

    const result = await writeFileHandler(
      { file_path: filePath, content: 'test' },
      controller.signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe('Aborted');
  });

  it('returns permission error for read-only parent directory', async () => {
    const parentDir = join(tmpDir, 'readonly');
    mkdirSync(parentDir, { recursive: true });
    const filePath = join(parentDir, 'test.txt');

    // Make directory read-only
    chmodSync(parentDir, 0o444);

    try {
      const result = await writeFileHandler(
        { file_path: filePath, content: 'test' },
        AbortSignal.timeout(5000),
      );

      // Should return permission error
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Permission denied');
    } finally {
      // Restore permissions for cleanup
      chmodSync(parentDir, 0o755);
    }
  });

  it('correctly counts UTF-8 byte length for multi-byte characters', async () => {
    const filePath = join(tmpDir, 'utf8.txt');
    const content = '你好世界'; // 4 characters, 12 bytes in UTF-8

    const result = await writeFileHandler(
      { file_path: filePath, content },
      AbortSignal.timeout(5000),
    );

    expect(result.content).toContain('Wrote 12 bytes');
    expect(existsSync(filePath)).toBe(true);
  });

});

describe('writeFileHandler cwd containment', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `afk-write-contain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects absolute path outside context.cwd', async () => {
    const context: ToolHandlerContext = { cwd: tempDir };
    const result = await writeFileHandler(
      { file_path: '/etc/passwd', content: 'bad' },
      AbortSignal.timeout(5000),
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed/);
  });

  it('resolves relative path against context.cwd', async () => {
    const context: ToolHandlerContext = { cwd: tempDir };
    const result = await writeFileHandler(
      { file_path: 'relative.txt', content: 'relative content' },
      AbortSignal.timeout(5000),
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(tempDir, 'relative.txt'))).toBe(true);
    expect(readFileSync(join(tempDir, 'relative.txt'), 'utf8')).toBe('relative content');
  });

  it('allows absolute path within context.cwd', async () => {
    const filePath = join(tempDir, 'inside.txt');
    const context: ToolHandlerContext = { cwd: tempDir };
    const result = await writeFileHandler(
      { file_path: filePath, content: 'inside data' },
      AbortSignal.timeout(5000),
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(filePath, 'utf8')).toBe('inside data');
  });

  it('falls back to process.cwd() resolution when no cwd in context', async () => {
    const filePath = join(tempDir, 'nocontext.txt');
    const context: ToolHandlerContext = {};
    const result = await writeFileHandler(
      { file_path: filePath, content: 'no cwd context' },
      AbortSignal.timeout(5000),
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(filePath, 'utf8')).toBe('no cwd context');
  });

  describe('render-only diff payload', () => {
    it('emits an all-additions diff for a brand-new file', async () => {
      const filePath = join(tmpDir, 'new.txt');
      const result = await writeFileHandler(
        { file_path: filePath, content: 'a\nb\nc' },
        AbortSignal.timeout(5000),
      );
      expect(result.isError).toBeFalsy();
      expect(result.render?.diff).toBeDefined();
      expect(result.render!.diff!.addedLines).toBe(3);
      expect(result.render!.diff!.removedLines).toBe(0);
    });

    it('emits a mixed diff for an overwrite', async () => {
      const filePath = join(tmpDir, 'overwrite.txt');
      // First write — creates the file.
      await writeFileHandler(
        { file_path: filePath, content: 'one\ntwo\nthree' },
        AbortSignal.timeout(5000),
      );
      // Second write — should diff against the prior content.
      const result = await writeFileHandler(
        { file_path: filePath, content: 'one\nTWO\nthree' },
        AbortSignal.timeout(5000),
      );
      expect(result.isError).toBeFalsy();
      expect(result.render?.diff).toBeDefined();
      expect(result.render!.diff!.addedLines).toBe(1);
      expect(result.render!.diff!.removedLines).toBe(1);
    });

    it('omits diff when the write is byte-identical to the prior content', async () => {
      const filePath = join(tmpDir, 'noop-write.txt');
      const content = 'identical content\nthroughout';
      await writeFileHandler(
        { file_path: filePath, content },
        AbortSignal.timeout(5000),
      );
      const result = await writeFileHandler(
        { file_path: filePath, content },
        AbortSignal.timeout(5000),
      );
      expect(result.isError).toBeFalsy();
      expect(result.render).toBeUndefined();
    });

    it('keeps model-facing content as the one-line summary only', async () => {
      const filePath = join(tmpDir, 'summary.txt');
      const result = await writeFileHandler(
        { file_path: filePath, content: 'multi\nline\ncontent' },
        AbortSignal.timeout(5000),
      );
      expect(result.content).toMatch(/^Wrote \d+ bytes to /);
      expect(result.content).not.toContain('\n');
    });

    it('F2: omits diff when AFK_WRITE_DIFF=0 (I/O opt-out)', async () => {
      const filePath = join(tmpDir, 'no-diff.txt');
      const original = process.env['AFK_WRITE_DIFF'];
      process.env['AFK_WRITE_DIFF'] = '0';
      try {
        const result = await writeFileHandler(
          { file_path: filePath, content: 'a\nb\nc' },
          AbortSignal.timeout(5000),
        );
        expect(result.isError).toBeFalsy();
        // No diff payload should be present when opt-out is active.
        expect(result.render).toBeUndefined();
      } finally {
        if (original === undefined) delete process.env['AFK_WRITE_DIFF'];
        else process.env['AFK_WRITE_DIFF'] = original;
      }
    });

    it('F6: skips diff for content with null bytes (binary guard)', async () => {
      const filePath = join(tmpDir, 'binary.bin');
      // Content with embedded null byte — should not produce a diff payload.
      const content = 'before\0after';
      const result = await writeFileHandler(
        { file_path: filePath, content },
        AbortSignal.timeout(5000),
      );
      expect(result.isError).toBeFalsy();
      expect(result.render).toBeUndefined();
    });

    it('F9: reads binary pre-existing file as Buffer before UTF-8 check (no mangling)', async () => {
      const filePath = join(tmpDir, 'binary-preexist.bin');
      // Write raw binary bytes that are not valid UTF-8.
      writeFileSync(filePath, Buffer.from([0xff, 0xfe, 0x00, 0x01]));

      // Overwrite with valid text content — the pre-read of the binary file
      // must not mangle bytes (U+FFFD) before the guard fires.
      const result = await writeFileHandler(
        { file_path: filePath, content: 'now valid text' },
        AbortSignal.timeout(5000),
      );

      // Write should succeed.
      expect(result.isError).not.toBe(true);
      // No diff should be produced for a binary → text transition.
      expect(result.render).toBeUndefined();
    });

    it('P1: skips diff pre-read when prior file exceeds 10 MiB (memory guard)', async () => {
      // Pre-populate a file slightly larger than the 10 MiB threshold to
      // ensure the size guard fires BEFORE readFile would otherwise pull
      // the entire content into memory for diff computation.
      const filePath = join(tmpDir, 'oversize.txt');
      const MAX = 10 * 1024 * 1024;
      // Sparse write: a single byte at MAX+1 produces a file of size MAX+2
      // without materializing the whole buffer in JS.
      const { openSync, writeSync, closeSync } = await import('fs');
      const fd = openSync(filePath, 'w');
      try {
        // Write one byte at the very start and one byte past the threshold
        // so the file's stat size > MAX without allocating MAX bytes here.
        writeSync(fd, Buffer.from([0x61]), 0, 1, 0);
        writeSync(fd, Buffer.from([0x62]), 0, 1, MAX + 1);
      } finally {
        closeSync(fd);
      }

      const result = await writeFileHandler(
        { file_path: filePath, content: 'replacement' },
        AbortSignal.timeout(5000),
      );

      expect(result.isError).not.toBe(true);
      // Diff must be omitted — the pre-read was skipped, so priorContent
      // stayed null and the diff was never computed.
      expect((result as any).render).toBeUndefined();
      // Write still succeeded.
      expect(readFileSync(filePath, 'utf-8')).toBe('replacement');
    });

    it('P1: still computes diff for files at or below the 10 MiB threshold', async () => {
      // 1 MiB of repeated text is comfortably below the guard and exercises
      // the standard pre-read + diff path.
      const filePath = join(tmpDir, 'small.txt');
      const original = 'line-of-text\n'.repeat(80_000); // ~1 MB
      writeFileSync(filePath, original);

      const result = await writeFileHandler(
        { file_path: filePath, content: original + 'appended\n' },
        AbortSignal.timeout(5000),
      );

      expect(result.isError).not.toBe(true);
      // Diff payload must be present (under the threshold).
      expect((result as any).render?.diff).toBeDefined();
      expect((result as any).render.diff.addedLines).toBeGreaterThan(0);
    });

    it('F14: suppresses diff when readFile throws a non-ENOENT error (e.g. EACCES)', async () => {
      // Create a file then make it write-only (no read bit).
      // readFile will throw EACCES; the handler must still write successfully
      // and must NOT emit a render diff payload (priorContent stays null).
      const filePath = join(tmpDir, 'eacces-test.txt');
      // Pre-populate so the file exists and the write-only chmod is meaningful.
      const { writeFileSync } = await import('fs');
      writeFileSync(filePath, 'existing content');
      chmodSync(filePath, 0o200); // owner write-only — read denied

      try {
        const result = await writeFileHandler(
          { file_path: filePath, content: 'new content' },
          AbortSignal.timeout(5000),
        );
        expect(result.isError).not.toBe(true);
        expect((result as any).render).toBeUndefined();
      } finally {
        // Restore so afterEach cleanup can delete the temp dir.
        chmodSync(filePath, 0o644);
      }
    });
  });
});
