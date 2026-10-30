import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactHandlers } from './artifact.js';
import { artifactPut } from '../../artifact-registry/store.js';
import type { ToolHandlerContext } from '../types.js';
import { createBuiltinHandlers } from './index.js';
import { builtinToolSchemas } from '../schemas.js';
import { CHILD_ALLOWED_TOOLS, RECON_ALLOWED_TOOLS } from '../nesting.js';

let root: string;
let storeDir: string;
let indexPath: string;
let handlers: ReturnType<typeof createArtifactHandlers>;
const signal = new AbortController().signal;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'afk-artifact-tools-'));
  storeDir = join(root, 'store');
  indexPath = join(root, 'index.jsonl');
  handlers = createArtifactHandlers({ storeDir, indexPath });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function put(content = 'hello artifact', media_type = 'text/plain') {
  return artifactPut({ content, media_type, producer: { session_id: 'session-a', tool_name: 'report' } }, storeDir, indexPath);
}
async function call(name: string, input: unknown, context?: ToolHandlerContext) {
  return handlers.get(name)!(input, signal, context);
}
async function json(name: string, input: unknown, context?: ToolHandlerContext) {
  const result = await call(name, input, context);
  expect(result.isError, result.content as string).toBeUndefined();
  return JSON.parse(result.content as string);
}

