/** Real stdio LSP -> multi-file patch -> checkpoints -> server document resync. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { LspClient } from '../../lsp/client.js';
import { TYPESCRIPT_SERVER_DEFINITION } from '../../lsp/typescript-default.js';
import { writeFakeLspServer, messagesWithMethod } from '../../lsp/__test-utils__/fake-lsp-server.js';
import { listTurnSnapshots } from '../../file-checkpoint/file-checkpoint.js';
import { beginCheckpointTurn, endCheckpointTurn } from '../../file-checkpoint/turn-lifecycle.js';
import { rewindFiles } from '../../file-checkpoint/rewind-files.js';
import { realpathSafe } from './_cwd-utils.js';
import { applyWorkspaceEdit } from './lsp-workspace-edit.js';
import type { ToolHandlerContext } from '../types.js';
import * as engine from './patch-apply-engine.js';

let root: string;
let client: LspClient | undefined;
beforeEach(async () => { root = realpathSafe(await mkdtemp(join(tmpdir(), 'afk-lsp-edit-integration-'))); });
afterEach(async () => {
  await client?.dispose();
  client = undefined;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('LSP WorkspaceEdit integration', () => {
  it.each(['changes', 'documentChanges'] as const)('applies one 3-file rename (%s), checkpoints and resyncs', async (form) => {
    const paths = ['definition.ts', 'caller.ts', 'test.ts'].map((name) => join(root, name));
    const contents = ['const foo = 1;\n', 'foo();\n', 'foo();\n'];
    await Promise.all(paths.map((p, i) => writeFile(p, contents[i]!)));
    const uri = (p: string) => pathToFileURL(p).toString();
    const documents = paths.map((p, i) => ({ textDocument: { uri: uri(p), version: 1 }, edits: [{
      range: { start: { line: 0, character: i === 0 ? 6 : 0 }, end: { line: 0, character: i === 0 ? 9 : 3 } }, newText: 'longName',
    }] }));
    const workspaceEdit = form === 'changes'
      ? { changes: Object.fromEntries(documents.map((d) => [d.textDocument.uri, d.edits])) }
      : { documentChanges: documents };
    const script = join(root, 'server.cjs');
    const logFile = join(root, 'server.jsonl');
    writeFakeLspServer(script, { workspaceEdit, logFile });
    client = await LspClient.start({ definition: TYPESCRIPT_SERVER_DEFINITION, command: process.execPath, args: [script], source: 'override' }, root, { timeoutMs: 5000 });
    for (const p of paths) await client.syncFile(p);
    const response = await client.request('textDocument/rename', { textDocument: { uri: uri(paths[0]!) }, position: { line: 0, character: 6 }, newName: 'longName' }, { timeoutMs: 5000 });
    const state = join(root, 'state');
    const context: ToolHandlerContext = { resolveBase: root, writeRoots: [root], fileCheckpoint: beginCheckpointTurn('session', 'turn', state) };
    const apply = vi.spyOn(engine, 'applyPatch');
    const result = await applyWorkspaceEdit(response, { cwd: root, context, client,
      documentVersion: (u) => client!.documentVersion(u), expectedContents: new Map(paths.map((p, i) => [uri(p), contents[i]!])),
    });
    expect(result.isError).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content).files_changed).toHaveLength(3);
    expect(await Promise.all(paths.map((p) => readFile(p, 'utf8')))).toEqual(contents.map((s) => s.replace('foo', 'longName')));
    const checkpoints = listTurnSnapshots('session', 'turn', state);
    expect(checkpoints.map((s) => s.absPath).sort()).toEqual([...paths].sort());
    for (const checkpoint of checkpoints) {
      expect(await readFile(checkpoint.snapshotPath, 'utf8')).toBe(contents[paths.indexOf(checkpoint.absPath)]);
    }
    // Request barrier flushes prior notifications through the real stdio pipe.
    await client.request('workspace/symbol', { query: 'longName' }, { timeoutMs: 3000 });
    const syncs = messagesWithMethod(logFile, 'textDocument/didChange');
    expect(syncs).toHaveLength(3);
    for (const [i, sync] of syncs.entries()) {
      expect(sync?.params.textDocument.version).toBe(2);
      expect(sync?.params.contentChanges[0].text).toBe(contents[i]!.replace('foo', 'longName'));
    }
    endCheckpointTurn('session', context.fileCheckpoint, state);
    // A later turn touches one renamed file and a previously untouched file.
    // Rewinding the rename turn must fold BOTH turns, retaining earliest snapshots.
    const laterPath = join(root, 'later.ts');
    await writeFile(laterPath, 'before\n');
    const later = { ...context, fileCheckpoint: beginCheckpointTurn('session', 'later-turn', state) };
    const laterResult = await applyWorkspaceEdit({ changes: {
      [uri(paths[1]!)]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: 'finalName' }],
      [uri(laterPath)]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'after' }],
    } }, { cwd: root, context: later, client });
    expect(laterResult.isError).toBe(false);
    endCheckpointTurn('session', later.fileCheckpoint, state);
    const deps = { sessionId: 'session', enableFileCheckpointing: true, _stateDir: state, writePolicy: context };
    const preview = await rewindFiles(deps, 'turn', { dryRun: true });
    expect(preview.canRewind).toBe(true);
    expect(preview.filesChanged?.sort()).toEqual([...paths, laterPath].sort());
    expect(await readFile(paths[1]!, 'utf8')).toBe('finalName();\n');
    expect(await readFile(laterPath, 'utf8')).toBe('after\n');
    const restored = await rewindFiles(deps, 'turn');
    expect(restored.canRewind).toBe(true);
    expect(restored.failures).toBeUndefined();
    expect(restored.conflicts).toBeUndefined();
    expect(restored.filesChanged?.sort()).toEqual([...paths, laterPath].sort());
    expect(await Promise.all(paths.map((p) => readFile(p, 'utf8')))).toEqual(contents);
    expect(await readFile(laterPath, 'utf8')).toBe('before\n');
  }, 15_000);
});
