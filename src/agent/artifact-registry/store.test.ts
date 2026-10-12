/**
 * Unit tests for the content-addressed artifact registry (#1415).
 *
 * All tests run under an isolated temp directory — no real ~/.afk writes.
 *
 * @module agent/artifact-registry/store.test
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  artifactPut,
  artifactGet,
  artifactList,
  artifactRead,
  artifactCount,
  compactIndex,
  listStoreBlobs,
} from './store.js';
import {
  getArtifactStoreDir,
  getArtifactIndexPath,
} from '../../paths.artifact.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let storeDir: string;
let indexPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(os.tmpdir(), 'afk-artifact-'));
  storeDir = getArtifactStoreDir(tmpDir);
  indexPath = getArtifactIndexPath(tmpDir);
  mkdirSync(storeDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// artifactPut — inline content
// ---------------------------------------------------------------------------

describe('artifactPut — inline content', () => {
  it('returns a record with correct fields for Buffer content', async () => {
    const content = Buffer.from('hello artifact');
    const rec = await artifactPut(
      { content, media_type: 'text/plain', retention: 'session' },
      storeDir,
      indexPath,
    );

    expect(rec.id).toMatch(/^art_[0-9a-f]{16}$/);
    expect(rec.hash).toBe(sha256(content));
    expect(rec.size).toBe(content.length);
    expect(rec.media_type).toBe('text/plain');
    expect(rec.retention).toBe('session');
    expect(rec.inputs).toEqual([]);
    expect(rec.tags).toEqual({});
    expect(typeof rec.created_at).toBe('number');
    expect(rec.uri).toContain(storeDir);
    expect(existsSync(rec.uri)).toBe(true);
  });

  it('returns a record for string content', async () => {
    const rec = await artifactPut(
      { content: '# Report\n\nHello', media_type: 'text/markdown' },
      storeDir,
      indexPath,
    );
    expect(rec.media_type).toBe('text/markdown');
    expect(readFileSync(rec.uri, 'utf8')).toBe('# Report\n\nHello');
  });

  it('stores the blob with hash-based filename', async () => {
    const buf = Buffer.from('blob content');
    const rec = await artifactPut(
      { content: buf, media_type: 'text/plain' },
      storeDir,
      indexPath,
    );
    const expectedName = `${sha256(buf)}.txt`;
    expect(rec.uri).toContain(expectedName);
    expect(existsSync(rec.uri)).toBe(true);
  });

  it('is idempotent for identical content', async () => {
    const buf = Buffer.from('same bytes');
    const rec1 = await artifactPut(
      { content: buf, media_type: 'text/plain' },
      storeDir,
      indexPath,
    );
    const rec2 = await artifactPut(
      { content: buf, media_type: 'text/plain' },
      storeDir,
      indexPath,
    );
    expect(rec1.id).toBe(rec2.id);
    expect(rec1.hash).toBe(rec2.hash);
    expect(rec1.uri).toBe(rec2.uri);
    // Both writes recorded in index.
    expect(artifactCount(indexPath)).toBe(1); // last-write-wins dedup
  });

  it('accepts producer metadata', async () => {
    const rec = await artifactPut(
      {
        content: Buffer.from('x'),
        media_type: 'text/plain',
        producer: { session_id: 'sess-abc', tool_name: 'browser_screenshot' },
      },
      storeDir,
      indexPath,
    );
    expect(rec.producer.session_id).toBe('sess-abc');
    expect(rec.producer.tool_name).toBe('browser_screenshot');
  });

  it('stores inputs and tags', async () => {
    const dep = await artifactPut(
      { content: Buffer.from('dep'), media_type: 'text/plain' },
      storeDir,
      indexPath,
    );
    const rec = await artifactPut(
      {
        content: Buffer.from('derived'),
        media_type: 'text/plain',
        inputs: [dep.id],
        tags: { env: 'test', kind: 'report' },
      },
      storeDir,
      indexPath,
    );
    expect(rec.inputs).toEqual([dep.id]);
    expect(rec.tags).toEqual({ env: 'test', kind: 'report' });
  });

  it('applies permanent retention', async () => {
    const rec = await artifactPut(
      { content: Buffer.from('keep me'), media_type: 'text/plain', retention: 'permanent' },
      storeDir,
      indexPath,
    );
    expect(rec.retention).toBe('permanent');
  });

  it('applies ttl retention', async () => {
    const rec = await artifactPut(
      { content: Buffer.from('ttl me'), media_type: 'text/plain', retention: 'ttl:86400000' },
      storeDir,
      indexPath,
    );
    expect(rec.retention).toBe('ttl:86400000');
  });
});

// ---------------------------------------------------------------------------
// artifactPut — file path
// ---------------------------------------------------------------------------

describe('artifactPut — file path', () => {
  it('registers an existing file and copies content into the store', async () => {
    const src = join(tmpDir, 'source.txt');
    writeFileSync(src, 'file content');

    const rec = await artifactPut(
      { path: src, media_type: 'text/plain' },
      storeDir,
      indexPath,
    );

    expect(rec.size).toBe(12);
    expect(readFileSync(rec.uri, 'utf8')).toBe('file content');
    // Original file untouched.
    expect(readFileSync(src, 'utf8')).toBe('file content');
  });

  it('infers media type from file extension when not supplied', async () => {
    const src = join(tmpDir, 'screenshot.png');
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const rec = await artifactPut({ path: src }, storeDir, indexPath);
    // Falls back to raw ext when media_type is absent
    expect(rec.media_type).toBe('png');
  });
});

// ---------------------------------------------------------------------------
// artifactGet
// ---------------------------------------------------------------------------

describe('artifactGet', () => {
  it('retrieves a record by id', async () => {
    const rec = await artifactPut(
      { content: Buffer.from('get me'), media_type: 'text/plain' },
      storeDir,
      indexPath,
    );
    const fetched = artifactGet(rec.id, indexPath);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(rec.id);
    expect(fetched!.hash).toBe(rec.hash);
  });

  it('returns undefined for an unknown id', () => {
    expect(artifactGet('art_0000000000000000', indexPath)).toBeUndefined();
  });

  it('returns undefined when the index does not exist', () => {
    expect(artifactGet('art_anything', join(tmpDir, 'nonexistent.jsonl'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// artifactList
// ---------------------------------------------------------------------------

describe('artifactList', () => {
  it('returns all records when no filter is applied', async () => {
    await artifactPut({ content: Buffer.from('a'), media_type: 'text/plain' }, storeDir, indexPath);
    await artifactPut({ content: Buffer.from('b'), media_type: 'text/plain' }, storeDir, indexPath);
    await artifactPut({ content: Buffer.from('c'), media_type: 'text/plain' }, storeDir, indexPath);
    expect(artifactList(undefined, indexPath)).toHaveLength(3);
  });

  it('filters by session_id', async () => {
    await artifactPut(
      { content: Buffer.from('s1'), media_type: 'text/plain', producer: { session_id: 'sess-1' } },
      storeDir,
      indexPath,
    );
    await artifactPut(
      { content: Buffer.from('s2'), media_type: 'text/plain', producer: { session_id: 'sess-2' } },
      storeDir,
      indexPath,
    );
    const results = artifactList({ session_id: 'sess-1' }, indexPath);
    expect(results).toHaveLength(1);
    expect(results[0]!.producer.session_id).toBe('sess-1');
  });

  it('filters by media_type', async () => {
    await artifactPut({ content: Buffer.from('img'), media_type: 'image/png' }, storeDir, indexPath);
    await artifactPut({ content: Buffer.from('txt'), media_type: 'text/plain' }, storeDir, indexPath);
    const results = artifactList({ media_type: 'image/png' }, indexPath);
    expect(results).toHaveLength(1);
    expect(results[0]!.media_type).toBe('image/png');
  });

  it('filters by retention', async () => {
    await artifactPut({ content: Buffer.from('perm'), media_type: 'text/plain', retention: 'permanent' }, storeDir, indexPath);
    await artifactPut({ content: Buffer.from('sess'), media_type: 'text/plain', retention: 'session' }, storeDir, indexPath);
    expect(artifactList({ retention: 'permanent' }, indexPath)).toHaveLength(1);
    expect(artifactList({ retention: 'session' }, indexPath)).toHaveLength(1);
  });

  it('filters by since / until', async () => {
    const before = Date.now();
    await artifactPut({ content: Buffer.from('x'), media_type: 'text/plain' }, storeDir, indexPath);
    const after = Date.now();
    const results = artifactList({ since: before, until: after }, indexPath);
    expect(results).toHaveLength(1);
    expect(artifactList({ since: after + 1 }, indexPath)).toHaveLength(0);
  });

  it('filters by tag', async () => {
    await artifactPut(
      { content: Buffer.from('tagged'), media_type: 'text/plain', tags: { kind: 'report' } },
      storeDir,
      indexPath,
    );
    await artifactPut(
      { content: Buffer.from('other'), media_type: 'text/plain', tags: { kind: 'log' } },
      storeDir,
      indexPath,
    );
    const results = artifactList({ tag: { key: 'kind', value: 'report' } }, indexPath);
    expect(results).toHaveLength(1);
  });

  it('respects the limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await artifactPut({ content: Buffer.from(`item-${i}`), media_type: 'text/plain' }, storeDir, indexPath);
    }
    expect(artifactList({ limit: 3 }, indexPath)).toHaveLength(3);
  });

  it('returns results sorted by created_at ascending', async () => {
    for (let i = 0; i < 3; i++) {
      await artifactPut({ content: Buffer.from(`ord-${i}`), media_type: 'text/plain' }, storeDir, indexPath);
    }
    const results = artifactList(undefined, indexPath);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.created_at).toBeGreaterThanOrEqual(results[i - 1]!.created_at);
    }
  });

  it('returns empty array when index does not exist', () => {
    expect(artifactList(undefined, join(tmpDir, 'no.jsonl'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// artifactRead
// ---------------------------------------------------------------------------

describe('artifactRead', () => {
  it('returns the artifact content as a Buffer', async () => {
    const content = Buffer.from('read me back');
    const rec = await artifactPut({ content, media_type: 'text/plain' }, storeDir, indexPath);
    const back = await artifactRead(rec.id, indexPath);
    expect(back).toEqual(content);
  });

  it('throws for an unknown id', async () => {
    await expect(artifactRead('art_0000000000000000', indexPath)).rejects.toThrow(
      'Artifact not found: art_0000000000000000',
    );
  });
});

// ---------------------------------------------------------------------------
// artifactCount
// ---------------------------------------------------------------------------

describe('artifactCount', () => {
  it('returns 0 when the index does not exist', () => {
    expect(artifactCount(join(tmpDir, 'empty.jsonl'))).toBe(0);
  });

  it('returns the number of unique artifacts', async () => {
    await artifactPut({ content: Buffer.from('one'), media_type: 'text/plain' }, storeDir, indexPath);
    await artifactPut({ content: Buffer.from('two'), media_type: 'text/plain' }, storeDir, indexPath);
    expect(artifactCount(indexPath)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// compactIndex
// ---------------------------------------------------------------------------

describe('compactIndex', () => {
  it('rewrites the index keeping one record per id', async () => {
    const buf = Buffer.from('compact me');
    // Write same content twice to get two index lines for the same id.
    await artifactPut({ content: buf, media_type: 'text/plain' }, storeDir, indexPath);
    await artifactPut({ content: buf, media_type: 'text/plain' }, storeDir, indexPath);

    const rawBefore = readFileSync(indexPath, 'utf8').trim().split('\n');
    expect(rawBefore.length).toBe(2); // two lines (same id, two appends)

    await compactIndex(indexPath);

    const rawAfter = readFileSync(indexPath, 'utf8').trim().split('\n');
    expect(rawAfter.length).toBe(1); // compacted to one
    expect(JSON.parse(rawAfter[0]!).id).toBe(`art_${sha256(buf).slice(0, 16)}`);
  });

  it('is a no-op on an empty index', async () => {
    writeFileSync(indexPath, '');
    await compactIndex(indexPath);
    expect(readFileSync(indexPath, 'utf8')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// listStoreBlobs
// ---------------------------------------------------------------------------

describe('listStoreBlobs', () => {
  it('returns empty array when store dir does not exist', () => {
    expect(listStoreBlobs(join(tmpDir, 'nonexistent'))).toEqual([]);
  });

  it('returns blob filenames after puts', async () => {
    await artifactPut({ content: Buffer.from('blob1'), media_type: 'text/plain' }, storeDir, indexPath);
    await artifactPut({ content: Buffer.from('blob2'), media_type: 'text/plain' }, storeDir, indexPath);
    const blobs = listStoreBlobs(storeDir);
    expect(blobs).toHaveLength(2);
    expect(blobs.every((b) => /^[a-f0-9]{64}\.txt$/.test(b))).toBe(true);
  });

  it('does not include temp files', async () => {
    await artifactPut({ content: Buffer.from('real'), media_type: 'text/plain' }, storeDir, indexPath);
    // Simulate a leftover temp file.
    writeFileSync(join(storeDir, '.tmp-abcdef'), 'partial');
    const blobs = listStoreBlobs(storeDir);
    expect(blobs.every((b) => !b.startsWith('.'))).toBe(true);
  });
});
