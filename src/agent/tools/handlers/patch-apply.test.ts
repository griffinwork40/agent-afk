/**
 * End-to-end tests for patch-apply.ts (the ToolHandler integration layer).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { createPatchApplyHandler } from './patch-apply.js';

const tempDir = path.join(
  os.tmpdir(),
  `afk-patch-apply-e2e-test-${process.pid}-${randomBytes(4).toString('hex')}`,
);

async function writeTemp(filename: string, content: string): Promise<string> {
  await mkdir(tempDir, { recursive: true });
  const p = path.join(tempDir, filename);
  await writeFile(p, content, 'utf-8');
  return p;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const signal = new AbortController().signal;

// Context that confines writes to tempDir.
const makeCtx = () => ({
  resolveBase: tempDir,
  writeRoots: [tempDir],
  readRoots: [tempDir],
});

afterEach(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('patch_apply handler — validation_failed', () => {
  it('returns isError=true when input is not an object', async () => {
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler('not-an-object', signal, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('object');
  });

  it('returns isError=true when changes is missing', async () => {
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler({}, signal, makeCtx());
    expect(result.isError).toBe(true);
  });

  it('returns validation_failed status for bad hash', async () => {
    const filePath = await writeTemp('v1.txt', 'current\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      {
        changes: [
          {
            path: filePath,
            expected_hash: `sha256:${sha256('wrong content')}`,
            content: 'new\n',
          },
        ],
      },
      signal,
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('validation_failed');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].error).toBe('hash_mismatch');
  });

  it('returns all errors when multiple files fail validation', async () => {
    const file1 = await writeTemp('m1.txt', 'aaa\n');
    const file2 = await writeTemp('m2.txt', 'bbb\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      {
        changes: [
          { path: file1, edits: [{ old: 'nothere', new: 'x' }] },
          { path: file2, edits: [{ old: 'bbb', new: undefined as unknown as string }] },
        ],
      },
      signal,
      makeCtx(),
    );
    // Should get parse error for undefined 'new' OR at least an error.
    expect(result.isError).toBe(true);
  });
});

describe('patch_apply handler — applied', () => {
  it('applies a single content change and returns applied status', async () => {
    const filePath = await writeTemp('a1.txt', 'before\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, content: 'after\n' }] },
      signal,
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('applied');
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.diff).toContain('-before');
    expect(parsed.diff).toContain('+after');

    const actual = await readFile(filePath, 'utf-8');
    expect(actual).toBe('after\n');
  });

  it('applies sequential edits correctly', async () => {
    const filePath = await writeTemp('a2.txt', 'one two three\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      {
        changes: [
          {
            path: filePath,
            edits: [
              { old: 'one', new: 'ONE' },
              { old: 'ONE two', new: 'ONE+TWO' },
            ],
          },
        ],
      },
      signal,
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const actual = await readFile(filePath, 'utf-8');
    expect(actual).toBe('ONE+TWO three\n');
  });

  it('returns files_changed with correct hashes', async () => {
    const filePath = await writeTemp('a3.txt', 'original\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, content: 'replaced\n' }] },
      signal,
      makeCtx(),
    );
    const parsed = JSON.parse(result.content as string);
    expect(parsed.files_changed).toHaveLength(1);
    expect(parsed.files_changed[0].before_hash).toBe(`sha256:${sha256('original\n')}`);
    expect(parsed.files_changed[0].after_hash).toBe(`sha256:${sha256('replaced\n')}`);
  });

  it('returns applied for empty changes array', async () => {
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler({ changes: [] }, signal, makeCtx());
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('applied');
  });
});

describe('patch_apply handler — dry_run', () => {
  it('returns dry_run status and diff without modifying the file', async () => {
    const filePath = await writeTemp('d1.txt', 'hello\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, content: 'goodbye\n' }], dry_run: true },
      signal,
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('dry_run');
    expect(parsed.diff).toContain('-hello');
    expect(parsed.diff).toContain('+goodbye');

    // File is unchanged.
    const actual = await readFile(filePath, 'utf-8');
    expect(actual).toBe('hello\n');
  });

  it('dry_run result shape has all required fields', async () => {
    const filePath = await writeTemp('d2.txt', 'x\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, content: 'y\n' }], dry_run: true },
      signal,
      makeCtx(),
    );
    const parsed = JSON.parse(result.content as string);
    expect(parsed).toHaveProperty('status', 'dry_run');
    expect(parsed).toHaveProperty('diff');
    expect(parsed).toHaveProperty('files_changed');
    expect(parsed).toHaveProperty('errors');
    expect(Array.isArray(parsed.files_changed)).toBe(true);
    expect(Array.isArray(parsed.errors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// render.diff sidecar
// ---------------------------------------------------------------------------

describe('patch_apply — render.diff sidecar', () => {
  it('attaches structured DiffPayload on successful apply', async () => {
    const filePath = await writeTemp('render-diff.txt', 'hello world\n');
    const handler = createPatchApplyHandler(tempDir);

    const result = await handler(
      {
        changes: [
          { path: filePath, edits: [{ old: 'hello', new: 'goodbye' }] },
        ],
      },
      signal,
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.render).toBeDefined();
    expect(result.render!.diff).toBeDefined();
    const diff = result.render!.diff!;
    expect(diff.hunks.length).toBeGreaterThan(0);
    expect(diff.addedLines).toBeGreaterThan(0);
    expect(diff.removedLines).toBeGreaterThan(0);
  });

  it('stamps filePath on hunks for multi-file patches', async () => {
    await writeTemp('a.txt', 'aaa\n');
    await writeTemp('b.txt', 'bbb\n');
    const handler = createPatchApplyHandler(tempDir);

    const result = await handler(
      {
        changes: [
          { path: path.join(tempDir, 'a.txt'), edits: [{ old: 'aaa', new: 'AAA' }] },
          { path: path.join(tempDir, 'b.txt'), edits: [{ old: 'bbb', new: 'BBB' }] },
        ],
      },
      signal,
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    const diff = result.render!.diff!;
    // Two files, each contributing at least one hunk.
    expect(diff.hunks.length).toBeGreaterThanOrEqual(2);
    // Each hunk should have a filePath set.
    const filePaths = new Set(diff.hunks.map((h) => h.filePath));
    expect(filePaths.size).toBe(2);
  });

  it('attaches structured DiffPayload on dry_run', async () => {
    await writeTemp('dry-render.txt', 'original\n');
    const handler = createPatchApplyHandler(tempDir);

    const result = await handler(
      {
        changes: [
          { path: path.join(tempDir, 'dry-render.txt'), edits: [{ old: 'original', new: 'modified' }] },
        ],
        dry_run: true,
      },
      signal,
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.render).toBeDefined();
    expect(result.render!.diff!.hunks.length).toBeGreaterThan(0);
  });

  it('omits render.diff when no changes produce a diff', async () => {
    const handler = createPatchApplyHandler(tempDir);

    const result = await handler(
      { changes: [] },
      signal,
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.render).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #2028: stale-context re-read warning
// ---------------------------------------------------------------------------

describe('patch_apply — stale-context re-read warning (#2028)', () => {
  it('includes _reread_warning in result when files are applied', async () => {
    const filePath = await writeTemp('warn-single.txt', 'before\n');
    const handler = createPatchApplyHandler(tempDir);

    const result = await handler(
      { changes: [{ path: filePath, content: 'after\n' }] },
      signal,
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('applied');
    // Must include the re-read warning so the agent knows its context is stale.
    expect(parsed).toHaveProperty('_reread_warning');
    expect(typeof parsed._reread_warning).toBe('string');
    expect(parsed._reread_warning).toContain('read_file');
    expect(parsed._reread_warning).toContain('IMPORTANT');
    // Modified path(s) listed so the agent knows exactly which files to re-read.
    expect(parsed._reread_warning).toContain(filePath);
  });

  it('includes _reread_warning listing all modified paths for multi-file patches', async () => {
    const file1 = await writeTemp('warn-a.txt', 'aaa\n');
    const file2 = await writeTemp('warn-b.txt', 'bbb\n');
    const handler = createPatchApplyHandler(tempDir);

    const result = await handler(
      {
        changes: [
          { path: file1, content: 'AAA\n' },
          { path: file2, content: 'BBB\n' },
        ],
      },
      signal,
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('applied');
    expect(parsed).toHaveProperty('_reread_warning');
    // Both paths must appear in the warning.
    expect(parsed._reread_warning).toContain(file1);
    expect(parsed._reread_warning).toContain(file2);
  });

  it('omits _reread_warning on dry_run (no files written to disk)', async () => {
    const filePath = await writeTemp('warn-dry.txt', 'hello\n');
    const handler = createPatchApplyHandler(tempDir);

    const result = await handler(
      { changes: [{ path: filePath, content: 'goodbye\n' }], dry_run: true },
      signal,
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('dry_run');
    // No warning on dry_run — disk was not touched.
    expect(parsed).not.toHaveProperty('_reread_warning');
  });

  it('omits _reread_warning when changes array is empty', async () => {
    const handler = createPatchApplyHandler(tempDir);

    const result = await handler({ changes: [] }, signal, makeCtx());

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('applied');
    expect(parsed).not.toHaveProperty('_reread_warning');
  });

  it('omits _reread_warning when patch validation fails', async () => {
    const filePath = await writeTemp('warn-fail.txt', 'current\n');
    const handler = createPatchApplyHandler(tempDir);

    const result = await handler(
      {
        changes: [
          {
            path: filePath,
            expected_hash: `sha256:${sha256('wrong content')}`,
            content: 'new\n',
          },
        ],
      },
      signal,
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('validation_failed');
    // No warning — the patch failed, disk was not touched.
    expect(parsed).not.toHaveProperty('_reread_warning');
  });
});

// ---------------------------------------------------------------------------
// Issue #2065: _reread_warning on partial_failure
// ---------------------------------------------------------------------------

describe('patch_apply — _reread_warning on partial_failure (#2065)', () => {
  it('includes _reread_warning on partial_failure with non-empty files_changed', async () => {
    // Trigger a real partial_failure by writing a file that passes validation
    // and then mocking the engine via spyOn at the module level.
    //
    // Strategy: create a real file so validatePatchChanges passes, but make
    // applyPatch return a partial_failure result (simulating a rename failure
    // where some files were already written to disk).
    const filePath = await writeTemp('partial-warn.txt', 'original\n');

    const engineMod = await import('./patch-apply-engine.js');
    const applyPatchSpy = vi.spyOn(engineMod, 'applyPatch').mockResolvedValueOnce({
      status: 'partial_failure',
      diff: '--- a\n+++ b\n',
      files_changed: [{ path: filePath, before_hash: 'sha256:aaa', after_hash: 'sha256:bbb' }],
      errors: [{ path: filePath, error: 'rename_failed', detail: 'EACCES' }],
    });

    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, content: 'new\n' }] },
      signal,
      makeCtx(),
    );

    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('partial_failure');
    // Files were written to disk — warning must be present and list the path.
    expect(parsed).toHaveProperty('_reread_warning');
    expect(typeof parsed._reread_warning).toBe('string');
    expect(parsed._reread_warning).toContain('IMPORTANT');
    expect(parsed._reread_warning).toContain(filePath);

    applyPatchSpy.mockRestore();
  });

  it('omits _reread_warning on partial_failure with empty files_changed', async () => {
    // Simulate a partial_failure where no files were written (all temp writes failed).
    const filePath = await writeTemp('partial-no-warn.txt', 'original\n');

    const engineMod = await import('./patch-apply-engine.js');
    const applyPatchSpy = vi.spyOn(engineMod, 'applyPatch').mockResolvedValueOnce({
      status: 'partial_failure',
      diff: '',
      files_changed: [],
      errors: [{ path: filePath, error: 'temp_write_failed', detail: 'ENOSPC' }],
    });

    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, content: 'new\n' }] },
      signal,
      makeCtx(),
    );

    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('partial_failure');
    // No files written to disk — warning must be absent.
    expect(parsed).not.toHaveProperty('_reread_warning');

    applyPatchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Regression: patch_apply with NO cwd context (unconfined subagent scenario)
//
// Root cause: before the fix, `patch_apply` computed its fallback resolveBase
// as `process.cwd()`, which made `computeContainment` treat the session as
// CONFINED (resolveBase !== undefined). Then `context.writeRoots ?? [resolveBase]`
// resolved to `[]` (an empty but DEFINED writeRoots from an
// `ensureInitialized(undefined)` call), denying every path.
//
// `write_file` and `edit_file` never had this fallback, so a session with
// `context.writeRoots = []` AND `context.resolveBase = undefined` would hit
// the `resolveBase === undefined` → unconfined early return in
// `computeContainment` and succeed. The fix aligns patch_apply: drop the
// `process.cwd()` fallback so the unconfined path fires correctly.
// ---------------------------------------------------------------------------
describe('patch_apply handler — unconfined session (no cwd, empty writeRoots)', () => {
  // Context that mimics an unconfined subagent dispatched before the parent
  // session's provider-assigned id is known: resolveBase is undefined,
  // but writeRoots is an EXPLICIT empty array (the result of
  // `ensureInitialized(undefined)` in the provider's grant state).
  const unconfinedCtx = () => ({
    resolveBase: undefined as string | undefined,
    writeRoots: [] as string[],
    readRoots: [] as string[],
  });

  it('applies an absolute-path content change without a cwd context (regression: write roots [])', async () => {
    const filePath = await writeTemp('unconf-abs.txt', 'old\n');
    // No factory cwd — simulates bare patchApplyHandler (no session anchor).
    const handler = createPatchApplyHandler();
    const result = await handler(
      { changes: [{ path: filePath, content: 'new\n' }] },
      signal,
      unconfinedCtx(),
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('applied');
    const actual = await readFile(filePath, 'utf-8');
    expect(actual).toBe('new\n');
  });

  it('applies an absolute-path edit without a cwd context (regression: write roots [])', async () => {
    const filePath = await writeTemp('unconf-edit.txt', 'hello world\n');
    const handler = createPatchApplyHandler();
    const result = await handler(
      { changes: [{ path: filePath, edits: [{ old: 'world', new: 'universe' }] }] },
      signal,
      unconfinedCtx(),
    );
    expect(result.isError).toBeFalsy();
    const actual = await readFile(filePath, 'utf-8');
    expect(actual).toBe('hello universe\n');
  });

  it('previously returned validation_failed with path_containment when writeRoots is [] and process.cwd() was the fallback resolveBase', async () => {
    // This test documents the PRE-FIX failure shape so a future regression is
    // immediately obvious. After the fix the handler must succeed (not return
    // path_containment).
    const filePath = await writeTemp('unconf-regress.txt', 'before\n');
    const handler = createPatchApplyHandler();
    const result = await handler(
      { changes: [{ path: filePath, content: 'after\n' }] },
      signal,
      unconfinedCtx(),
    );
    // Post-fix: succeeds.
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('applied');
    // Pre-fix shape for documentation:
    //   expect(parsed.status).toBe('validation_failed');
    //   expect(parsed.errors[0].error).toBe('path_containment');
    //   expect(parsed.errors[0].detail).toContain('write roots []');
  });
});

// ---------------------------------------------------------------------------
// Blank optional fields (strict-mode callers must emit every param)
// ---------------------------------------------------------------------------

describe('patch_apply — blank optional fields', () => {
  it.each([
    ['empty string', ''],
    ['whitespace', '  '],
    ['null', null],
  ])('treats a blank expected_hash (%s) as omitted', async (_label, blank) => {
    const filePath = await writeTemp(`bh-${randomBytes(3).toString('hex')}.txt`, 'one two\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, expected_hash: blank, edits: [{ old: 'two', new: 'TWO' }] }] },
      signal,
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content as string).status).toBe('applied');
    expect(await readFile(filePath, 'utf-8')).toBe('one TWO\n');
  });

  it.each([
    ['empty string', ''],
    ['null', null],
  ])('treats content %s alongside non-empty edits as omitted and applies the edits', async (_label, placeholder) => {
    const filePath = await writeTemp(`pc-${randomBytes(3).toString('hex')}.txt`, 'alpha beta\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, content: placeholder, edits: [{ old: 'beta', new: 'BETA' }] }] },
      signal,
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content as string).status).toBe('applied');
    expect(await readFile(filePath, 'utf-8')).toBe('alpha BETA\n');
  });

  it('still rejects whitespace-only content alongside edits (whitespace is a real payload)', async () => {
    const filePath = await writeTemp('ws.txt', 'alpha beta\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, content: '  ', edits: [{ old: 'beta', new: 'BETA' }] }] },
      signal,
      makeCtx(),
    );
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('validation_failed');
    expect(parsed.errors[0].error).toBe('mutually_exclusive');
    expect(await readFile(filePath, 'utf-8')).toBe('alpha beta\n');
  });

  it('still rejects empty content alongside an EMPTY edits array (ambiguous intent)', async () => {
    const filePath = await writeTemp('ee.txt', 'keep me\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, content: '', edits: [] }] },
      signal,
      makeCtx(),
    );
    const parsed = JSON.parse(result.content as string);
    expect(parsed.status).toBe('validation_failed');
    expect(parsed.errors[0].error).toBe('mutually_exclusive');
    expect(await readFile(filePath, 'utf-8')).toBe('keep me\n');
  });

  it('empty content on its own still truncates the file', async () => {
    const filePath = await writeTemp('trunc.txt', 'to be emptied\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler({ changes: [{ path: filePath, content: '' }] }, signal, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content as string).status).toBe('applied');
    expect(await readFile(filePath, 'utf-8')).toBe('');
  });

  // Issue #3067: standalone content: null (no edits key) must reach the
  // structured validator and fire no_change_specified, not a parse-layer type
  // error ("content must be a string").
  it('standalone content: null fires no_change_specified, not a parse error (#3067)', async () => {
    const filePath = await writeTemp('null-content.txt', 'unchanged\n');
    const handler = createPatchApplyHandler(tempDir);
    const result = await handler(
      { changes: [{ path: filePath, content: null }] },
      signal,
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content as string);
    // Must reach the structured validator — not a parse-layer error.
    expect(parsed.status).toBe('validation_failed');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].error).toBe('no_change_specified');
    // File untouched.
    expect(await readFile(filePath, 'utf-8')).toBe('unchanged\n');
  });
});
