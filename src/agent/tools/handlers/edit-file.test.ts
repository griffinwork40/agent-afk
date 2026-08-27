/**
 * Tests for the edit_file tool handler.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { rm } from 'fs/promises';
import { utimesSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { editFileHandler } from './edit-file.js';

// Invariant: this scratch dir must live OUTSIDE the repo working tree. Rooted
// at `process.cwd()` it landed as `.test-temp-edit-file/` in whatever checkout
// ran the suite, and any run that did not reach `afterEach` (Ctrl+C, OOM, a
// killed worker) left it behind. Being gitignored, `git status` reports it
// clean while the worktree ignored-file probe classifies the unrecognised name
// as non-rebuildable — so every worktree that had ever run the tests was
// preserved on session exit, forever, citing local state the user never
// created. Under os.tmpdir() the same abandoned run leaks nothing into a
// checkout. The random suffix keeps two concurrent suite runs from sharing it.
const tempDir = path.join(os.tmpdir(), `afk-edit-file-test-${process.pid}-${randomBytes(4).toString('hex')}`);

async function createTempFile(filename: string, content: string): Promise<string> {
  await mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function readTempFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8');
}

// File-scoped, not describe-scoped: the second describe below mkdirs tempDir
// inside its cases and registers no afterEach, so the per-test cleanup in the
// first block is not the last writer and the dir outlives the run. That is
// what left one behind on every suite invocation.
afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('editFileHandler', () => {
  beforeEach(async () => {
    // Ensure temp dir exists
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('performs a single string replacement successfully', async () => {
    const filePath = await createTempFile('test1.txt', 'hello world\nfoo bar\n');
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: filePath,
        old_string: 'foo bar',
        new_string: 'baz qux',
      },
      signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Replaced 1 occurrence');
    expect(result.content).toContain(filePath);

    const modified = await readTempFile(filePath);
    expect(modified).toBe('hello world\nbaz qux\n');
  });

  it('returns error when old_string is not found', async () => {
    const filePath = await createTempFile('test2.txt', 'hello world\n');
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: filePath,
        old_string: 'nonexistent',
        new_string: 'replacement',
      },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('old_string not found');
  });

  it('returns error when multiple matches exist without replace_all', async () => {
    const filePath = await createTempFile('test3.txt', 'foo bar foo baz foo\n');
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: filePath,
        old_string: 'foo',
        new_string: 'replaced',
      },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('matches 3 locations');
    expect(result.content).toContain('Use replace_all');

    // File should be unchanged
    const content = await readTempFile(filePath);
    expect(content).toBe('foo bar foo baz foo\n');
  });

  it('replaces all occurrences when replace_all is true', async () => {
    const filePath = await createTempFile('test4.txt', 'foo bar foo baz foo\n');
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: filePath,
        old_string: 'foo',
        new_string: 'replaced',
        replace_all: true,
      },
      signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Replaced 3 occurrences');

    const modified = await readTempFile(filePath);
    expect(modified).toBe('replaced bar replaced baz replaced\n');
  });

  it('replace_all with 3 occurrences produces correct diff counts', async () => {
    const filePath = await createTempFile(
      'replace-all-3.txt',
      'foo line\nother line\nfoo line\nanother line\nfoo line\n',
    );
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: filePath,
        old_string: 'foo line',
        new_string: 'bar line',
        replace_all: true,
      },
      signal,
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('3');
    // Verify diff payload reflects 3 additions and 3 deletions
    const render = (result as any).render;
    expect(render).toBeDefined();
    expect(render.diff).toBeDefined();
    expect(render.diff.addedLines).toBe(3);
    expect(render.diff.removedLines).toBe(3);
  });

  it('handles empty new_string (deletion)', async () => {
    const filePath = await createTempFile(
      'test5.txt',
      'line one\nline two\nline three\n',
    );
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: filePath,
        old_string: 'line two\n',
        new_string: '',
      },
      signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Replaced 1 occurrence');

    const modified = await readTempFile(filePath);
    expect(modified).toBe('line one\nline three\n');
  });

  it('preserves file content around replacement', async () => {
    const originalContent = `function foo() {
  console.log('hello');
  // TODO: fix this
}

function bar() {
  return 42;
}`;

    const filePath = await createTempFile('test6.txt', originalContent);
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: filePath,
        old_string: "console.log('hello');",
        new_string: "console.log('world');",
      },
      signal,
    );

    expect(result.isError).toBeUndefined();

    const modified = await readTempFile(filePath);
    const expected = `function foo() {
  console.log('world');
  // TODO: fix this
}

function bar() {
  return 42;
}`;
    expect(modified).toBe(expected);
  });

  it('returns error for file not found', async () => {
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: '/nonexistent/path/file.txt',
        old_string: 'old',
        new_string: 'new',
      },
      signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Error:');
  });

  it('throws when input is missing file_path', async () => {
    const signal = new AbortController().signal;

    await expect(async () => {
      await editFileHandler(
        {
          old_string: 'old',
          new_string: 'new',
        },
        signal,
      );
    }).rejects.toThrow('file_path');
  });

  it('throws when input is missing old_string', async () => {
    const signal = new AbortController().signal;

    await expect(async () => {
      await editFileHandler(
        {
          file_path: '/tmp/test.txt',
          new_string: 'new',
        },
        signal,
      );
    }).rejects.toThrow('old_string');
  });

  it('throws when input is missing new_string', async () => {
    const signal = new AbortController().signal;

    await expect(async () => {
      await editFileHandler(
        {
          file_path: '/tmp/test.txt',
          old_string: 'old',
        },
        signal,
      );
    }).rejects.toThrow('new_string');
  });

  it('throws when replace_all is not a boolean', async () => {
    const signal = new AbortController().signal;

    await expect(async () => {
      await editFileHandler(
        {
          file_path: '/tmp/test.txt',
          old_string: 'old',
          new_string: 'new',
          replace_all: 'true',
        },
        signal,
      );
    }).rejects.toThrow('replace_all must be a boolean');
  });

  it('returns error when aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const filePath = await createTempFile('test7.txt', 'hello world\n');

    const result = await editFileHandler(
      {
        file_path: filePath,
        old_string: 'hello',
        new_string: 'goodbye',
      },
      controller.signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Aborted');

    // File should be unchanged
    const content = await readTempFile(filePath);
    expect(content).toBe('hello world\n');
  });
});

// ---------------------------------------------------------------------------
// cwd containment tests
// ---------------------------------------------------------------------------

describe('editFileHandler cwd containment', () => {
  it('rejects absolute path outside context.cwd', async () => {
    const signal = new AbortController().signal;
    const result = await editFileHandler(
      {
        file_path: '/etc/passwd',
        old_string: 'root',
        new_string: 'root',
      },
      signal,
      { cwd: tempDir },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed/);
  });

  it('resolves relative path against context.cwd', async () => {
    await mkdir(tempDir, { recursive: true });
    const absPath = path.join(tempDir, 'relative.txt');
    await writeFile(absPath, 'foo bar baz', 'utf-8');
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: 'relative.txt',
        old_string: 'bar',
        new_string: 'qux',
      },
      signal,
      { cwd: tempDir },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Replaced 1 occurrence');
  });

  it('allows absolute path within context.cwd', async () => {
    await mkdir(tempDir, { recursive: true });
    const absPath = path.join(tempDir, 'inside.txt');
    await writeFile(absPath, 'hello world', 'utf-8');
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: absPath,
        old_string: 'hello',
        new_string: 'goodbye',
      },
      signal,
      { cwd: tempDir },
    );
    expect(result.isError).toBeFalsy();
  });

  it('falls back to process.cwd() resolution when no cwd in context', async () => {
    // Using an absolute path without cwd context should work normally
    await mkdir(tempDir, { recursive: true });
    const absPath = path.join(tempDir, 'nocontext.txt');
    await writeFile(absPath, 'alpha beta', 'utf-8');
    const signal = new AbortController().signal;

    const result = await editFileHandler(
      {
        file_path: absPath,
        old_string: 'alpha',
        new_string: 'gamma',
      },
      signal,
      {},
    );
    expect(result.isError).toBeFalsy();
  });

  describe('render-only diff payload', () => {
    it('populates render.diff with the line-level change', async () => {
      const filePath = await createTempFile('diff1.txt', 'line one\nline two\nline three\n');
      const signal = new AbortController().signal;

      const result = await editFileHandler(
        {
          file_path: filePath,
          old_string: 'line two',
          new_string: 'LINE TWO',
        },
        signal,
      );

      expect(result.isError).toBeUndefined();
      expect(result.render).toBeDefined();
      expect(result.render?.diff).toBeDefined();
      expect(result.render!.diff!.addedLines).toBe(1);
      expect(result.render!.diff!.removedLines).toBe(1);
      expect(result.render!.diff!.hunks).toHaveLength(1);
    });

    it('does NOT leak the diff body into the model-facing content', async () => {
      // Structural invariant: result.content (which becomes the body of the
      // model's tool_result block) must contain only the one-line summary —
      // never the diff context. The diff travels exclusively on result.render.
      const filePath = await createTempFile('diff2.txt', 'before content\n');
      const signal = new AbortController().signal;

      const result = await editFileHandler(
        {
          file_path: filePath,
          old_string: 'before content',
          new_string: 'after content',
        },
        signal,
      );

      expect(result.content).toBe(`Replaced 1 occurrence in ${filePath}`);
      // No multi-line snippet, no `...` framing, no diff-prefix lines.
      // (Hyphens elsewhere in the path are fine — we target the diff
      // line-prefix specifically.)
      expect(result.content).not.toContain('\n');
      expect(result.content).not.toContain('...');
      expect(result.content).not.toMatch(/^[+-] /m);
    });

    it('omits render.diff when old_string === new_string (no-op edit)', async () => {
      // No-op edits should not emit an empty diff block in the renderer.
      // computeLineDiff returns null when before === after; the handler
      // must propagate that by omitting `render` entirely. Single-occurrence
      // case (replace_all defaults to false; multiple matches would error).
      const filePath = await createTempFile('noop.txt', 'unique line\nother text\n');
      const signal = new AbortController().signal;

      const result = await editFileHandler(
        {
          file_path: filePath,
          old_string: 'unique line',
          new_string: 'unique line',
        },
        signal,
      );

      expect(result.isError).toBeUndefined();
      expect(result.render).toBeUndefined();
    });
  });

  describe('TOCTOU mtime guard', () => {
    it('rejects the write when file mtime changes between read and write', async () => {
      // Invariant: the guard compares mtimeMs from stat-before (pre-read) and
      // stat-after (pre-write). To trigger it deterministically we inject a
      // concurrent mtime bump between the handler's two I/O boundaries using
      // setImmediate + utimesSync. setImmediate fires after the current I/O
      // callback drains, which on libuv lands between the handler's readFile
      // await and its second stat await — the window we want to test.
      // utimesSync is synchronous so the bump completes before Node yields
      // to the I/O queue that processes the second stat. This avoids the
      // "Cannot redefine property" error that vi.spyOn hits on ESM named exports.
      const filePath = await createTempFile('toctou.txt', 'original content\n');

      // Advance mtime to a value 10 seconds in the past so stat-before
      // captures a known baseline; then schedule the bump to a future value.
      const base = new Date(Date.now() - 10_000);
      utimesSync(filePath, base, base);

      // Bump fires after readFile completes, before the second stat runs.
      const future = new Date(Date.now() + 10_000);
      setImmediate(() => {
        utimesSync(filePath, future, future);
      });

      const signal = new AbortController().signal;
      const result = await editFileHandler(
        {
          file_path: filePath,
          old_string: 'original content',
          new_string: 'replacement content',
        },
        signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/modified by another process/);
      expect(result.content).toMatch(/mtime changed/);
    });

    it('succeeds when mtime is stable between read and write', async () => {
      // Guard must be transparent when no concurrent modification occurs.
      const filePath = await createTempFile('toctou-ok.txt', 'stable content\n');
      const signal = new AbortController().signal;

      const result = await editFileHandler(
        {
          file_path: filePath,
          old_string: 'stable content',
          new_string: 'updated content',
        },
        signal,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe(`Replaced 1 occurrence in ${filePath}`);
    });
  });
});
