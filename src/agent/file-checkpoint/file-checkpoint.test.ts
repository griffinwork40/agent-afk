/**
 * Tests for file checkpointing (snapshot + rewind).
 *
 * @module agent/file-checkpoint/file-checkpoint.test
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import {
  createFileCheckpointRegistry,
  listTurnSnapshots,
  NEW_FILE_SENTINEL,
  decodePathKey,
} from './file-checkpoint.js';
import { rewindFiles } from './rewind-files.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
/** Isolated state dir passed via _stateDir — avoids real ~/.afk. */
let stateDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'afk-checkpoint-'));
  stateDir = path.join(tmpDir, 'state');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit tests: createFileCheckpointRegistry
// ---------------------------------------------------------------------------

describe('createFileCheckpointRegistry', () => {
  it('snapshots an existing file', async () => {
    const file = path.join(tmpDir, 'foo.txt');
    writeFileSync(file, 'original content');

    const reg = createFileCheckpointRegistry('sess1', 'turn1', stateDir);
    await reg.snapshotFile(file);

    const snapshots = listTurnSnapshots('sess1', 'turn1', stateDir);
    expect(snapshots).toHaveLength(1);
    const snap = snapshots[0]!;
    expect(snap.absPath).toBe(file);
    expect(snap.isNewFile).toBe(false);
    expect(readFileSync(snap.snapshotPath, 'utf8')).toBe('original content');
  });

  it('records a new-file marker for a file that does not exist', async () => {
    const file = path.join(tmpDir, 'nonexistent.txt');

    const reg = createFileCheckpointRegistry('sess1', 'turn2', stateDir);
    await reg.snapshotFile(file);

    const snapshots = listTurnSnapshots('sess1', 'turn2', stateDir);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.isNewFile).toBe(true);
    // Existence metadata and content are atomically published together.
    expect(readFileSync(snapshots[0]!.snapshotPath, 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(path.join(path.dirname(snapshots[0]!.snapshotPath), 'metadata.json'), 'utf8')).isNewFile).toBe(true);
  });

  it('is idempotent — only the first call per path captures content', async () => {
    const file = path.join(tmpDir, 'idem.txt');
    writeFileSync(file, 'first');

    const reg = createFileCheckpointRegistry('sess1', 'turn3', stateDir);
    await reg.snapshotFile(file);

    // Now mutate the file — a second snapshot should NOT capture this.
    writeFileSync(file, 'second');
    await reg.snapshotFile(file);

    const snapshots = listTurnSnapshots('sess1', 'turn3', stateDir);
    expect(snapshots).toHaveLength(1);
    expect(readFileSync(snapshots[0]!.snapshotPath, 'utf8')).toBe('first');
  });

  it('handles multiple files in one turn', async () => {
    const a = path.join(tmpDir, 'a.txt');
    const b = path.join(tmpDir, 'b.txt');
    writeFileSync(a, 'aaa');
    writeFileSync(b, 'bbb');

    const reg = createFileCheckpointRegistry('sess1', 'turn4', stateDir);
    await reg.snapshotFile(a);
    await reg.snapshotFile(b);

    const snapshots = listTurnSnapshots('sess1', 'turn4', stateDir);
    expect(snapshots).toHaveLength(2);
    const paths = snapshots.map((s) => s.absPath).sort();
    expect(paths).toEqual([a, b].sort());
  });

  it('exposes turnId', () => {
    const reg = createFileCheckpointRegistry('sess1', 'my-turn', stateDir);
    expect(reg.turnId).toBe('my-turn');
  });

  it('preserves binary content in snapshots', async () => {
    const file = path.join(tmpDir, 'binary.bin');
    const buf = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    writeFileSync(file, buf);

    const reg = createFileCheckpointRegistry('sess1', 'turn-bin', stateDir);
    await reg.snapshotFile(file);

    const snapshots = listTurnSnapshots('sess1', 'turn-bin', stateDir);
    expect(snapshots).toHaveLength(1);
    const saved = readFileSync(snapshots[0]!.snapshotPath);
    expect(saved).toEqual(buf);
  });
});

