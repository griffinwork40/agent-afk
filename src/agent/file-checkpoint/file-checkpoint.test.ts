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

  it('records a NEW_FILE_SENTINEL for a file that does not exist', async () => {
    const file = path.join(tmpDir, 'nonexistent.txt');

    const reg = createFileCheckpointRegistry('sess1', 'turn2', stateDir);
    await reg.snapshotFile(file);

    const snapshots = listTurnSnapshots('sess1', 'turn2', stateDir);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.isNewFile).toBe(true);
    expect(readFileSync(snapshots[0]!.snapshotPath, 'utf8')).toBe(NEW_FILE_SENTINEL);
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

  it('returns canRewind:false when no checkpoint exists for the turn', async () => {
    const result = await rewindFiles(
      { sessionId: 'sess1', enableFileCheckpointing: true, _stateDir: stateDir },
      'missing-turn',
    );
    expect(result.canRewind).toBe(false);
    expect(result.error).toMatch(/No file checkpoint/);
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
