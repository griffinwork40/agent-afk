import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { _setRealScratchRootsForTests, _resetScratchRootsCacheForTests } from '../tools/handlers/scratch-roots.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, readlinkSync, lstatSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';

// Built-in ESM namespaces are immutable; copied exports allow fault injection.
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }));
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createFileCheckpointRegistry, listTurnSnapshots } from './file-checkpoint.js';
import { rewindFiles } from './rewind-files.js';
import { createWriteFileHandler } from '../tools/handlers/write-file.js';
import { createEditFileHandler } from '../tools/handlers/edit-file.js';
import { createPatchApplyHandler } from '../tools/handlers/patch-apply.js';
import type { ToolHandlerContext } from '../tools/types.js';

let root: string;
let state: string;
let context: ToolHandlerContext;
const signal = () => new AbortController().signal;
const turn = 'turn';
const session = 'session';
const snapshots = () => listTurnSnapshots(session, turn, state);
const rewind = (dryRun = false) => rewindFiles({ sessionId: session, enableFileCheckpointing: true, _stateDir: state, writePolicy: context }, turn, { dryRun });

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'afk-checkpoint-handlers-')));
  state = join(root, 'state');
  context = { resolveBase: root, writeRoots: [root], readRoots: [root], fileCheckpoint: createFileCheckpointRegistry(session, turn, state) };
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

// This suite uses os.tmpdir() dirs as "outside every granted root". The OS
// temp dir is an implicit WRITE root (scratch-roots.ts), so disable that
// allowance here to keep testing granted-root containment, not temp policy.
beforeEach(() => _setRealScratchRootsForTests([]));
afterEach(() => _resetScratchRootsCacheForTests());

