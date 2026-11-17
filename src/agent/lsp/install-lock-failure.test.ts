import { mkdtemp, open, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireInstallLock, installLockPath } from './install.js';

describe('install lock sentinel write failure', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'afk-lsp-lock-failure-')); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each(['write', 'close'])('preserves a successor sentinel after a %s failure', async (failure) => {
    const lockFile = installLockPath('typescript', root);
    const peer = JSON.stringify({ pid: process.pid + 1, expiresAt: Date.now() + 300_000 });
    const error = new Error(`sentinel ${failure} failed`);
    let closeCalls = 0;
    const openFn: typeof open = async (file, flags) => {
      const fh = await open(file, flags);
      const close = fh.close.bind(fh);
      if (failure === 'write') vi.spyOn(fh, 'writeFile').mockRejectedValue(error);
      vi.spyOn(fh, 'close').mockImplementation(async () => {
        if (++closeCalls > 1) return;
        await close();
        // Another process reaps our sentinel and wins the exclusive create
        // while this process is closing its failed handle.
        await unlink(lockFile);
        await writeFile(lockFile, peer, { flag: 'wx' });
        if (failure === 'close') throw error;
      });
      return fh;
    };

    await expect(acquireInstallLock('typescript', undefined, { serversDir: root, openFn }))
      .rejects.toBe(error);
    expect(closeCalls).toBeGreaterThanOrEqual(1);
    expect(await readFile(lockFile, 'utf8')).toBe(peer);
  });

  it.each(['empty', 'partial', 'complete'])('recovers an abandoned %s sentinel through stale recovery', async (kind) => {
    const lockFile = installLockPath('typescript', root);
    const error = new Error('sentinel write failed');
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    const openFn: typeof open = async (file, flags) => {
      const fh = await open(file, flags);
      handles.push(fh);
      const write = fh.writeFile.bind(fh);
      vi.spyOn(fh, 'writeFile').mockImplementation(async (data) => {
        if (kind !== 'empty') await write(kind === 'partial' ? '{"pid":' : data, 'utf8');
        throw error;
      });
      return fh;
    };
    await expect(acquireInstallLock('typescript', undefined, { serversDir: root, openFn }))
      .rejects.toBe(error);
    expect(handles[0]?.fd).toBe(-1);
    const raw = await readFile(lockFile, 'utf8');
    if (kind === 'complete') expect(JSON.parse(raw).pid).toBe(process.pid);
    else expect(raw).toBe(kind === 'empty' ? '' : '{"pid":');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);
    const release = await acquireInstallLock('typescript', undefined, {
      serversDir: root, pollMs: 1, nowMs: () => Date.now() + 600_000,
    });
    expect(JSON.parse(await readFile(lockFile, 'utf8')).pid).toBe(process.pid);
    await release();
    await expect(readFile(lockFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
