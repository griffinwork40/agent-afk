import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileHandler } from './read-file.js';
import type { ToolHandlerContext } from '../types.js';

describe('readFileHandler', () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'read-file-test-'));
  });

  afterEach(async () => {
    // Clean up temporary files
    try {
      await fs.rm(tmpDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('reads a small file and returns content with line numbers', async () => {
    const testFile = join(tmpDir, 'test.txt');
    const content = 'line 1\nline 2\nline 3\n';
    await fs.writeFile(testFile, content);

    const result = await readFileHandler(
      { file_path: testFile },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('1\tline 1');
    expect(result.content).toContain('2\tline 2');
    expect(result.content).toContain('3\tline 3');
  });

  it('right-aligns line numbers based on the highest line number', async () => {
    const testFile = join(tmpDir, 'multiline.txt');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(testFile, lines.join('\n'));

    const result = await readFileHandler(
      { file_path: testFile, offset: 1, limit: 5 },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    // Line numbers should be 3-digit aligned (width = 100)
    expect(result.content).toContain('  1\tline 1');
    expect(result.content).toContain('  2\tline 2');
  });

  it('applies offset to start reading from specified line', async () => {
    const testFile = join(tmpDir, 'offset.txt');
    const content = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
    await fs.writeFile(testFile, content);

    const result = await readFileHandler(
      { file_path: testFile, offset: 3, limit: 2 },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('3\tline 3');
    expect(result.content).toContain('4\tline 4');
    expect(result.content).not.toContain('line 1');
    expect(result.content).not.toContain('line 5');
  });

  it('respects limit to cap number of lines returned', async () => {
    const testFile = join(tmpDir, 'limit.txt');
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(testFile, lines.join('\n'));

    const result = await readFileHandler(
      { file_path: testFile, offset: 1, limit: 3 },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('1\tline 1');
    expect(result.content).toContain('3\tline 3');
    expect(result.content).not.toContain('4\tline 4');
    expect(result.content).toContain(
      '... (showing lines 1-3 of 10 — pass offset=4 to continue)',
    );
  });

  it('returns error for missing file', async () => {
    const result = await readFileHandler(
      { file_path: join(tmpDir, 'nonexistent.txt') },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('File not found');
  });

  it('detects and rejects binary files', async () => {
    const testFile = join(tmpDir, 'binary.bin');
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    await fs.writeFile(testFile, binaryContent);

    const result = await readFileHandler(
      { file_path: testFile },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('File appears to be binary');
  });

  it('returns error for invalid input without file_path', async () => {
    const result = await readFileHandler({}, new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('file_path must be a string');
  });

  it('returns error for non-string file_path', async () => {
    const result = await readFileHandler(
      { file_path: 123 },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('file_path must be a string');
  });

  it('returns error for invalid offset', async () => {
    const result = await readFileHandler(
      { file_path: '/some/path', offset: 0 },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('offset must be a positive number');
  });

  it('returns error for invalid limit', async () => {
    const result = await readFileHandler(
      { file_path: '/some/path', limit: -5 },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('limit must be a positive number');
  });

  it('handles files with empty lines', async () => {
    const testFile = join(tmpDir, 'empty-lines.txt');
    const content = 'line 1\n\nline 3\n\n';
    await fs.writeFile(testFile, content);

    const result = await readFileHandler(
      { file_path: testFile },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('1\tline 1');
    expect(result.content).toContain('2\t');
    expect(result.content).toContain('3\tline 3');
  });

  it('handles empty file without error', async () => {
    const testFile = join(tmpDir, 'empty.txt');
    await fs.writeFile(testFile, '');

    const result = await readFileHandler(
      { file_path: testFile },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toBe('');
  });

  it('returns informative footer when offset is past end of file', async () => {
    const testFile = join(tmpDir, 'short.txt');
    // Trailing newline yields a phantom empty line → split length = 3.
    const content = 'line 1\nline 2\n';
    await fs.writeFile(testFile, content);

    const result = await readFileHandler(
      { file_path: testFile, offset: 100 },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toBe(
      '... (offset 100 is past end of file — file has 3 lines)',
    );
  });

  it('uses default offset of 1 when not specified', async () => {
    const testFile = join(tmpDir, 'default-offset.txt');
    const content = 'line 1\nline 2\nline 3\n';
    await fs.writeFile(testFile, content);

    const result = await readFileHandler(
      { file_path: testFile, limit: 2 },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('1\tline 1');
    expect(result.content).toContain('2\tline 2');
  });

  it('uses default limit of 2000 when not specified', async () => {
    const testFile = join(tmpDir, 'default-limit.txt');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(testFile, lines.join('\n'));

    const result = await readFileHandler(
      { file_path: testFile },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    const resultLines = result.content.split('\n').filter((l) => l.length > 0);
    expect(resultLines.length).toBe(100);
  });

  it('handles files with various line endings', async () => {
    const testFile = join(tmpDir, 'line-endings.txt');
    // Write with only \n separators (standard)
    const content = 'line 1\nline 2\nline 3\n';
    await fs.writeFile(testFile, content);

    const result = await readFileHandler(
      { file_path: testFile },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('1\tline 1');
    expect(result.content).toContain('2\tline 2');
    expect(result.content).toContain('3\tline 3');
  });

  it('returns error for non-object input', async () => {
    const result = await readFileHandler('not an object', new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input: expected an object');
  });

  it('handles large files with limit correctly', async () => {
    const testFile = join(tmpDir, 'large.txt');
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(testFile, lines.join('\n'));

    const result = await readFileHandler(
      { file_path: testFile, offset: 1, limit: 100 },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    const resultLines = result.content.split('\n').filter((l) => l.length > 0);
    // 100 content lines + 1 footer line.
    expect(resultLines).toHaveLength(101);
    expect(result.content).toContain(
      '... (showing lines 1-100 of 5000 — pass offset=101 to continue)',
    );
  });

  it('appends footer with continuation hint when limit truncates the file', async () => {
    const testFile = join(tmpDir, 'truncate.txt');
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(testFile, lines.join('\n'));

    const result = await readFileHandler(
      { file_path: testFile, limit: 10 },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain(' 1\tline 1');
    expect(result.content).toContain('10\tline 10');
    expect(result.content).not.toContain('line 11');
    expect(result.content).toContain(
      '... (showing lines 1-10 of 50 — pass offset=11 to continue)',
    );
  });

  it('appends footer without continuation when read reaches end of file from middle', async () => {
    const testFile = join(tmpDir, 'mid-to-end.txt');
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(testFile, lines.join('\n'));

    const result = await readFileHandler(
      { file_path: testFile, offset: 6, limit: 100 },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain(' 6\tline 6');
    expect(result.content).toContain('10\tline 10');
    expect(result.content).toContain('... (showing lines 6-10 of 10)');
    expect(result.content).not.toContain('pass offset=');
  });

  it('appends footer with continuation when reading from middle with more after', async () => {
    const testFile = join(tmpDir, 'mid-with-more.txt');
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(testFile, lines.join('\n'));

    const result = await readFileHandler(
      { file_path: testFile, offset: 10, limit: 5 },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('10\tline 10');
    expect(result.content).toContain('14\tline 14');
    expect(result.content).not.toContain('line 15');
    expect(result.content).toContain(
      '... (showing lines 10-14 of 50 — pass offset=15 to continue)',
    );
  });

  it('does not append footer when the entire file is returned', async () => {
    const testFile = join(tmpDir, 'full.txt');
    // No trailing newline → exactly 3 lines, fits within default limit.
    const content = 'line 1\nline 2\nline 3';
    await fs.writeFile(testFile, content);

    const result = await readFileHandler(
      { file_path: testFile },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('1\tline 1');
    expect(result.content).toContain('3\tline 3');
    expect(result.content).not.toContain('... (showing');
    expect(result.content).not.toContain('past end of file');
  });
});

describe('readFileHandler cwd containment', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'read-file-contain-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('rejects absolute path outside context.cwd', async () => {
    const context: ToolHandlerContext = { cwd: tempDir };
    const result = await readFileHandler(
      { file_path: '/etc/passwd' },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed/);
  });

  it('resolves relative path against context.cwd', async () => {
    const filePath = join(tempDir, 'relative.txt');
    await fs.writeFile(filePath, 'hello\nworld\n');
    const context: ToolHandlerContext = { cwd: tempDir };

    const result = await readFileHandler(
      { file_path: 'relative.txt' },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello');
  });

  it('allows absolute path within context.cwd', async () => {
    const filePath = join(tempDir, 'inside.txt');
    await fs.writeFile(filePath, 'inside content\n');
    const context: ToolHandlerContext = { cwd: tempDir };

    const result = await readFileHandler(
      { file_path: filePath },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('inside content');
  });

  it('falls back to process.cwd() resolution when no cwd in context', async () => {
    const filePath = join(tempDir, 'nocontext.txt');
    await fs.writeFile(filePath, 'no context data\n');
    const context: ToolHandlerContext = {};

    const result = await readFileHandler(
      { file_path: filePath },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('no context data');
  });
});
