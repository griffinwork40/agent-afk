import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_SUBAGENT_ATTACHMENT_BYTES,
  MAX_SUBAGENT_ATTACHMENT_COUNT,
  resolveSubagentAttachments,
} from './attachment-resolve.js';

describe('resolveSubagentAttachments', () => {
  it('resolves supported files under the read-root policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-att-'));
    const path = join(root, 'a.webp');
    await writeFile(path, Buffer.from('image'));
    await expect(
      resolveSubagentAttachments({ paths: [path], resolveBase: root, readRoots: [root] }),
    ).resolves.toEqual([{ mediaType: 'image/webp', bytes: Buffer.from('image') }]);
  });

  it('rejects unsupported extensions and paths outside readable roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-att-'));
    const outside = await mkdtemp(join(tmpdir(), 'afk-att-out-'));
    const txt = join(root, 'a.txt');
    const png = join(outside, 'a.png');
    await writeFile(txt, 'x');
    await writeFile(png, 'x');
    await expect(
      resolveSubagentAttachments({ paths: [txt], resolveBase: root, readRoots: [root] }),
    ).rejects.toThrow(/Unsupported image attachment.*a\.txt/);
    await expect(
      resolveSubagentAttachments({ paths: [png], resolveBase: root, readRoots: [root] }),
    ).rejects.toThrow(/outside the allowed read roots/);
  });

  it('enforces the named count and decoded-byte caps', async () => {
    await expect(
      resolveSubagentAttachments({
        paths: Array(MAX_SUBAGENT_ATTACHMENT_COUNT + 1).fill('/tmp/a.png') as string[],
        resolveBase: undefined,
        readRoots: undefined,
      }),
    ).rejects.toThrow(/at most 8/);

    const root = await mkdtemp(join(tmpdir(), 'afk-att-'));
    const huge = join(root, 'huge.png');
    await writeFile(huge, Buffer.alloc(MAX_SUBAGENT_ATTACHMENT_BYTES + 1));
    await expect(
      resolveSubagentAttachments({ paths: [huge], resolveBase: root, readRoots: [root] }),
    ).rejects.toThrow(/5 MiB/);
  });

  it('rejects an oversized file via stat, before its bytes enter memory', async () => {
    // Contract: this file is SPARSE and deliberately larger than Node's maximum
    // buffer length — truncate() allocates no real blocks, and a readFile() of
    // it would fail with ERR_FS_FILE_TOO_LARGE rather than the cap message. So
    // observing the 5 MiB cap error here proves the stat() guard rejected the
    // path before any read was attempted. Do not "fix" this into a real write:
    // the sparseness is the assertion mechanism, not a shortcut.
    const root = await mkdtemp(join(tmpdir(), 'afk-att-'));
    const sparse = join(root, 'sparse.png');
    const handle = await open(sparse, 'w');
    try {
      await handle.truncate(3 * 1024 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    await expect(
      resolveSubagentAttachments({ paths: [sparse], resolveBase: root, readRoots: [root] }),
    ).rejects.toThrow(/5 MiB/);
  });
});
