import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactPublishHandler } from './artifact-publish.js';
import { createArtifactHandlers } from './artifact.js';
import { artifactGet } from '../../artifact-registry/store.js';
import { env } from '../../../config/env.js';
import { CHILD_ALLOWED_TOOLS } from '../nesting.js';
import { builtinToolSchemas } from '../schemas.js';

let root: string;
let storeDir: string;
let indexPath: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'afk-artifact-publish-'));
  storeDir = join(root, 'store');
  indexPath = join(root, 'index.jsonl');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function makeHandler(opts?: { cwd?: string }) {
  return createArtifactPublishHandler({ storeDir, indexPath, ...opts });
}
async function call(input: unknown, context?: Record<string, unknown>) {
  return makeHandler()(input, signal, context as never);
}
async function json(input: unknown, context?: Record<string, unknown>) {
  const result = await call(input, context);
  expect(result.isError, result.content as string).toBeUndefined();
  return JSON.parse(result.content as string);
}

describe('artifact_publish schema and nesting wiring', () => {
  it('is included in CHILD_ALLOWED_TOOLS', () => {
    expect(CHILD_ALLOWED_TOOLS).toContain('artifact_publish');
  });

  it('has category=write and concurrencySafe=false in builtinToolSchemas', () => {
    const schema = builtinToolSchemas.find(t => t.name === 'artifact_publish');
    expect(schema).toBeDefined();
    expect(schema?.category).toBe('write');
    expect(schema?.concurrencySafe).toBe(false);
  });

  it('is registered in createArtifactHandlers', () => {
    const handlers = createArtifactHandlers({ storeDir, indexPath });
    expect(handlers.has('artifact_publish')).toBe(true);
  });
});

describe('artifact_publish inline content', () => {
  it('registers inline text and returns bounded metadata', async () => {
    const result = await json({ content: 'hello world', media_type: 'text/plain' });
    expect(result.id).toMatch(/^art_[0-9a-f]{32}$/);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.size).toBe(11);
    expect(result.media_type).toBe('text/plain');
    expect(result.uri).toContain(storeDir);
    expect(result.retention).toBe('session');
    expect(result.producer.tool_name).toBe('artifact_publish');
    // Tags and inputs must NOT be echoed back
    expect(result.tags).toBeUndefined();
    expect(result.inputs).toBeUndefined();
  });

  it('defaults the MIME type for inline content when omitted', async () => {
    const result = await json({ content: 'default type' });
    expect(result.media_type).toBe('application/octet-stream');
  });

  it('accepts exactly 64 KiB of multi-byte UTF-8 content', async () => {
    const result = await json({ content: '😀'.repeat(16 * 1024), media_type: 'text/plain' });
    expect(result.size).toBe(64 * 1024);
  });

  it('accepts bounded tags at the key, value and count limits', async () => {
    const tags = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [
      String(i).padEnd(256, 'k'), 'v'.repeat(256),
    ]));
    const result = await json({ content: 'tag bounds', tags });
    expect(artifactGet(result.id, indexPath)?.tags).toEqual(tags);
  });

  it('assigns permanent retention when requested', async () => {
    const result = await json({ content: 'keep me', media_type: 'text/plain', retention: 'permanent' });
    expect(result.retention).toBe('permanent');
  });

  it('assigns ttl retention when requested', async () => {
    const result = await json({ content: 'ttl content', media_type: 'text/plain', retention: 'ttl:86400000' });
    expect(result.retention).toBe('ttl:86400000');
  });

  it('records lineage inputs in the index (not returned to caller)', async () => {
    const a = await json({ content: 'src', media_type: 'text/plain' });
    const b = await json({ content: 'derived', media_type: 'text/plain', inputs: [a.id] });
    // The returned metadata does not echo inputs.
    expect(b.inputs).toBeUndefined();
    // But the index record should have the lineage.
    const record = artifactGet(b.id, indexPath);
    expect(record?.inputs).toEqual([a.id]);
  });

  it('content-identical inputs share the same stable ID', async () => {
    const a = await json({ content: 'same', media_type: 'text/plain' });
    const b = await json({ content: 'same', media_type: 'text/plain' });
    expect(a.id).toBe(b.id);
  });
});

