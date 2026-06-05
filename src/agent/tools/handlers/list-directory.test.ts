import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listDirectoryHandler } from './list-directory.js';
import type { ToolHandlerContext } from '../types.js';

describe('listDirectoryHandler', () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'list-directory-test-'));
  });

  afterEach(async () => {
    // Clean up temporary files
    try {
      await fs.rm(tmpDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('lists files and directories correctly', async () => {
    // Create some test files and directories
    await fs.mkdir(join(tmpDir, 'dir1'));
    await fs.mkdir(join(tmpDir, 'dir2'));
    await fs.writeFile(join(tmpDir, 'file1.txt'), 'content');
    await fs.writeFile(join(tmpDir, 'file2.ts'), 'code');

    const result = await listDirectoryHandler({ path: tmpDir }, new AbortController().signal);

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('dir1/');
    expect(result.content).toContain('dir2/');
    expect(result.content).toContain('file1.txt');
    expect(result.content).toContain('file2.ts');
  });

  it('suffixes directories with /', async () => {
    await fs.mkdir(join(tmpDir, 'mydir'));
    await fs.writeFile(join(tmpDir, 'myfile.txt'), 'content');

    const result = await listDirectoryHandler({ path: tmpDir }, new AbortController().signal);

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('mydir/');
    expect(result.content).not.toContain('mydir\n');
    expect(result.content).toContain('myfile.txt');
  });

  it('sorts entries alphabetically with directories first', async () => {
    // Create files/dirs in non-alphabetical order
    await fs.writeFile(join(tmpDir, 'zebra.txt'), 'content');
    await fs.mkdir(join(tmpDir, 'alpha_dir'));
    await fs.writeFile(join(tmpDir, 'beta.txt'), 'content');
    await fs.mkdir(join(tmpDir, 'zulu_dir'));

    const result = await listDirectoryHandler({ path: tmpDir }, new AbortController().signal);

    expect(result.isError).not.toBe(true);
    const lines = result.content.split('\n');

    // Directories should come first
    expect(lines[0]).toBe('alpha_dir/');
    expect(lines[1]).toBe('zulu_dir/');
    // Then files
    expect(lines[2]).toBe('beta.txt');
    expect(lines[3]).toBe('zebra.txt');
  });

  it('returns error for missing directory', async () => {
    const result = await listDirectoryHandler(
      { path: join(tmpDir, 'nonexistent') },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Directory not found');
  });

  it('returns error for path that is not a directory', async () => {
    const filePath = join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'content');

    const result = await listDirectoryHandler({ path: filePath }, new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Not a directory');
  });

  it('returns "(empty directory)" for empty directory', async () => {
    const emptyDir = join(tmpDir, 'empty');
    await fs.mkdir(emptyDir);

    const result = await listDirectoryHandler({ path: emptyDir }, new AbortController().signal);

    expect(result.isError).not.toBe(true);
    expect(result.content).toBe('(empty directory)');
  });

  it('throws for missing path field', async () => {
    await expect(
      listDirectoryHandler({}, new AbortController().signal),
    ).rejects.toThrow('path must be a string');
  });

  it('throws for non-string path', async () => {
    await expect(
      listDirectoryHandler({ path: 123 }, new AbortController().signal),
    ).rejects.toThrow('path must be a string');
  });

  it('throws for non-object input', async () => {
    await expect(
      listDirectoryHandler('not an object', new AbortController().signal),
    ).rejects.toThrow('expected an object');
  });

  it('handles many entries and sorts correctly', async () => {
    // Create 10 directories and 10 files in random order
    const dirNames = ['z', 'a', 'm', 'b', 'y', 'c', 'x', 'd', 'w', 'e'];
    const fileNames = ['z.txt', 'a.txt', 'm.txt', 'b.txt', 'y.txt', 'c.txt', 'x.txt', 'd.txt', 'w.txt', 'e.txt'];

    for (const dir of dirNames) {
      await fs.mkdir(join(tmpDir, dir));
    }
    for (const file of fileNames) {
      await fs.writeFile(join(tmpDir, file), 'content');
    }

    const result = await listDirectoryHandler({ path: tmpDir }, new AbortController().signal);

    expect(result.isError).not.toBe(true);
    const lines = result.content.split('\n');

    // All 10 directories should come first, sorted
    const expectedDirs = dirNames.sort().map((d) => `${d}/`);
    for (let i = 0; i < expectedDirs.length; i++) {
      expect(lines[i]).toBe(expectedDirs[i]);
    }

    // Then all 10 files, sorted
    const expectedFiles = fileNames.sort();
    for (let i = 0; i < expectedFiles.length; i++) {
      expect(lines[expectedDirs.length + i]).toBe(expectedFiles[i]);
    }
  });

  it('handles special characters in filenames', async () => {
    await fs.mkdir(join(tmpDir, 'dir-with-dash'));
    await fs.mkdir(join(tmpDir, 'dir_with_underscore'));
    await fs.writeFile(join(tmpDir, 'file.test.ts'), 'content');
    await fs.writeFile(join(tmpDir, 'file-with-dash.txt'), 'content');

    const result = await listDirectoryHandler({ path: tmpDir }, new AbortController().signal);

    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('dir-with-dash/');
    expect(result.content).toContain('dir_with_underscore/');
    expect(result.content).toContain('file.test.ts');
    expect(result.content).toContain('file-with-dash.txt');
  });

  it('returns error for permission denied', async () => {
    // Skip this test on Windows (chmod doesn't work the same way)
    if (process.platform === 'win32') {
      return;
    }

    const restrictedDir = join(tmpDir, 'restricted');
    await fs.mkdir(restrictedDir);

    // Remove read permissions
    await fs.chmod(restrictedDir, 0o000);

    try {
      const result = await listDirectoryHandler(
        { path: restrictedDir },
        new AbortController().signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Permission denied');
    } finally {
      // Restore permissions for cleanup
      await fs.chmod(restrictedDir, 0o755);
    }
  });

  it('handles single entry directory', async () => {
    await fs.writeFile(join(tmpDir, 'single.txt'), 'content');

    const result = await listDirectoryHandler({ path: tmpDir }, new AbortController().signal);

    expect(result.isError).not.toBe(true);
    expect(result.content).toBe('single.txt');
  });

  it('does not include . and .. entries', async () => {
    await fs.writeFile(join(tmpDir, 'file.txt'), 'content');

    const result = await listDirectoryHandler({ path: tmpDir }, new AbortController().signal);

    expect(result.isError).not.toBe(true);
    const lines = result.content.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines).not.toContain('.');
    expect(lines).not.toContain('..');
  });
});

describe('listDirectoryHandler cwd containment', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'list-dir-contain-'));
    await fs.mkdir(join(tempDir, 'subdir'), { recursive: true });
    await fs.writeFile(join(tempDir, 'subdir', 'file.txt'), 'content');
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
    const result = await listDirectoryHandler(
      { path: '/etc' },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed/);
  });

  it('resolves relative path against context.cwd', async () => {
    const context: ToolHandlerContext = { cwd: tempDir };
    const result = await listDirectoryHandler(
      { path: 'subdir' },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('file.txt');
  });

  it('allows absolute path within context.cwd', async () => {
    const context: ToolHandlerContext = { cwd: tempDir };
    const result = await listDirectoryHandler(
      { path: join(tempDir, 'subdir') },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('file.txt');
  });

  it('falls back to process.cwd() resolution when no cwd in context', async () => {
    const context: ToolHandlerContext = {};
    const result = await listDirectoryHandler(
      { path: join(tempDir, 'subdir') },
      new AbortController().signal,
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('file.txt');
  });
});
