/**
 * Content-addressed artifact registry (#1415).
 *
 * Layout under `$AFK_STATE_DIR/artifacts/`:
 *
 *   artifacts/
 *     store/          immutable content blobs, named <sha256>.<ext>
 *     index.jsonl     append-only NDJSON index; last record per id wins
 *
 * Design invariants
 * -----------------
 * 1. Immutability: once a blob lands in `store/` it is never overwritten.
 *    Concurrent writers racing on the same hash use exclusive-create + rename
 *    so the final name always holds complete content (same pattern as
 *    `src/agent/journal/blobs.ts`).
 * 2. Atomicity: index records are appended atomically via a write + rename
 *    to a sibling temp file.  A torn append leaves a blank or partial line
 *    that `readIndex()` skips.
 * 3. Additive only: no wiring into existing hot paths.  All exports are
 *    new symbols; nothing in this module imports from a feature module.
 * 4. Failure isolation: callers that wrap `artifactPut()` in a
 *    best-effort try/catch will never block a turn — consistent with the
 *    contract in `src/utils/artifact-failure-reporter.ts`.
 * 5. 350-code-line ceiling: this file is kept well under that limit.
 *
 * @module agent/artifact-registry/store
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  appendFile,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';
import { extname, join } from 'node:path';
import { getArtifactStoreDir, getArtifactIndexPath } from '../../paths.artifact.js';
import { isErrnoCode } from '../../utils/errors.js';
import type {
  ArtifactListFilter,
  ArtifactPutOptions,
  ArtifactRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Hex SHA-256 of a Buffer. */
function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Stream SHA-256 of a file without loading it fully into memory. */
async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk as Buffer))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** File extension inferred from a media type or existing filename. */
function extForMediaType(mediaType: string): string {
  const MAP: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'text/markdown': 'md',
    'text/plain': 'txt',
    'application/json': 'json',
    'application/pdf': 'pdf',
    'application/octet-stream': 'bin',
    'text/html': 'html',
    'text/csv': 'csv',
  };
  const key = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (MAP[key]) return MAP[key]!;
  const sub = key.split('/')[1] ?? '';
  return sub.replace(/[^a-z0-9]/g, '').slice(0, 16) || 'bin';
}

/** Derive a stable artifact ID from its content hash (32 hex = 128-bit). */
function idFromHash(hash: string): string {
  return `art_${hash.slice(0, 32)}`;
}

