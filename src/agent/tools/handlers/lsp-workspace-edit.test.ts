import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, symlink, lstat, unlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSafe } from './_cwd-utils.js';
import { applyWorkspaceEdit, convertWorkspaceEdit, type WorkspaceEditOptions } from './lsp-workspace-edit.js';
import { applyTextEdits } from './lsp-workspace-edit-parse.js';
import { _setRealScratchRootsForTests, _resetScratchRootsCacheForTests } from './scratch-roots.js';
import { createFileCheckpointRegistry, listTurnSnapshots } from '../../file-checkpoint/file-checkpoint.js';
import * as engine from './patch-apply-engine.js';

let root: string;
let options: WorkspaceEditOptions;
const uri = (file: string) => pathToFileURL(file).toString();
const edit = (start: number, end: number, newText: string, line = 0) => ({
  range: { start: { line, character: start }, end: { line, character: end } }, newText,
});
const changes = (path: string, edits = [edit(0, 3, 'new')]) => ({ changes: { [uri(path)]: edits } });
const snapshots = () => listTurnSnapshots('test', 'turn', join(root, 'state'));
async function file(name: string, content = 'old') {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

beforeEach(async () => {
  root = realpathSafe(await mkdtemp(join(tmpdir(), 'afk-workspace-edit-')));
  options = { cwd: root, context: { resolveBase: root, writeRoots: [root],
    fileCheckpoint: createFileCheckpointRegistry('test', 'turn', join(root, 'state')) } };
  _setRealScratchRootsForTests([]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetScratchRootsCacheForTests();
  await rm(root, { recursive: true, force: true });
});

describe('WorkspaceEdit safe application', () => {
  it('applies changes across three files with exactly one patch transaction and canonical snapshots', async () => {
    const paths = await Promise.all(['a.ts', 'b.ts', 'c.ts'].map((name) => file(name)));
    const apply = vi.spyOn(engine, 'applyPatch');
    const syncFile = vi.fn(async () => null);
    const result = await applyWorkspaceEdit({ changes: Object.fromEntries(paths.map((p) => [uri(p), [edit(0, 3, 'new')]])) }, { ...options, client: { syncFile } });
    expect(result.isError).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(snapshots().map((s) => s.absPath).sort()).toEqual(paths.sort());
    expect(await Promise.all(paths.map((p) => readFile(p, 'utf8')))).toEqual(['new', 'new', 'new']);
    expect(syncFile.mock.calls).toHaveLength(3);
  });

  it('accepts TextDocumentEdit, matching numeric versions and null versions', async () => {
    const paths = await Promise.all(['a.ts', 'b.ts'].map((name) => file(name)));
    const result = await applyWorkspaceEdit({ documentChanges: paths.map((p, i) => ({
      textDocument: { uri: uri(p), version: i === 0 ? 4 : null }, edits: [edit(0, 3, 'new')],
    })) }, { ...options, documentVersion: () => 4 });
    expect(result.isError).toBe(false);
    expect(await readFile(paths[1]!, 'utf8')).toBe('new');
  });

  it.each([undefined, () => 2])('rejects unverifiable or stale numeric versions atomically', async (documentVersion) => {
    const p = await file('a.ts');
    const result = await applyWorkspaceEdit({ documentChanges: [{ textDocument: { uri: uri(p), version: 4 }, edits: [edit(0, 3, 'new')] }] }, { ...options, documentVersion });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('version mismatch');
    expect(await readFile(p, 'utf8')).toBe('old');
    expect(snapshots()).toEqual([]);
  });

  it('rejects known request-time text changed on disk', async () => {
    const p = await file('a.ts', 'external');
    const result = await applyWorkspaceEdit(changes(p), { ...options, expectedContents: new Map([[uri(p), 'old']]) });
    expect(result.content).toContain('changed during request');
    expect(await readFile(p, 'utf8')).toBe('external');
  });

  it('converts without mutation; preview neither snapshots nor syncs', async () => {
    const p = await file('a.ts');
    const converted = await convertWorkspaceEdit(changes(p), options);
    expect(converted[0]).toMatchObject({ path: p, content: 'new', expected_hash: expect.stringMatching(/^sha256:/) });
    const syncFile = vi.fn(async () => null);
    const result = await applyWorkspaceEdit(changes(p), { ...options, dryRun: true, client: { syncFile } });
    expect(JSON.parse(result.content).status).toBe('dry_run');
    expect(result.content).toContain('-old');
    expect(await readFile(p, 'utf8')).toBe('old');
    expect(snapshots()).toEqual([]);
    expect(syncFile).not.toHaveBeenCalled();
  });

  it.each(['create', 'rename', 'delete'])('rejects %s resource ops before snapshotting valid siblings', async (kind) => {
    const p = await file('a.ts');
    const result = await applyWorkspaceEdit({ documentChanges: [
      { textDocument: { uri: uri(p), version: null }, edits: [edit(0, 3, 'new')] }, { kind, uri: uri(p) },
    ] }, options);
    expect(result.content).toContain('resource operations');
    expect(await readFile(p, 'utf8')).toBe('old');
    expect(snapshots()).toEqual([]);
  });

  it('rejects an out-of-root member and symlink escapes, regardless of valid siblings', async () => {
    const outside = realpathSafe(await mkdtemp(join(tmpdir(), 'afk-workspace-outside-')));
    try {
      const good = await file('a.ts');
      const denied = join(outside, 'denied.ts');
      await writeFile(denied, 'old');
      const link = join(root, 'link.ts');
      await symlink(denied, link);
      for (const target of [denied, link]) {
        const result = await applyWorkspaceEdit({ changes: { ...changes(good).changes, ...changes(target).changes } }, options);
        expect(result.isError).toBe(true);
        expect(result.content).toContain('outside');
      }
      expect(await readFile(good, 'utf8')).toBe('old');
      expect(await readFile(denied, 'utf8')).toBe('old');
      expect(snapshots()).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('honors explicit extra write grants', async () => {
    const p = await file('a.ts');
    const result = await applyWorkspaceEdit(changes(p), { ...options, context: { resolveBase: join(root, 'other'), writeRoots: [root] } });
    expect(result.isError).toBe(false);
  });

  it('rejects denylisted targets even in bypass mode, with no valid sibling writes', async () => {
    const good = await file('a.ts');
    const denied = join(homedir(), '.ssh', 'workspace-edit-test-key');
    const result = await applyWorkspaceEdit({ changes: { ...changes(good).changes, ...changes(denied).changes } }, { ...options, context: { ...options.context, allowAll: true } });
    expect(result.isError).toBe(true);
    expect(await readFile(good, 'utf8')).toBe('old');
    expect(snapshots()).toEqual([]);
  });

  it('rejects custom read-denylisted files before exposing their text', async () => {
    const p = await file('secret.ts', 'SECRET');
    vi.stubEnv('AFK_READ_DENYLIST', p);
    const result = await applyWorkspaceEdit(changes(p), options);
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('SECRET');
  });

  it('preserves file symlinks and rejects duplicate canonical targets', async () => {
    const target = await file('a.ts');
    const link = join(root, 'link.ts');
    await symlink(target, link);
    const duplicate = await applyWorkspaceEdit({ changes: { ...changes(target).changes, ...changes(link).changes } }, options);
    expect(duplicate.content).toContain('duplicate physical');
    expect(snapshots()).toEqual([]);
    expect((await applyWorkspaceEdit(changes(link), options)).isError).toBe(false);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(snapshots()[0]?.absPath).toBe(target);
  });

  it.each(['https://example.com/a', 'untitled:foo', 'file:///tmp/a?x=1', 'file:///tmp/a#x', 'file:///tmp/a%00'])('rejects nonlocal or ambiguous URI %s', async (bad) => {
    expect((await applyWorkspaceEdit({ changes: { [bad]: [] } }, options)).isError).toBe(true);
    expect(snapshots()).toEqual([]);
  });

  it('does not create missing files or overwrite invalid UTF8', async () => {
    const missing = join(root, 'missing.ts');
    expect((await applyWorkspaceEdit(changes(missing), options)).isError).toBe(true);
    const binary = join(root, 'binary.ts');
    await writeFile(binary, Buffer.from([0xff, 0xfe]));
    expect((await applyWorkspaceEdit(changes(binary), options)).isError).toBe(true);
    expect(await readFile(binary)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(snapshots()).toEqual([]);
  });

  it('leaves no snapshots for no-ops or aborts', async () => {
    const p = await file('a.ts');
    expect((await applyWorkspaceEdit(changes(p, [edit(0, 3, 'old')]), options)).isError).toBe(false);
    expect((await applyWorkspaceEdit(changes(p), { ...options, signal: AbortSignal.abort() })).isError).toBe(true);
    expect(snapshots()).toEqual([]);
  });

  it('rejects invalid ranges in a later file without writing or snapshotting earlier files', async () => {
    const good = await file('a.ts');
    const bad = await file('b.ts');
    for (const edits of [[edit(0, 99, 'x')], [edit(0, 2, 'x'), edit(1, 3, 'y')]]) {
      const result = await applyWorkspaceEdit({ changes: { ...changes(good).changes, [uri(bad)]: edits } }, options);
      expect(result.isError).toBe(true);
      expect(await readFile(good, 'utf8')).toBe('old');
      expect(await readFile(bad, 'utf8')).toBe('old');
      expect(snapshots()).toEqual([]);
    }
  });

  it('fails closed before mutation when the normal checkpoint callback throws', async () => {
    const p = await file('a.ts');
    const apply = vi.spyOn(engine, 'applyPatch');
    options.context!.fileCheckpoint = { turnId: 'turn', touchedPaths: () => [], snapshotFile: async () => { throw new Error('checkpoint unavailable'); } };
    const result = await applyWorkspaceEdit(changes(p), options);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('checkpoint unavailable');
    expect(apply).not.toHaveBeenCalled();
    expect(await readFile(p, 'utf8')).toBe('old');
  });

  it('preserves a UTF-8 BOM and can replace the entire document with empty text', async () => {
    const p = await file('a.ts', '\uFEFFold');
    expect((await applyWorkspaceEdit(changes(p, [edit(1, 4, 'new')]), options)).isError).toBe(false);
    expect(await readFile(p, 'utf8')).toBe('\uFEFFnew');
    expect((await applyWorkspaceEdit(changes(p, [edit(0, 4, '')]), options)).isError).toBe(false);
    expect(await readFile(p, 'utf8')).toBe('');
  });

  it('does not resync a source symlink retargeted outside read grants during checkpoint', async () => {
    const target = await file('a.ts');
    const link = join(root, 'link.ts');
    const outside = realpathSafe(await mkdtemp(join(tmpdir(), 'afk-workspace-resync-')));
    try {
      const secret = join(outside, 'secret.ts');
      await writeFile(secret, 'SECRET');
      await symlink(target, link);
      options.context!.fileCheckpoint = { turnId: 'turn', touchedPaths: () => [], snapshotFile: async () => {
        await unlink(link);
        await symlink(secret, link);
      } };
      const syncFile = vi.fn(async () => null);
      const result = await applyWorkspaceEdit(changes(link), { ...options, client: { syncFile } });
      expect(result.isError).toBe(false);
      expect(result.incomplete).toBe(true);
      expect(syncFile.mock.calls).toEqual([[target]]);
      expect(await readFile(target, 'utf8')).toBe('new');
      expect(await readFile(secret, 'utf8')).toBe('SECRET');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('reports resync failure without implying successful disk changes were rolled back', async () => {
    const p = await file('a.ts');
    const result = await applyWorkspaceEdit(changes(p), { ...options, client: { syncFile: async () => { throw new Error('disconnected'); } } });
    expect(result.isError).toBe(false);
    expect(result.incomplete).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ status: 'applied', sync_warnings: [expect.stringContaining('disconnected')] });
    expect(await readFile(p, 'utf8')).toBe('new');
  });
});

describe('UTF-16 text edits', () => {
  it('applies original offsets in reverse, handles emoji, CRLF and same-offset inserts', () => {
    expect(applyTextEdits('😀foo\r\nbar\n', [edit(2, 5, 'longer'), edit(0, 3, 'B', 1)])).toBe('😀longer\r\nB\n');
    expect(applyTextEdits('old', [edit(0, 0, 'a'), edit(0, 0, 'b'), edit(0, 3, 'c')])).toBe('abc');
    expect(applyTextEdits('a\rb', [edit(0, 1, 'B', 1)])).toBe('a\rB');
  });

  it.each([
    [edit(1, 2, 'x')], [edit(0, 99, 'x')], [edit(0, 0, 'x', 4)],
    [edit(3, 2, 'x')], [edit(2, 4, 'x'), edit(3, 5, 'y')],
  ].map((edits) => ({ edits })))('rejects invalid UTF-16/bounds/reversed/overlapping ranges: $edits', ({ edits }) => {
    expect(() => applyTextEdits('😀foo', edits)).toThrow(/WorkspaceEdit/);
  });

  it('rejects malformed positions and confirmation annotations atomically', async () => {
    const p = await file('a.ts');
    for (const bad of [edit(-1, 0, 'x'), edit(0.5, 1, 'x'), { newText: 'x' }]) {
      expect((await applyWorkspaceEdit({ changes: { [uri(p)]: [bad] } }, options)).isError).toBe(true);
    }
    const result = await applyWorkspaceEdit({ changeAnnotations: { risky: { label: 'risky', needsConfirmation: true } },
      changes: { [uri(p)]: [{ ...edit(0, 3, 'new'), annotationId: 'risky' }] } }, options);
    expect(result.content).toContain('requires confirmation');
    expect(await readFile(p, 'utf8')).toBe('old');
    expect(snapshots()).toEqual([]);
  });
});