describe('real handler checkpoint and rewind regressions', () => {
  it('write_file snapshots the final dangling link target and preserves the link', async () => {
    const link = join(root, 'link');
    const target = join(root, 'target');
    symlinkSync('target', link, 'file');
    const result = await createWriteFileHandler(root)({ file_path: link, content: 'created' }, signal(), context);
    expect(result.isError).not.toBe(true);
    expect(snapshots()[0]?.absPath).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('created');
    expect((await rewind()).canRewind).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readlinkSync(link)).toBe('target');
  });

  it('patch_apply preserves existing links and restores their real target', async () => {
    const target = join(root, 'target');
    const link = join(root, 'link');
    writeFileSync(target, 'old');
    symlinkSync('target', link, 'file');
    const result = await createPatchApplyHandler(root)({ changes: [{ path: link, content: 'new' }] }, signal(), context);
    expect(result.isError).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(snapshots()[0]?.absPath).toBe(target);
    expect((await rewind()).canRewind).toBe(true);
    expect(readFileSync(link, 'utf8')).toBe('old');
    expect(readlinkSync(link)).toBe('target');
  });

  it('patch_apply preserves a dangling link when undoing a newly created target', async () => {
    const link = join(root, 'link');
    symlinkSync('target', link, 'file');
    const result = await createPatchApplyHandler(root)({ changes: [{ path: link, content: 'new' }] }, signal(), context);
    expect(result.isError).toBe(false);
    expect((await rewind()).canRewind).toBe(true);
    expect(readlinkSync(link)).toBe('target');
    expect(existsSync(join(root, 'target'))).toBe(false);
  });

  it.each([
    { old_string: 'absent', new_string: 'new' },
    { old_string: 'old', new_string: 'new', expected_hash: `sha256:${'0'.repeat(64)}` },
    { old_string: 'o', new_string: 'new' },
  ])('rejected edit does not authorize rewind: %j', async (edit) => {
    const file = join(root, 'file');
    writeFileSync(file, 'old old');
    const result = await createEditFileHandler(root)({ file_path: file, ...edit }, signal(), context);
    expect(result.isError).toBe(true);
    expect(snapshots()).toEqual([]);
    writeFileSync(file, 'external');
    expect((await rewind()).canRewind).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('external');
  });

  it('missing edit target is rejected without a snapshot', async () => {
    const result = await createEditFileHandler(root)({ file_path: join(root, 'missing'), old_string: 'old', new_string: 'new' }, signal(), context);
    expect(result.isError).toBe(true);
    expect(snapshots()).toEqual([]);
  });

  it('accepted edit snapshots just before writing and rewinds', async () => {
    const file = join(root, 'file');
    writeFileSync(file, 'old');
    expect((await createEditFileHandler(root)({ file_path: file, old_string: 'old', new_string: 'new' }, signal(), context)).isError).not.toBe(true);
    expect((await rewind()).canRewind).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it('rejects edit target retargeting during snapshot publication', async () => {
    const file = join(root, 'file');
    const redirected = join(root, 'redirected');
    writeFileSync(file, 'old');
    writeFileSync(redirected, 'external');
    const registry = context.fileCheckpoint!;
    context.fileCheckpoint = { turnId: turn, touchedPaths: () => registry.touchedPaths(), async snapshotFile(target) {
      await registry.snapshotFile(target);
      rmSync(file);
      symlinkSync(redirected, file, 'file');
    } };
    const result = await createEditFileHandler(root)({ file_path: file, old_string: 'old', new_string: 'new' }, signal(), context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('destination changed');
    expect(readFileSync(redirected, 'utf8')).toBe('external');
  });

  it('resolves relative patch destinations against the handler cwd', async () => {
    const file = join(root, 'relative');
    writeFileSync(file, 'old');
    const result = await createPatchApplyHandler(root)({ changes: [{ path: 'relative', content: 'new' }] }, signal(), context);
    expect(result.isError).toBe(false);
    expect(snapshots()[0]?.absPath).toBe(file);
    expect((await rewind()).canRewind).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it('revalidates file symlink containment on rewind', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'afk-checkpoint-outside-')));
    try {
      const destination = join(outside, 'file');
      writeFileSync(destination, 'outside');
      const file = join(root, 'file');
      writeFileSync(file, 'old');
      await context.fileCheckpoint!.snapshotFile(file);
      rmSync(file);
      symlinkSync(destination, file, 'file');
      const result = await rewind();
      expect(result.canRewind).toBe(false);
      expect(result.error).toMatch(/outside/);
      expect(readFileSync(destination, 'utf8')).toBe('outside');
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('revalidates a retargeted parent link before deleting new files', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'afk-checkpoint-outside-')));
    try {
      const parent = join(root, 'parent');
      mkdirSync(parent);
      const file = join(parent, 'new');
      await context.fileCheckpoint!.snapshotFile(file);
      rmSync(parent, { recursive: true });
      writeFileSync(join(outside, 'new'), 'outside');
      symlinkSync(outside, parent, 'junction');
      expect((await rewind()).canRewind).toBe(false);
      expect(readFileSync(join(outside, 'new'), 'utf8')).toBe('outside');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it.each(['file', 'parent'])('refuses a regular %s replacement during deletion validation', async (kind) => {
    const parent = join(root, 'parent');
    const file = join(parent, 'new');
    mkdirSync(parent);
    await context.fileCheckpoint!.snapshotFile(file);
    writeFileSync(file, 'tracked');
    const originalRead = fs.readFileSync;
    let readCurrent = false;
    let injected = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      const result = originalRead(...args);
      if (String(args[0]) === file) readCurrent = true;
      return result;
    });
    // The getter runs inside assertDestination's real containment validation.
    Object.defineProperty(context, 'writeRoots', { get() {
      if (readCurrent && !injected) {
        injected = true;
        fs.renameSync(kind === 'file' ? file : parent, join(root, 'saved'));
        if (kind === 'parent') mkdirSync(parent);
        writeFileSync(file, 'replacement');
      }
      return [root];
    } });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
    const result = await rewind();
    expect(injected).toBe(true);
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/identity changed/);
    expect(result.filesChanged).toEqual([]);
    expect(result.deletions).toBe(0);
    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe('replacement');
    expect(readFileSync(kind === 'file' ? join(root, 'saved') : join(root, 'saved', 'new'), 'utf8')).toBe('tracked');
  });

  it('rechecks denylist even when containment is bypassed', async () => {
    const file = join(root, 'file');
    writeFileSync(file, 'old');
    await context.fileCheckpoint!.snapshotFile(file);
    rmSync(file);
    symlinkSync(join(homedir(), '.ssh', 'checkpoint-forbidden'), file, 'file');
    context.allowAll = true;
    const result = await rewind();
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/protected|denied|refus|denylist/i);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('uses current revoked write grants, not original snapshot authorization', async () => {
    const file = join(root, 'file');
    writeFileSync(file, 'old');
    await context.fileCheckpoint!.snapshotFile(file);
    writeFileSync(file, 'new');
    context.writeRoots = [];
    expect((await rewind()).canRewind).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('snapshot I/O failures leave no restorable entry and retries succeed', async () => {
    const file = join(root, 'file');
    writeFileSync(file, 'old');
    const write = vi.spyOn(fsPromises, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(context.fileCheckpoint!.snapshotFile(file)).rejects.toThrow('disk full');
    expect(snapshots()).toEqual([]);
    write.mockRestore();
    await context.fileCheckpoint!.snapshotFile(file);
    expect(snapshots()).toHaveLength(1);
    expect(readFileSync(snapshots()[0]!.snapshotPath, 'utf8')).toBe('old');
  });

  it('metadata publication failure leaves no partial entry', async () => {
    const file = join(root, 'file');
    writeFileSync(file, 'old');
    const original = fsPromises.writeFile;
    vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('metadata.json')) throw new Error('metadata failure');
      return original(...args);
    });
    await expect(context.fileCheckpoint!.snapshotFile(file)).rejects.toThrow('metadata failure');
    expect(snapshots()).toEqual([]);
    vi.restoreAllMocks();
    await context.fileCheckpoint!.snapshotFile(file);
    expect(snapshots()).toHaveLength(1);
  });

  it('concurrent registries atomically publish only one complete first snapshot', async () => {
    const file = join(root, 'file');
    writeFileSync(file, 'old');
    const other = createFileCheckpointRegistry(session, turn, state);
    await Promise.all([context.fileCheckpoint!.snapshotFile(file), other.snapshotFile(file)]);
    expect(snapshots()).toHaveLength(1);
    expect(readFileSync(snapshots()[0]!.snapshotPath, 'utf8')).toBe('old');
  });

  it('digest filenames handle absolute paths whose base64 exceeds NAME_MAX', async () => {
    const file = join(root, 'a'.repeat(90), 'b'.repeat(90), 'file');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'old');
    await context.fileCheckpoint!.snapshotFile(file);
    expect(snapshots()[0]?.absPath).toBe(file);
    expect(readdirSync(join(state, 'file-checkpoints', session, turn))[0]?.length).toBeLessThan(100);
    writeFileSync(file, 'new');
    expect((await rewind()).canRewind).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it('failed atomic rename leaves destination complete and reports prior progress', async () => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    writeFileSync(a, 'old a'); writeFileSync(b, 'old b');
    await context.fileCheckpoint!.snapshotFile(a); await context.fileCheckpoint!.snapshotFile(b);
    writeFileSync(a, 'new a'); writeFileSync(b, 'new b');
    const ordered = snapshots();
    const failing = ordered[1]!.absPath;
    const originalRename = fs.renameSync;
    let injected = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (realpathSync.native(String(to)) === realpathSync.native(failing)) {
        injected = true;
        throw new Error('atomic rename failed');
      }
      return originalRename(from, to);
    });
    const result = await rewind();
    expect(renameSpy).toHaveBeenCalled();
    expect(injected).toBe(true);
    expect(result.canRewind).toBe(false);
    expect(result.filesChanged).toEqual([ordered[0]!.absPath]);
    expect(result.error).toContain(failing);
    expect(readFileSync(failing, 'utf8')).toMatch(/^new/);
    expect(readdirSync(root).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });

  it.each([false, true])('refuses a parent swap before staging writes (missing parent: %s)', async (missing) => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'afk-checkpoint-outside-')));
    const parent = join(root, 'parent');
    const file = join(parent, ...(missing ? ['nested', 'file'] : ['file']));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'old');
    await context.fileCheckpoint!.snapshotFile(file);
    if (missing) rmSync(join(parent, 'nested'), { recursive: true });
    else writeFileSync(file, 'new');
    const originalStat = fs.statSync;
    let parentStats = 0;
    let injected = false;
    vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
      const result = originalStat(...args);
      if (String(args[0]) === parent && ++parentStats === 2) {
        rmSync(parent, { recursive: true });
        symlinkSync(outside, parent, 'junction');
        injected = true;
      }
      return result;
    });
    try {
      const result = await rewind();
      expect(injected).toBe(true);
      expect(result.canRewind).toBe(false);
      expect(result.filesChanged).toEqual([]);
      expect(readdirSync(outside)).toEqual([]);
    } finally { vi.restoreAllMocks(); rmSync(outside, { recursive: true, force: true }); }
  });

  it.each(['outside', 'protected', 'relative'])('refuses malicious %s checkpoint metadata without writing', async (kind) => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'afk-checkpoint-manifest-')));
    try {
      const original = join(root, 'original');
      writeFileSync(original, 'old');
      await context.fileCheckpoint!.snapshotFile(original);
      const entry = snapshots()[0]!;
      const metadataPath = join(dirname(entry.snapshotPath), 'metadata.json');
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      const destination = kind === 'outside' ? join(outside, 'file')
        : kind === 'protected' ? join(homedir(), '.ssh', 'checkpoint-malicious') : 'relative';
      if (kind === 'protected') context.allowAll = true;
      writeFileSync(metadataPath, JSON.stringify({ ...metadata, absPath: destination }));
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      const result = await rewind();
      expect(result.canRewind).toBe(false);
      expect(result.filesChanged).toEqual([]);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(readdirSync(outside)).toEqual([]);
      expect(readFileSync(original, 'utf8')).toBe('old');
    } finally { vi.restoreAllMocks(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('dry-run and repeat rewind report only actual content changes', async () => {
    const file = join(root, 'file');
    writeFileSync(file, 'old');
    await context.fileCheckpoint!.snapshotFile(file);
    expect((await rewind(true)).filesChanged).toEqual([]);
    writeFileSync(file, 'new');
    expect((await rewind(true)).filesChanged).toEqual([file]);
    expect(readFileSync(file, 'utf8')).toBe('new');
    await rewind();
    expect((await rewind()).filesChanged).toEqual([]);
  });
});