/** Ensure store and index parent directories exist (sync, idempotent). */
function ensureDirs(storeDir: string, indexPath: string): void {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(indexPath, '..'), { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Blob persistence
// ---------------------------------------------------------------------------

/**
 * Copy or materialise content into the immutable store.
 *
 * Returns the absolute path of the stored blob.  Concurrent writers on the
 * same hash are safe: the exclusive-create temp + rename pattern means only
 * one writer commits and the rest harmlessly discover EEXIST.
 */
async function persistBlob(
  storeDir: string,
  hash: string,
  ext: string,
  source: { kind: 'path'; path: string } | { kind: 'buffer'; buf: Buffer },
): Promise<string> {
  const blobName = `${hash}.${ext}`;
  const blobPath = join(storeDir, blobName);

  if (existsSync(blobPath)) return blobPath;

  const tmpName = join(storeDir, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    // Exclusive-create for both branches: if concurrent writer raced us, open throws EEXIST.
    const fh = await open(tmpName, 'wx', 0o600);
    try {
      if (source.kind === 'path') {
        await fh.writeFile(readFileSync(source.path));
      } else {
        await fh.writeFile(source.buf);
      }
    } finally {
      await fh.close();
    }
    try {
      await rename(tmpName, blobPath);
    } catch (err) {
      // Invariant: this store is content-addressed — every blob is named by its
      // SHA-256 hash, so a blob that already exists at `blobPath` is byte-for-byte
      // identical to the content we are trying to write.  It is therefore safe to
      // treat any error that leaves a complete blob at `blobPath` as a harmless
      // collision with a concurrent writer that won the race.
      //
      // Tolerated codes:
      //   EEXIST / ENOTEMPTY — POSIX: destination already exists (concurrent winner).
      //   EPERM  / EACCES    — Windows rename-collision shape: renaming onto a
      //     destination that a concurrent writer is still renaming or has open
      //     yields EPERM (-4048) or EACCES (-4092) instead of EEXIST.  We
      //     tolerate these ONLY when `existsSync(blobPath)` confirms the blob
      //     landed (i.e. the concurrent winner committed successfully).  If the
      //     blob is absent we re-throw so a genuine permission error is not
      //     silently swallowed.
      const isCollision =
        isErrnoCode(err, 'EEXIST') ||
        isErrnoCode(err, 'ENOTEMPTY') ||
        ((isErrnoCode(err, 'EPERM') || isErrnoCode(err, 'EACCES')) && existsSync(blobPath));
      if (!isCollision) throw err;
    }
  } finally {
    await rm(tmpName, { force: true });
  }
  return blobPath;
}

// ---------------------------------------------------------------------------
// Index I/O
// ---------------------------------------------------------------------------

/**
 * Append one record to the NDJSON index.
 *
 * Uses `appendFile` with the append flag — not truly atomic for concurrent
 * writers, but torn writes produce blank or partial lines that `readIndex()`
 * skips via `try/catch JSON.parse`.  For this use case (best-effort registry)
 * that is acceptable and matches `src/agent/memory/memory-store.wal.ts`.
 */
async function appendIndex(indexPath: string, record: ArtifactRecord): Promise<void> {
  const line = JSON.stringify(record) + '\n';
  // Fast path: just append.  Torn writes produce blank/partial lines that
  // readIndex() skips via try/catch JSON.parse.
  await appendFile(indexPath, line, { encoding: 'utf8', flag: 'a' });
}

/**
 * Read the full index into memory.
 *
 * Returns the de-duplicated map keyed by artifact id (last record wins,
 * consistent with a JSONL write-ahead pattern).  Blank or malformed lines
 * are silently skipped.
 */
function readIndex(indexPath: string, maxBytes?: number): Map<string, ArtifactRecord> {
  const map = new Map<string, ArtifactRecord>();
  if (!existsSync(indexPath)) return map;
  const raw = maxBytes === undefined ? readFileSync(indexPath, 'utf8') : readBoundedIndex(indexPath, maxBytes);
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as ArtifactRecord;
      if (typeof rec.id === 'string' && rec.id) map.set(rec.id, rec);
    } catch {
      // Torn write — skip.
    }
  }
  return map;
}