describe('artifact read surface', () => {
  it('registers read-only schemas and real builtins for root and child providers', () => {
    const builtins = createBuiltinHandlers();
    for (const name of ['artifact_get', 'artifact_list', 'artifact_read']) {
      expect(builtins.has(name)).toBe(true);
      expect(CHILD_ALLOWED_TOOLS).toContain(name);
      expect(RECON_ALLOWED_TOOLS).toContain(name);
      expect(builtinToolSchemas.find(t => t.name === name)).toMatchObject({ category: 'read', concurrencySafe: true });
    }
  });

  it('gets persisted bounded metadata without arbitrary tags or content', async () => {
    const rec = await artifactPut({ content: 'secret text', media_type: 'text/plain', tags: { huge: 'x'.repeat(50000) } }, storeDir, indexPath);
    handlers = createArtifactHandlers({ storeDir, indexPath }); // fresh session/adapter
    const result = await json('artifact_get', { id: rec.id });
    expect(result).toMatchObject({ id: rec.id, uri: rec.uri, hash: rec.hash, size: rec.size });
    expect(result.tags).toBeUndefined();
    expect(result.content).toBeUndefined();
  });

  it('reads bounded byte slices with continuation offsets', async () => {
    const rec = await put('0123456789');
    expect(await json('artifact_read', { id: rec.id, offset: 2, limit: 3 })).toMatchObject({
      content: '234', bytes_read: 3, truncated: true, next_offset: 5, read_path: rec.uri,
    });
    expect(await json('artifact_read', { id: rec.id, offset: 10 })).toMatchObject({ content: '', truncated: false });
    expect(await json('artifact_read', { id: rec.id, offset: 50 })).toMatchObject({ content: '', truncated: false });
  });

  it('caps the default read and rejects an oversized requested limit', async () => {
    const rec = await put('x'.repeat(60000));
    const result = await json('artifact_read', { id: rec.id });
    expect(result.bytes_read).toBe(4096);
    expect(result.content).toHaveLength(4096);
    expect((await call('artifact_read', { id: rec.id, limit: 16385 })).isError).toBe(true);
  });

  it('returns only metadata/read path for large text and binary blobs', async () => {
    for (const [content, media, reason] of [
      ['x'.repeat(65537), 'text/plain', 'large'],
      ['image bytes', 'image/png', 'binary'],
      ['null\0byte', 'text/plain', 'binary'],
    ]) {
      const rec = await put(content, media);
      const result = await json('artifact_read', { id: rec.id });
      expect(result).toMatchObject({ read_path: rec.uri, contentOmitted: reason });
      expect(result.content).toBeUndefined();
    }
  });

  it('filters by producer, media type and registration dates', async () => {
    const rec = await put();
    await artifactPut({ content: 'other', media_type: 'image/png', producer: { session_id: 'session-b' } }, storeDir, indexPath);
    const result = await json('artifact_list', { session_id: 'session-a', tool_name: 'report', media_type: 'text/plain', since: rec.created_at, until: rec.created_at });
    expect(result.artifacts.map((r: { id: string }) => r.id)).toEqual([rec.id]);
    expect((await json('artifact_list', { since: rec.created_at + 10000 })).count).toBe(0);
  });

  it('limits list results and signals truncation', async () => {
    await put('a'); await put('b');
    const result = await json('artifact_list', { limit: 1 });
    expect(result.count).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('bounds the entire list JSON even with maximum-size producer fields', async () => {
    for (let n = 0; n < 30; n++) {
      await artifactPut({ content: `entry-${n}`, media_type: 'text/plain', producer: {
        session_id: '界'.repeat(256), subagent_id: '界'.repeat(256),
        task_id: '界'.repeat(256), tool_name: '界'.repeat(256),
      } }, storeDir, indexPath);
    }
    const result = await call('artifact_list', { limit: 100 });
    expect(Buffer.byteLength(result.content as string, 'utf8')).toBeLessThanOrEqual(32768);
    expect(JSON.parse(result.content as string).truncated).toBe(true);
  });

  it('returns null for absent IDs and rejects malformed inputs', async () => {
    for (const name of ['artifact_get', 'artifact_read']) {
      expect(await json(name, { id: `art_${'0'.repeat(32)}` })).toBeNull();
      expect((await call(name, { id: '../index' })).isError).toBe(true);
    }
    for (const input of [{ limit: 0 }, { limit: Infinity }, { limit: 101 }, { since: NaN }]) {
      expect((await call('artifact_list', input)).isError).toBe(true);
    }
  });

  it('rejects oversized indexes before parsing even for a single lookup', async () => {
    const rec = await put();
    await writeFile(indexPath, ' '.repeat(8 * 1024 * 1024 + 1));
    for (const name of ['artifact_get', 'artifact_list', 'artifact_read']) {
      const result = await call(name, { id: rec.id });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('index exceeds tool read limit');
    }
  });

  it('skips malformed producer records before filtered listing', async () => {
    const rec = await put();
    const before = await readFile(indexPath, 'utf8');
    await writeFile(indexPath, before + JSON.stringify({ id: 'art_broken', producer: null }) + '\n');
    const result = await json('artifact_list', { session_id: 'session-a' });
    expect(result.artifacts.map((r: { id: string }) => r.id)).toEqual([rec.id]);
  });

  it('documents byte-slice decoding when a multibyte character is split', async () => {
    const rec = await put('a€b');
    expect(await json('artifact_read', { id: rec.id, offset: 1, limit: 1 })).toMatchObject({
      content: '\uFFFD', bytes_read: 1, next_offset: 2,
    });
  });

  it('does not read after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await handlers.get('artifact_list')!({}, controller.signal);
    expect(result.isError).toBe(true);
  });
});

describe('artifact authorization', () => {
  it('does not let IDs bypass actor read roots, including factory fallback cwd', async () => {
    const rec = await put();
    const denied = { resolveBase: root, readRoots: [] };
    for (const name of ['artifact_get', 'artifact_read']) {
      expect((await call(name, { id: rec.id }, denied)).isError).toBe(true);
    }
    expect((await json('artifact_list', {}, denied)).artifacts).toEqual([]);
    handlers = createArtifactHandlers({ storeDir, indexPath, cwd: join(root, 'ungranted') });
    expect((await call('artifact_read', { id: rec.id })).isError).toBe(true);
    expect(await json('artifact_get', { id: rec.id }, { resolveBase: root, readRoots: [storeDir] })).toMatchObject({ id: rec.id });
  });

  it('rejects malicious index URIs even for unconfined callers', async () => {
    const rec = await put();
    await writeFile(indexPath, JSON.stringify({ ...rec, uri: join(root, 'private.txt') }) + '\n');
    expect((await call('artifact_read', { id: rec.id })).isError).toBe(true);
    expect((await json('artifact_list', {})).artifacts).toEqual([]);
  });

  it('rejects redirected symlink blobs', async () => {
    const rec = await put();
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'private contents');
    await rm(rec.uri);
    await symlink(outside, rec.uri);
    expect((await call('artifact_read', { id: rec.id }, { allowAll: true })).isError).toBe(true);
  });

  it('rejects size mismatches instead of trusting stale metadata', async () => {
    const rec = await put();
    await writeFile(rec.uri, 'changed');
    expect((await call('artifact_read', { id: rec.id })).isError).toBe(true);
  });

  it('does not mutate registry or blobs on reads', async () => {
    const rec = await put();
    const before = await readFile(indexPath, 'utf8');
    await json('artifact_get', { id: rec.id }); await json('artifact_list', {}); await json('artifact_read', { id: rec.id });
    expect(await readFile(indexPath, 'utf8')).toBe(before);
    expect(await readFile(rec.uri, 'utf8')).toBe('hello artifact');
  });
});
