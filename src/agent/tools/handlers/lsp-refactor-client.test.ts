import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LspClient } from '../../lsp/client.js';
import { TYPESCRIPT_SERVER_DEFINITION } from '../../lsp/typescript-default.js';
import { writeFakeLspServer } from '../../lsp/__test-utils__/fake-lsp-server.js';

let dir: string | undefined;
let client: LspClient | undefined;
afterEach(async () => {
  await client?.dispose();
  if (dir) await rm(dir, { recursive: true, force: true });
});
describe('scoped server workspace edits', () => {
  it('does not start queued edits after command authorization ends', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'afk-refactor-client-'));
    const script = path.join(dir, 'server.cjs');
    writeFakeLspServer(script, {});
    client = await LspClient.start({ definition: TYPESCRIPT_SERVER_DEFINITION, command: process.execPath,
      args: [script], source: 'override' }, dir);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    let queued!: Promise<{ applied: boolean }>;
    const scope = client.withWorkspaceEditHandler(async () => {
      calls++;
      await blocked;
      return { applied: true };
    }, async () => {
      // Exercise the same callback used by the JSON-RPC dispatcher, with
      // deterministic ordering rather than relying on socket timing.
      const dispatch = (client as unknown as {
        workspaceEditHandler: (edit: unknown) => Promise<{ applied: boolean }>;
      }).workspaceEditHandler;
      void dispatch({});
      queued = dispatch({});
      await Promise.resolve(); // first edit starts while authorized
      throw new Error('command timed out');
    });
    const failed = expect(scope).rejects.toThrow('command timed out');
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await failed;
    expect(await queued).toMatchObject({ applied: false });
    expect(calls).toBe(1);
  });
  it('denies unsolicited edits before and after command authorization and refuses overlapping scopes', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'afk-refactor-client-'));
    const script = path.join(dir, 'server.cjs');
    writeFakeLspServer(script, { commandEdit: { changes: {} }, capabilities: { renameProvider: true } });
    client = await LspClient.start({ definition: TYPESCRIPT_SERVER_DEFINITION, command: process.execPath,
      args: [script], source: 'override' }, dir);
    const execute = () => client!.request('workspace/executeCommand', { command: 'fake' }, { timeoutMs: 1000 });
    expect(client.serverCapabilities['renameProvider']).toBe(true);
    expect(await execute()).toEqual({ applied: false });
    let calls = 0;
    await client.withWorkspaceEditHandler(async () => { calls++; return { applied: true }; }, async () => {
      await expect(client!.withWorkspaceEditHandler(async () => ({ applied: true }), execute)).rejects.toThrow('Another workspace edit');
      expect(await execute()).toEqual({ applied: true });
    });
    expect(calls).toBe(1);
    expect(await execute()).toEqual({ applied: false });
  });
});