describe('artifact_publish path input', () => {
  it('registers an existing file accessible to the session', async () => {
    const filePath = join(root, 'report.md');
    await writeFile(filePath, '# Report\nContent here.');
    const result = await json(
      { path: filePath, media_type: 'text/markdown' },
      { resolveBase: root, readRoots: [root] },
    );
    expect(result.id).toMatch(/^art_[0-9a-f]{32}$/);
    expect(result.media_type).toBe('text/markdown');
    expect(result.size).toBeGreaterThan(0);
    // Blob must have been written to the store.
    await expect(stat(result.uri)).resolves.toBeTruthy();
  });

  it('rejects a path outside the session read roots', async () => {
    const filePath = join(root, 'secret.txt');
    await writeFile(filePath, 'private');
    // Use a narrow handler cwd that does NOT contain root so resolveAndContain
    // enforces containment.  resolveBase = root (so the path resolves), but
    // readRoots = ['/nonexistent'] so the resolved path falls outside every root.
    const narrowHandler = createArtifactPublishHandler({
      storeDir,
      indexPath,
      cwd: join(root, 'subdir'),
    });
    const result = await narrowHandler(
      { path: filePath, media_type: 'text/plain' },
      signal,
      { resolveBase: root, readRoots: [join(root, 'subdir')] } as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('artifact_publish: source path is not accessible');
  });

  it('rejects a directory path', async () => {
    const result = await call(
      { path: root, media_type: 'text/plain' },
      { resolveBase: root, readRoots: [root] },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('regular file');
  });

  it('rejects a non-existent path', async () => {
    const result = await call(
      { path: join(root, 'missing.txt'), media_type: 'text/plain' },
      { resolveBase: root, readRoots: [root] },
    );
    expect(result.isError).toBe(true);
  });
});

describe('artifact_publish input validation', () => {
  it('rejects when neither path nor content is supplied', async () => {
    const result = await call({ media_type: 'text/plain' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('artifact_publish:');
  });

  it('rejects when both path and content are supplied', async () => {
    const result = await call({ path: '/tmp/x', content: 'inline', media_type: 'text/plain' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('artifact_publish:');
  });

  it('rejects inline content exceeding 64 KiB', async () => {
    const result = await call({ content: 'x'.repeat(64 * 1024 + 1), media_type: 'text/plain' });
    expect(result.isError).toBe(true);
  });

  it.each(['é', '界', '😀'])('rejects content above 64 KiB in UTF-8 bytes (%s)', async (character) => {
    const content = character.repeat(Math.floor(64 * 1024 / Buffer.byteLength(character)) + 1);
    const result = await call({ content, media_type: 'text/plain' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('UTF-8 bytes');
  });

  it.each([
    { ['k'.repeat(257)]: 'value' },
    { key: 'v'.repeat(257) },
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, 'value'])),
  ])('rejects oversized tags (%j)', async (tags) => {
    const result = await call({ content: 'hi', tags });
    expect(result.isError).toBe(true);
    await expect(stat(indexPath)).rejects.toThrow();
  });

  it('rejects an invalid retention value', async () => {
    const result = await call({ content: 'hi', media_type: 'text/plain', retention: 'never' });
    expect(result.isError).toBe(true);
  });

  it('rejects malformed artifact IDs in inputs', async () => {
    const result = await call({ content: 'hi', media_type: 'text/plain', inputs: ['not-an-id'] });
    expect(result.isError).toBe(true);
  });

  it('rejects more than 16 inputs', async () => {
    const inputs = Array.from({ length: 17 }, (_, i) => `art_${'0'.repeat(30)}${String(i).padStart(2, '0')}`);
    const result = await call({ content: 'hi', media_type: 'text/plain', inputs });
    expect(result.isError).toBe(true);
  });
});

describe('artifact_publish quota admission', () => {
  it('enforces AFK_ARTIFACT_SESSION_LIMIT per session', async () => {
    // Use a very low cap via the env mock.
    const envModule = { env };
    const original = Object.getOwnPropertyDescriptor(envModule.env, 'AFK_ARTIFACT_SESSION_LIMIT');

    // Create a low-quota handler with its own counter by calling the factory
    // repeatedly in the same session. We test via the module-level counter.
    // Build a handler instance and exhaust it by publishing up to the cap.
    const sessionId = `test-quota-${Date.now()}`;
    const ctx = { sessionId };

    // Publish DEFAULT_SESSION_LIMIT items — succeeds.
    // We use a very small inline content and a small effective limit by
    // faking env reads through vi.spyOn.
    vi.spyOn(envModule.env, 'AFK_ARTIFACT_SESSION_LIMIT', 'get').mockReturnValue('2');
    try {
      const h = makeHandler();
      const r1 = await h({ content: 'a', media_type: 'text/plain' }, signal, ctx as never);
      const r2 = await h({ content: 'b', media_type: 'text/plain' }, signal, ctx as never);
      expect(r1.isError).toBeUndefined();
      expect(r2.isError).toBeUndefined();
      // Third call must be rejected.
      const r3 = await h({ content: 'c', media_type: 'text/plain' }, signal, ctx as never);
      expect(r3.isError).toBe(true);
      expect(r3.content).toContain('cap reached');
    } finally {
      if (original) Object.defineProperty(envModule.env, 'AFK_ARTIFACT_SESSION_LIMIT', original);
      vi.restoreAllMocks();
    }
  });

  it('shares a process-wide fallback quota when sessionId is absent', async () => {
    vi.resetModules();
    const { env } = await import('../../../config/env.js');
    const { createArtifactPublishHandler: create } = await import('./artifact-publish.js');
    vi.spyOn(env, 'AFK_ARTIFACT_SESSION_LIMIT', 'get').mockReturnValue('1');
    try {
      const first = await create({ storeDir, indexPath })({ content: 'fallback' }, signal);
      expect(first.isError).toBeUndefined();
      expect(JSON.parse(first.content as string).producer.session_id).toBeUndefined();
      const second = await create({ storeDir, indexPath })({ content: 'fallback2' }, signal, {} as never);
      expect(second.isError).toBe(true);
      expect(second.content).toContain('cap reached');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reserves the last slot before concurrent path validation awaits', async () => {
    vi.spyOn(env, 'AFK_ARTIFACT_SESSION_LIMIT', 'get').mockReturnValue('1');
    try {
      const filePath = join(root, 'concurrent.txt');
      await writeFile(filePath, 'concurrent');
      const ctx = { sessionId: root, resolveBase: root, readRoots: [root] };
      const results = await Promise.all(Array.from({ length: 2 }, () =>
        makeHandler()({ path: filePath }, signal, ctx as never)));
      expect(results.filter(result => !result.isError)).toHaveLength(1);
      expect(results.filter(result => result.isError)).toHaveLength(1);
      expect(results.find(result => result.isError)?.content).toContain('cap reached');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each(['authorization', 'directory', 'stat', 'store'])('releases quota after %s failure', async (failure) => {
    vi.spyOn(env, 'AFK_ARTIFACT_SESSION_LIMIT', 'get').mockReturnValue('1');
    try {
      const ctx = { sessionId: root, resolveBase: root, readRoots: [root] };
      const h = makeHandler();
      const path = failure === 'directory' ? root : join(root, 'missing.txt');
      const failedHandler = failure === 'store'
        ? createArtifactPublishHandler({ storeDir, indexPath: root })
        : failure === 'authorization' ? makeHandler({ cwd: join(root, 'narrow') }) : h;
      const failed = await failedHandler(
        failure === 'store' ? { content: 'store failure' } : { path }, signal,
        (failure === 'authorization' ? { ...ctx, readRoots: [join(root, 'narrow')] } : ctx) as never,
      );
      expect(failed.isError).toBe(true);
      const result = await h({ content: 'after failure' }, signal, ctx as never);
      expect(result.isError, result.content as string).toBeUndefined();
      const capped = await h({ content: 'over cap' }, signal, ctx as never);
      expect(capped.isError).toBe(true);
      expect(capped.content).toContain('cap reached');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('artifact_publish abort handling', () => {
  it('returns isError when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const h = makeHandler();
    const result = await h({ content: 'x', media_type: 'text/plain' }, ctrl.signal);
    expect(result.isError).toBe(true);
  });
});
