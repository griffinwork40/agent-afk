/**
 * Factory-cwd fallback tier for the four bare FS handlers (issue #434).
 *
 * read_file / write_file / edit_file / list_directory, when built via their
 * `create*Handler(cwd)` factory, must anchor a RELATIVE path to that session
 * cwd — and confine it there — even when invoked WITHOUT a dispatcher context.
 * This is the safety net glob/grep already had. The last case locks the
 * load-bearing "undefined base = unconfined top-level session" invariant so a
 * future change cannot silently confine top-level sessions.
 *
 * @module agent/tools/handlers/fs-handler-factory-cwd.test
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadFileHandler, readFileHandler } from './read-file.js';
import { createWriteFileHandler } from './write-file.js';
import { createEditFileHandler } from './edit-file.js';
import { createListDirectoryHandler } from './list-directory.js';

describe('FS handler factory cwd fallback (issue #434)', () => {
  let tmpDir: string;
  const sig = () => new AbortController().signal;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'fs-factory-cwd-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('createReadFileHandler(cwd) resolves a relative path against cwd (no context)', async () => {
    await fs.writeFile(join(tmpDir, 'rel.txt'), 'hello-434\n');
    const result = await createReadFileHandler(tmpDir)({ file_path: 'rel.txt' }, sig());
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('hello-434');
  });

  it('createWriteFileHandler(cwd) writes a relative path under cwd (no context)', async () => {
    const result = await createWriteFileHandler(tmpDir)(
      { file_path: 'out/new.txt', content: 'written-434' },
      sig(),
    );
    expect(result.isError).not.toBe(true);
    const written = await fs.readFile(join(tmpDir, 'out/new.txt'), 'utf-8');
    expect(written).toBe('written-434');
  });

  it('createEditFileHandler(cwd) edits a relative path under cwd (no context)', async () => {
    await fs.writeFile(join(tmpDir, 'edit.txt'), 'before\n');
    const result = await createEditFileHandler(tmpDir)(
      { file_path: 'edit.txt', old_string: 'before', new_string: 'after' },
      sig(),
    );
    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(join(tmpDir, 'edit.txt'), 'utf-8')).toBe('after\n');
  });

  it('createListDirectoryHandler(cwd) lists a relative path under cwd (no context)', async () => {
    await fs.writeFile(join(tmpDir, 'a.txt'), 'x');
    await fs.mkdir(join(tmpDir, 'sub'));
    const result = await createListDirectoryHandler(tmpDir)({ path: '.' }, sig());
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('a.txt');
    expect(result.content).toContain('sub/');
  });

  it('confines a relative escape attempt to the factory cwd (no context)', async () => {
    // With a factory cwd but no dispatcher context, containment is now enforced
    // against [cwd] — an upward escape is rejected before any fs access.
    const escape = '../'.repeat(20) + 'etc/passwd';
    const result = await createReadFileHandler(tmpDir)({ file_path: escape }, sig());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the allowed/);
  });

  it('bare handler with no factory cwd and no context stays UNCONFINED (top-level invariant)', async () => {
    // resolveBase is undefined here (no factory cwd, no context) → containment
    // is intentionally disabled, so an absolute path outside any root is admitted.
    // Regression guard: do NOT "fix" #434 by confining this path.
    await fs.writeFile(join(tmpDir, 'abs.txt'), 'abs-ok\n');
    const result = await readFileHandler({ file_path: join(tmpDir, 'abs.txt') }, sig());
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('abs-ok');
  });
});