describe('listTurnSnapshots mode validation', () => {
  async function metadataPath(): Promise<string> {
    const file = path.join(tmpDir, 'mode.txt');
    writeFileSync(file, 'original');
    await createFileCheckpointRegistry('mode-session', 'mode-turn', stateDir).snapshotFile(file);
    return path.join(path.dirname(listTurnSnapshots('mode-session', 'mode-turn', stateDir)[0]!.snapshotPath), 'metadata.json');
  }

  it.each(['384', null, true, {}, [], 1.5, 0o4600, 0o2600, 0o6600])('rejects malicious mode %j before rewind mutation', async (mode) => {
    const metadataFile = await metadataPath();
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
    writeFileSync(metadataFile, JSON.stringify({ ...metadata, mode }));
    writeFileSync(metadata.absPath, 'mutated');
    expect(() => listTurnSnapshots('mode-session', 'mode-turn', stateDir)).toThrow(/Invalid checkpoint mode/);
    const result = await rewindFiles(
      { sessionId: 'mode-session', enableFileCheckpointing: true, _stateDir: stateDir }, 'mode-turn',
    );
    expect(result.canRewind).toBe(false);
    expect(result.filesChanged).toEqual([]);
    expect(readFileSync(metadata.absPath, 'utf8')).toBe('mutated');
  });

  it.each(['1e400', '-1e400'])('rejects nonfinite JSON mode %s', async (mode) => {
    const metadataFile = await metadataPath();
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
    delete metadata.mode;
    writeFileSync(metadataFile, JSON.stringify(metadata).replace(/}$/, `,"mode":${mode}}`));
    expect(() => listTurnSnapshots('mode-session', 'mode-turn', stateDir)).toThrow(/Invalid checkpoint mode/);
  });

  it.each([undefined, 0, 0o600, 0o755, 0o1755, 0o100755])('preserves legacy/normal mode and masks file type bits: %s', async (mode) => {
    const metadataFile = await metadataPath();
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
    writeFileSync(metadataFile, JSON.stringify({ ...metadata, mode }));
    expect(listTurnSnapshots('mode-session', 'mode-turn', stateDir)[0]!.mode)
      .toBe(mode === undefined ? undefined : mode & 0o7777);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: decodePathKey round-trip
// ---------------------------------------------------------------------------

describe('decodePathKey', () => {
  it('round-trips arbitrary paths', () => {
    const cases = [
      '/home/user/project/src/file.ts',
      '/tmp/spaces in path/file.txt',
      '/path/with/unicode/example.txt',
    ];
    for (const p of cases) {
      const encoded = Buffer.from(p, 'utf8').toString('base64url');
      expect(decodePathKey(encoded)).toBe(p);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests: rewindFiles
// ---------------------------------------------------------------------------

describe('rewindFiles', () => {
  it('returns canRewind:false when checkpointing is disabled', async () => {
    const result = await rewindFiles(
      { sessionId: 'sess1', enableFileCheckpointing: false, _stateDir: stateDir },
      'any-turn',
    );
    expect(result.canRewind).toBe(false);
  });

  it.each([false, true])('rewinds an existing empty turn directory (dryRun: %s)', async (dryRun) => {
    const turnDir = path.join(stateDir, 'file-checkpoints', 'sess1', 'empty-turn');
    mkdirSync(turnDir, { recursive: true });
    expect(await rewindFiles(
      { sessionId: 'sess1', enableFileCheckpointing: true, _stateDir: stateDir }, 'empty-turn', { dryRun },
    )).toEqual({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 });
  });

  it('registry creation alone stays lazy and does not authorize a missing turn', async () => {
    createFileCheckpointRegistry('sess1', 'lazy-turn', stateDir);
    expect(existsSync(path.join(stateDir, 'file-checkpoints', 'sess1', 'lazy-turn'))).toBe(false);
    expect((await rewindFiles(
      { sessionId: 'sess1', enableFileCheckpointing: true, _stateDir: stateDir }, 'lazy-turn',
    )).canRewind).toBe(false);
  });

  it.each([false, true])('returns canRewind:false when no checkpoint exists (dryRun: %s)', async (dryRun) => {
    const result = await rewindFiles(
      { sessionId: 'sess1', enableFileCheckpointing: true, _stateDir: stateDir },
      'missing-turn',
      { dryRun },
    );
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/No file checkpoint/);
  });

  it('restores an existing file whose bytes equal the legacy new-file sentinel', async () => {
    const file = path.join(tmpDir, 'sentinel.txt');
    writeFileSync(file, NEW_FILE_SENTINEL);
    await createFileCheckpointRegistry('sentinel-session', 'sentinel-turn', stateDir).snapshotFile(file);
    writeFileSync(file, 'mutated');

    const result = await rewindFiles(
      { sessionId: 'sentinel-session', enableFileCheckpointing: true, _stateDir: stateDir },
      'sentinel-turn',
    );
    expect(result.canRewind).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(NEW_FILE_SENTINEL);
  });

  it('still deletes new files recorded by the legacy sentinel format', async () => {
    const file = path.join(tmpDir, 'legacy.txt');
    const turnDir = path.join(stateDir, 'file-checkpoints', 'legacy-session', 'legacy-turn');
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(path.join(turnDir, Buffer.from(file).toString('base64url')), NEW_FILE_SENTINEL);
    writeFileSync(file, 'created after checkpoint');
    const result = await rewindFiles(
      { sessionId: 'legacy-session', enableFileCheckpointing: true, _stateDir: stateDir },
      'legacy-turn',
    );
    expect(result.canRewind).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('reads version-2 flat snapshots without interpreting real sentinel bytes as deletion', async () => {
    const file = path.join(tmpDir, 'v2.txt');
    const created = path.join(tmpDir, 'v2-new.txt');
    const turnDir = path.join(stateDir, 'file-checkpoints', 'v2-session', 'v2-turn');
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(path.join(turnDir, '.format'), '2');
    writeFileSync(path.join(turnDir, Buffer.from(file).toString('base64url')), NEW_FILE_SENTINEL);
    const createdSnapshot = path.join(turnDir, Buffer.from(created).toString('base64url'));
    writeFileSync(createdSnapshot, '');
    writeFileSync(`${createdSnapshot}.new`, '');
    writeFileSync(file, 'mutated');
    writeFileSync(created, 'created');
    const result = await rewindFiles(
      { sessionId: 'v2-session', enableFileCheckpointing: true, _stateDir: stateDir }, 'v2-turn',
    );
    expect(result.canRewind).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(NEW_FILE_SENTINEL);
    expect(existsSync(created)).toBe(false);
  });

  it('restores a modified file to its pre-turn content', async () => {
    const file = path.join(tmpDir, 'restore.txt');
    writeFileSync(file, 'pre-turn content');

    const reg = createFileCheckpointRegistry('sess-restore', 'turn-r1', stateDir);
    await reg.snapshotFile(file);

    // Simulate a write_file mutation.
    writeFileSync(file, 'post-turn content');

    const result = await rewindFiles(
      { sessionId: 'sess-restore', enableFileCheckpointing: true, _stateDir: stateDir },
      'turn-r1',
    );

    expect(result.canRewind).toBe(true);
    expect(result.filesChanged).toContain(file);
    expect(readFileSync(file, 'utf8')).toBe('pre-turn content');
  });

  it('deletes a new file that was created during the turn', async () => {
    const file = path.join(tmpDir, 'new-file.txt');
    // File does not exist before turn — checkpoint records NEW_FILE_SENTINEL.
    const reg = createFileCheckpointRegistry('sess-new', 'turn-new', stateDir);
    await reg.snapshotFile(file);

    // Simulate write_file creating the file.
    writeFileSync(file, 'brand new content');
    expect(existsSync(file)).toBe(true);

    const result = await rewindFiles(
      { sessionId: 'sess-new', enableFileCheckpointing: true, _stateDir: stateDir },
      'turn-new',
    );

    expect(result.canRewind).toBe(true);
    expect(result.filesChanged).toContain(file);
    // File should be deleted on rewind.
    expect(existsSync(file)).toBe(false);
  });

  it('does not crash when new-file sentinel target is already absent at rewind time', async () => {
    const file = path.join(tmpDir, 'absent.txt');
    const reg = createFileCheckpointRegistry('sess-absent', 'turn-absent', stateDir);
    await reg.snapshotFile(file); // not exist → sentinel

    // File was never created by the model.
    expect(existsSync(file)).toBe(false);

    const result = await rewindFiles(
      { sessionId: 'sess-absent', enableFileCheckpointing: true, _stateDir: stateDir },
      'turn-absent',
    );
    // Rewind succeeds; no crash even if the file doesn't exist.
    expect(result.canRewind).toBe(true);
  });

  it('is idempotent — second rewind of the same turn does not crash', async () => {
    const file = path.join(tmpDir, 'idem-new.txt');
    const reg = createFileCheckpointRegistry('sess-idem', 'turn-idem', stateDir);
    await reg.snapshotFile(file);

    writeFileSync(file, 'created content');

    // First rewind: deletes the file.
    const r1 = await rewindFiles(
      { sessionId: 'sess-idem', enableFileCheckpointing: true, _stateDir: stateDir },
      'turn-idem',
    );
    expect(r1.canRewind).toBe(true);
    expect(existsSync(file)).toBe(false);

    // Second rewind: file is already absent — should not throw.
    const r2 = await rewindFiles(
      { sessionId: 'sess-idem', enableFileCheckpointing: true, _stateDir: stateDir },
      'turn-idem',
    );
    expect(r2.canRewind).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('idempotent — second rewind of existing-file turn restores same pre-turn state', async () => {
    const file = path.join(tmpDir, 'idem-existing.txt');
    writeFileSync(file, 'original');

    const reg = createFileCheckpointRegistry('sess-idem2', 'turn-idem2', stateDir);
    await reg.snapshotFile(file);
    writeFileSync(file, 'modified');

    const r1 = await rewindFiles(
      { sessionId: 'sess-idem2', enableFileCheckpointing: true, _stateDir: stateDir },
      'turn-idem2',
    );
    expect(r1.canRewind).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('original');

    writeFileSync(file, 'modified-again');
    const r2 = await rewindFiles(
      { sessionId: 'sess-idem2', enableFileCheckpointing: true, _stateDir: stateDir },
      'turn-idem2',
    );
    expect(r2.canRewind).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('original');
  });

  it('dry-run lists files without modifying them', async () => {
    const file = path.join(tmpDir, 'dry-run.txt');
    writeFileSync(file, 'pre-turn');

    const reg = createFileCheckpointRegistry('sess-dry', 'turn-dry', stateDir);
    await reg.snapshotFile(file);
    writeFileSync(file, 'post-turn');

    const result = await rewindFiles(
      { sessionId: 'sess-dry', enableFileCheckpointing: true, _stateDir: stateDir },
      'turn-dry',
      { dryRun: true },
    );

    expect(result.canRewind).toBe(true);
    expect(result.filesChanged).toContain(file);
    // Dry-run must NOT modify the file.
    expect(readFileSync(file, 'utf8')).toBe('post-turn');
  });

  it('restores multiple files in one turn', async () => {
    const a = path.join(tmpDir, 'multi-a.txt');
    const b = path.join(tmpDir, 'multi-b.txt');
    writeFileSync(a, 'a-pre');
    writeFileSync(b, 'b-pre');

    const reg = createFileCheckpointRegistry('sess-multi', 'turn-multi', stateDir);
    await reg.snapshotFile(a);
    await reg.snapshotFile(b);
    writeFileSync(a, 'a-post');
    writeFileSync(b, 'b-post');

    const result = await rewindFiles(
      { sessionId: 'sess-multi', enableFileCheckpointing: true, _stateDir: stateDir },
      'turn-multi',
    );
    expect(result.canRewind).toBe(true);
    expect(readFileSync(a, 'utf8')).toBe('a-pre');
    expect(readFileSync(b, 'utf8')).toBe('b-pre');
  });

  it('restores a file whose parent dir was removed after snapshot', async () => {
    const dir = path.join(tmpDir, 'subdir');
    const file = path.join(dir, 'nested.txt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, 'nested content');

    const reg = createFileCheckpointRegistry('sess-nested', 'turn-nested', stateDir);
    await reg.snapshotFile(file);

    // Remove the whole subdir.
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(file)).toBe(false);

    const result = await rewindFiles(
      { sessionId: 'sess-nested', enableFileCheckpointing: true, _stateDir: stateDir },
      'turn-nested',
    );
    expect(result.canRewind).toBe(true);
    // Parent dir and file should be recreated.
    expect(readFileSync(file, 'utf8')).toBe('nested content');
  });
});
