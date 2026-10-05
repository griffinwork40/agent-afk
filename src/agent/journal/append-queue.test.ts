import * as fs from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getSessionBlobsDir, getSessionLedgerDir } from '../../paths.js';
import { useTmpAfkHome } from './__test-utils__/helpers.js';
import { JsonlFileAppender } from './append-queue.js';
import { BlobStore, makePendingBlob, readBlob } from './blobs.js';

const { home } = useTmpAfkHome();

describe('JsonlFileAppender', () => {
  it('recreates a directory removed after the first write and retries once', async () => {
    const path = join(home(), 'live', 'journal.jsonl');
    const a = new JsonlFileAppender(path);
    await a.write('one\n');
    fs.rmSync(join(home(), 'live'), { recursive: true, force: true }); // sweep / manual rm
    await a.write('two\n');
    await a.write('three\n');
    expect(fs.readFileSync(path, 'utf8')).toBe('two\nthree\n');
  });

  it('still surfaces non-ENOENT errors', async () => {
    const blocker = join(home(), 'blocker');
    fs.writeFileSync(blocker, 'x');
    const a = new JsonlFileAppender(join(blocker, 'journal.jsonl'));
    await expect(a.write('x\n')).rejects.toThrow();
  });
});

describe('BlobStore', () => {
  it('rewrites a blob whose session dir was removed after the first write', async () => {
    const store = new BlobStore();
    const blob = makePendingBlob('blob-sess', 'a'.repeat(64), Buffer.from('payload'), 'text/plain');
    await store.write(blob);
    expect(readBlob(blob.ref)?.toString()).toBe('payload');
    fs.rmSync(getSessionLedgerDir('blob-sess'), { recursive: true, force: true });
    await store.write(blob);
    expect(readBlob(blob.ref)?.toString()).toBe('payload');
    expect(fs.existsSync(getSessionBlobsDir('blob-sess'))).toBe(true);
  });

  it('dedupes concurrent writes of the same blob', async () => {
    const store = new BlobStore();
    const blob = makePendingBlob('blob-sess2', 'b'.repeat(64), Buffer.from('x'), 'text/plain');
    const p1 = store.write(blob);
    expect(store.write(blob)).toBe(p1);
    await p1;
  });
});
