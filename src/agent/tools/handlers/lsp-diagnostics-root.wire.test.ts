import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteFileHandler } from './write-file.js';
import { createEditFileHandler } from './edit-file.js';
import { appendLspDiagnostics } from './lsp-diagnostics.js';
vi.mock('./lsp-diagnostics.js', () => ({ appendLspDiagnostics: vi.fn(async () => '') }));
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-root-'))); vi.clearAllMocks(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('post-write diagnostics uses shared session root', () => {
  it.each(['write', 'edit'] as const)('%s forwards the live context root rather than the nested file directory', async kind => {
    const live = join(root, 'live'); await mkdir(join(live, 'nested'), { recursive: true });
    const file = join(live, 'nested', 'a.ts'); await writeFile(file, 'before');
    const handler = kind === 'write' ? createWriteFileHandler(root) : createEditFileHandler(root);
    const args = kind === 'write' ? { file_path: file, content: 'after' } : { file_path: file, old_string: 'before', new_string: 'after' };
    const result = await handler(args, new AbortController().signal, { resolveBase: live, writeRoots: [live] });
    expect(result.isError).not.toBe(true);
    expect(appendLspDiagnostics).toHaveBeenCalledWith(file, undefined, live);
  });
  it.each(['write', 'edit'] as const)('%s falls back to its factory root outside dispatcher context', async kind => {
    const file = join(root, 'a.ts'); await writeFile(file, 'before');
    const handler = kind === 'write' ? createWriteFileHandler(root) : createEditFileHandler(root);
    const result = await handler(kind === 'write' ? { file_path: file, content: 'after' } : { file_path: file, old_string: 'before', new_string: 'after' }, new AbortController().signal);
    expect(result.isError).not.toBe(true);
    expect(appendLspDiagnostics).toHaveBeenCalledWith(file, undefined, root);
  });
});