/** Fixed-cap read for model-facing lookups; bounds concurrent index growth too. */
function readBoundedIndex(indexPath: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid index byte limit');
  const fd = openSync(indexPath, 'r');
  try {
    const cap = Math.min(fstatSync(fd).size, maxBytes) + 1;
    const buffer = Buffer.allocUnsafe(cap);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (n === 0) break;
      bytes += n;
    }
    if (bytes > maxBytes) throw new Error('Artifact index exceeds tool read limit; compact the registry before retrying');
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register an artifact and return its record.
 *
 * Accepts either a filesystem path (content is copied into the store) or
 * inline Buffer/string content.  The caller MUST supply `media_type` when
 * passing inline content; it is inferred from the file extension otherwise.
 *
 * Throws only on unrecoverable I/O errors.  Callers that want best-effort
 * semantics should wrap in try/catch per the artifact-failure-reporter contract.
 */
export async function artifactPut(
  opts: ArtifactPutOptions,
  _storeDir?: string,
  _indexPath?: string,
): Promise<ArtifactRecord> {
  const storeDir = _storeDir ?? getArtifactStoreDir();
  const indexPath = _indexPath ?? getArtifactIndexPath();
  ensureDirs(storeDir, indexPath);

  let hash: string;
  let size: number;
  let buf: Buffer | undefined;
  let source: { kind: 'path'; path: string } | { kind: 'buffer'; buf: Buffer };

  if (opts.path !== undefined) {
    // Containment guard: reject traversal segments and null bytes in source paths.
    // The destination blob is always <storeDir>/<hash>.<ext> (safe by construction),
    // but the source must not contain path-tricks that could confuse fs operations.
    if (opts.path.includes('\0') || opts.path.split('/').includes('..')) {
      throw new Error(`artifactPut: unsafe source path: ${opts.path}`);
    }
    hash = await sha256File(opts.path);
    size = statSync(opts.path).size;
    source = { kind: 'path', path: opts.path };
  } else {
    buf = typeof opts.content === 'string' ? Buffer.from(opts.content, 'utf8') : opts.content;
    hash = sha256hex(buf);
    size = buf.length;
    source = { kind: 'buffer', buf };
  }

  const mediaType = opts.media_type ?? (
    opts.path ? (extname(opts.path).slice(1) || 'bin') : 'application/octet-stream'
  );
  const ext = extForMediaType(mediaType);
  const blobPath = await persistBlob(storeDir, hash, ext, source);

  const record: ArtifactRecord = {
    id: idFromHash(hash),
    uri: blobPath,
    media_type: mediaType,
    hash,
    size,
    producer: opts.producer ?? {},
    inputs: opts.inputs ?? [],
    tags: opts.tags ?? {},
    created_at: Date.now(),
    retention: opts.retention ?? 'session',
  };

  await appendIndex(indexPath, record);
  return record;
}

/**
 * Retrieve an artifact record by stable ID.
 *
 * Returns `undefined` when no artifact with that ID exists.  Does NOT read
 * content — use the `uri` field to open the file.
 */
export function artifactGet(
  id: string,
  _indexPath?: string,
  maxIndexBytes?: number,
): ArtifactRecord | undefined {
  const indexPath = _indexPath ?? getArtifactIndexPath();
  return readIndex(indexPath, maxIndexBytes).get(id);
}

/**
 * List artifact records matching an optional filter.
 *
 * Results are ordered by `created_at` ascending (oldest first).
 * The default limit is 100; the hard cap is 1 000.
 */
export function artifactList(
  filter?: ArtifactListFilter,
  _indexPath?: string,
  maxIndexBytes?: number,
): ArtifactRecord[] {
  const indexPath = _indexPath ?? getArtifactIndexPath();
  const all = Array.from(readIndex(indexPath, maxIndexBytes).values());

  const limit = Math.min(filter?.limit ?? 100, 1000);
  const results: ArtifactRecord[] = [];

  for (const rec of all.sort((a, b) => a.created_at - b.created_at)) {
    if (filter) {
      if (filter.session_id && rec.producer?.session_id !== filter.session_id) continue;
      if (filter.subagent_id && rec.producer?.subagent_id !== filter.subagent_id) continue;
      if (filter.tool_name && rec.producer?.tool_name !== filter.tool_name) continue;
      if (filter.media_type && rec.media_type !== filter.media_type) continue;
      if (filter.retention && rec.retention !== filter.retention) continue;
      if (filter.since !== undefined && rec.created_at < filter.since) continue;
      if (filter.until !== undefined && rec.created_at > filter.until) continue;
      if (filter.tag && rec.tags?.[filter.tag.key] !== filter.tag.value) continue;
    }
    results.push(rec);
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Read the content of an artifact as a Buffer.
 *
 * Throws if the artifact does not exist in the index or its blob is missing
 * from the store.
 */
export async function artifactRead(
  id: string,
  _indexPath?: string,
): Promise<Buffer> {
  const rec = artifactGet(id, _indexPath);
  if (!rec) throw new Error(`Artifact not found: ${id}`);
  return readFile(rec.uri);
}

/**
 * Return the number of artifact records in the index.
 * Useful for health checks and tests.
 */
export function artifactCount(_indexPath?: string, maxIndexBytes?: number): number {
  return readIndex(_indexPath ?? getArtifactIndexPath(), maxIndexBytes).size;
}

// ---------------------------------------------------------------------------
// Compact / rebuild index (maintenance utility, not on hot path)
// ---------------------------------------------------------------------------

/**
 * Rewrite the index keeping only the latest record per id.
 *
 * Used by maintenance scripts to shrink the index after many updates.
 * Safe to call concurrently: writes to a sibling temp file then renames.
 */
export async function compactIndex(_indexPath?: string): Promise<void> {
  const indexPath = _indexPath ?? getArtifactIndexPath();
  const map = readIndex(indexPath);
  const sorted = Array.from(map.values()).sort((a, b) => a.created_at - b.created_at);
  const lines = sorted.map((r) => JSON.stringify(r)).join('\n') + (sorted.length ? '\n' : '');
  await atomicWriteFileAsync(indexPath, lines, { encoding: 'utf8', mode: 0o600, mkdirp: false });
}

// ---------------------------------------------------------------------------
// Store directory listing (for sweep integration — not on hot path)
// ---------------------------------------------------------------------------

/**
 * List all blob filenames currently in the store directory.
 * Returns `[]` when the store directory does not exist yet.
 */
export function listStoreBlobs(_storeDir?: string): string[] {
  const storeDir = _storeDir ?? getArtifactStoreDir();
  if (!existsSync(storeDir)) return [];
  return readdirSync(storeDir).filter((n) => !n.startsWith('.'));
}
