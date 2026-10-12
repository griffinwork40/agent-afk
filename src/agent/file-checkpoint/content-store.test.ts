import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as promises from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));
import { getFileCheckpointBlobDir } from '../../paths.js';
import { createFileCheckpointRegistry, listTurnSnapshots } from './file-checkpoint.js';
import { rewindFiles } from './rewind-files.js';

let root: string;
let state: string;
const session = 'session';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const snapshot = async (file: string, turn = 'turn', id = session) => {
  await createFileCheckpointRegistry(id, turn, state).snapshotFile(file);
  return listTurnSnapshots(id, turn, state)[0]!;
};
const rewind = (turn = 'turn', dryRun = false) => rewindFiles({
  sessionId: session, enableFileCheckpointing: true, _stateDir: state,
  writePolicy: { resolveBase: root, writeRoots: [root] },
}, turn, { dryRun });

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'afk-checkpoint-blobs-')); state = join(root, 'state'); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('content-addressed checkpoint store', () => {
  it('creates no state for a registry without writes or disabled rewind', async () => {
    createFileCheckpointRegistry(session, 'unused', state);
    expect((await rewindFiles({ sessionId: session, enableFileCheckpointing: false, _stateDir: state }, 'unused')).canRewind).toBe(false);
    expect(existsSync(state)).toBe(false);
  });

  it('deduplicates binary bytes across paths and turns, not sessions', async () => {
    const bytes = Buffer.from([0, 255, 1, 254]);
    const a = join(root, 'a'); const b = join(root, 'b');
    writeFileSync(a, bytes); writeFileSync(b, bytes);
    const entries = await Promise.all([snapshot(a, 'one'), snapshot(b, 'two')]);
    const blobs = getFileCheckpointBlobDir(session, state);
    expect(readdirSync(blobs)).toHaveLength(1);
    expect(readdirSync(blobs)).toEqual([digest(bytes)]);
    for (const entry of entries) {
      expect(entry.contentHash).toBe(digest(bytes));
      expect(readFileSync(entry.snapshotPath)).toEqual(bytes);
    }
    await snapshot(a, 'one', 'other-session');
    expect(readdirSync(getFileCheckpointBlobDir('other-session', state))).toEqual([digest(bytes)]);
  });

  it('retains distinct pre-turn states and restores three files byte-for-byte', async () => {
    const files = ['a', 'b', 'c'].map((name) => join(root, name));
    const initial = files.map((_, index) => Buffer.from([0, index, 255]));
    for (const [index, file] of files.entries()) {
      writeFileSync(file, initial[index]!);
      await snapshot(file, 'one');
      writeFileSync(file, `turn one ${index}`);
      await snapshot(file, 'two');
      writeFileSync(file, `turn two ${index}`);
    }
    expect((await rewind('two')).canRewind).toBe(true);
    for (const [index, file] of files.entries()) expect(readFileSync(file, 'utf8')).toBe(`turn one ${index}`);
    expect((await rewind('one')).canRewind).toBe(true);
    for (const [index, file] of files.entries()) expect(readFileSync(file)).toEqual(initial[index]);
    expect(readdirSync(getFileCheckpointBlobDir(session, state))).toHaveLength(6);
  });

  it('keeps empty existing files distinct from missing files sharing empty bytes', async () => {
    const empty = join(root, 'empty'); const missing = join(root, 'missing');
    writeFileSync(empty, '');
    await snapshot(empty); await snapshot(missing);
    writeFileSync(empty, 'new'); writeFileSync(missing, 'created');
    expect(readdirSync(getFileCheckpointBlobDir(session, state))).toEqual([digest('')]);
    expect((await rewind()).canRewind).toBe(true);
    expect(readFileSync(empty, 'utf8')).toBe(''); expect(existsSync(missing)).toBe(false);
  });

  it.each([false, true])('rejects corrupted content before restore (dryRun: %s)', async (dryRun) => {
    const file = join(root, 'file'); writeFileSync(file, 'old');
    const entry = await snapshot(file);
    writeFileSync(entry.snapshotPath, 'corrupted'); writeFileSync(file, 'new');
    const result = await rewind('turn', dryRun);
    expect(result.canRewind).toBe(false); expect(result.error).toContain('Corrupt checkpoint content');
    expect(result.filesChanged).toEqual([]); expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('reads v3 entries without content digests for compatibility', async () => {
    const file = join(root, 'file'); writeFileSync(file, 'old');
    const entry = await snapshot(file);
    const metadataPath = join(dirname(entry.snapshotPath), 'metadata.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    delete metadata.contentHash; writeFileSync(metadataPath, JSON.stringify(metadata));
    writeFileSync(file, 'new'); expect((await rewind()).canRewind).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it.each(['../content', null, 123, 'f'.repeat(63)])('rejects malformed content digest %j', async (contentHash) => {
    const file = join(root, 'file'); writeFileSync(file, 'old');
    const entry = await snapshot(file);
    const metadataPath = join(dirname(entry.snapshotPath), 'metadata.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, contentHash }));
    expect((await rewind()).error).toContain('Invalid checkpoint content hash');
  });

  it('falls back to a copy when entry hardlinks are unsupported', async () => {
    vi.spyOn(promises, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }));
    const file = join(root, 'file'); writeFileSync(file, 'old');
    expect(readFileSync((await snapshot(file)).snapshotPath, 'utf8')).toBe('old');
    writeFileSync(file, 'new'); expect((await rewind()).canRewind).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it('cleans staging and permits retry after blob publication fails', async () => {
    const file = join(root, 'file'); writeFileSync(file, 'old');
    const registry = createFileCheckpointRegistry(session, 'turn', state);
    const rename = vi.spyOn(promises, 'rename').mockRejectedValueOnce(new Error('disk failure'));
    await expect(registry.snapshotFile(file)).rejects.toThrow('disk failure');
    expect(listTurnSnapshots(session, 'turn', state)).toEqual([]);
    expect(readdirSync(getFileCheckpointBlobDir(session, state))).toEqual([]);
    rename.mockRestore(); await registry.snapshotFile(file);
    expect(listTurnSnapshots(session, 'turn', state)).toHaveLength(1);
  });

  it.each(['EPERM', 'EACCES'])('retains original %s publication error without a winner', async (code) => {
    const file = join(root, 'file'); writeFileSync(file, 'old');
    const error = Object.assign(new Error('publication permission denied'), { code });
    vi.spyOn(promises, 'rename').mockRejectedValueOnce(error);
    await expect(snapshot(file)).rejects.toBe(error);
    expect(listTurnSnapshots(session, 'turn', state)).toEqual([]);
    expect(readdirSync(getFileCheckpointBlobDir(session, state))).toEqual([]);
  });

  it('refuses to reuse a corrupted shared blob', async () => {
    const file = join(root, 'file'); writeFileSync(file, 'old'); await snapshot(file, 'one');
    writeFileSync(join(getFileCheckpointBlobDir(session, state), digest('old'), 'content'), 'corrupt');
    await expect(snapshot(file, 'two')).rejects.toThrow('Corrupt checkpoint content');
    expect(listTurnSnapshots(session, 'two', state)).toEqual([]);
    expect(readdirSync(getFileCheckpointBlobDir(session, state))).toEqual([digest('old')]);
  });

  it('blob/dedup/integrity: same content to two paths shares one blob; corrupt blob fails that file while sibling with valid entry still restores', async () => {
    // Write the same bytes to two paths; snapshot both in the same turn.
    const bytes = Buffer.from('shared-content');
    const a = join(root, 'a'); const b = join(root, 'b');
    writeFileSync(a, bytes); writeFileSync(b, bytes);
    const registry = createFileCheckpointRegistry(session, 'turn', state);
    await registry.snapshotFile(a);
    await registry.snapshotFile(b);

    // One blob for both entries.
    const blobs = getFileCheckpointBlobDir(session, state);
    expect(readdirSync(blobs)).toHaveLength(1);
    expect(readdirSync(blobs)).toEqual([digest(bytes)]);

    // Corrupt the shared blob — both entry content files are hardlinks to it.
    const blobContent = join(blobs, digest(bytes), 'content');
    writeFileSync(blobContent, 'corrupted');

    // Overwrite both files so rewind has something to restore.
    writeFileSync(a, 'new-a'); writeFileSync(b, 'new-b');

    // Rewind must fail: the corrupt blob means neither file can be verified.
    const result = await rewind();
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/Corrupt checkpoint content/);
    // No file was changed before detection.
    expect(result.filesChanged).toEqual([]);

    // Now snapshot a second file with distinct content (valid entry) alongside
    // the corrupt one, to prove Fix 1: a sibling with a valid entry still restores.
    const c = join(root, 'c');
    writeFileSync(c, 'good-content');
    const registry2 = createFileCheckpointRegistry(session, 'turn2', state);
    await registry2.snapshotFile(c);
    writeFileSync(c, 'modified-c');
    const result2 = await rewindFiles(
      { sessionId: session, enableFileCheckpointing: true, _stateDir: state,
        writePolicy: { resolveBase: root, writeRoots: [root] } },
      'turn2',
    );
    expect(result2.canRewind).toBe(true);
    expect(readFileSync(c, 'utf8')).toBe('good-content');
  });
});
