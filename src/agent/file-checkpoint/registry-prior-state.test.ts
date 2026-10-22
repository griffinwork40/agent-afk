import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileCheckpointRegistry, listTurnSnapshots } from './file-checkpoint.js';
import { rewindFiles } from './rewind-files.js';
import { endCheckpointTurn, beginCheckpointTurn } from './turn-lifecycle.js';
import { readTurnLog, hashBytes } from './turn-log.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'afk-prior-state-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

for (const order of ['tool-first', 'bash-first', 'concurrent'] as const) {
  it(`first touch wins across bash and file tools (${order})`, async () => {
    const file = join(root, 'file');
    writeFileSync(file, 'tool baseline');
    const registry = createFileCheckpointRegistry('session', 'turn', root);
    const bash = () => registry.recordPriorState(file, { bytes: Buffer.from('bash baseline'), mode: 0o644 });
    const tool = () => registry.snapshotFile(file);
    if (order === 'tool-first') { await tool(); await bash(); }
    else if (order === 'bash-first') { await bash(); await tool(); }
    else await Promise.all([bash(), tool()]);
    const snapshots = listTurnSnapshots('session', 'turn', root);
    expect(snapshots).toHaveLength(1);
    expect(readFileSync(snapshots[0]!.snapshotPath, 'utf8')).toBe(order === 'tool-first' ? 'tool baseline' : 'bash baseline');
    expect(registry.touchedPaths()).toEqual([file]);
  });
}

it('prior null deletes a bash-created file on rewind', async () => {
  const file = join(root, 'new-file');
  writeFileSync(file, 'created by bash');
  const registry = createFileCheckpointRegistry('session', 'turn', root);
  await registry.recordPriorState(file, null);
  const result = await rewindFiles({ sessionId: 'session', enableFileCheckpointing: true, _stateDir: root, writePolicy: { writeRoots: [root] } }, 'turn');
  expect(result.canRewind).toBe(true);
  expect(existsSync(file)).toBe(false);
});

it('post-turn drift baseline includes bash-recorded paths', async () => {
  const file = join(root, 'file');
  const registry = beginCheckpointTurn('session', 'turn', root);
  await registry.recordPriorState(file, { bytes: Buffer.from('before'), mode: 0o644 });
  writeFileSync(file, 'after');
  endCheckpointTurn('session', registry, root);
  expect(readTurnLog('session', root)).toContainEqual(expect.objectContaining({ kind: 'post', paths: { [file]: hashBytes(Buffer.from('after')) } }));
});
