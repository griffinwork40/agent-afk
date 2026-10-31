/** Bounded read-only adapters for the landed artifact registry (#1415). */
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { artifactGet, artifactList } from '../../artifact-registry/store.js';
import { getArtifactStoreDir } from '../../../paths.js';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';

const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const artifactId = z.string().regex(/^art_[0-9a-f]{32}$/);
const getInput = z.object({ id: artifactId });
const readInput = getInput.extend({
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(16384).default(4096),
});
const listInput = z.object({
  session_id: z.string().max(256).optional(),
  subagent_id: z.string().max(256).optional(),
  tool_name: z.string().max(256).optional(),
  media_type: z.string().max(128).optional(),
  since: z.number().finite().nonnegative().optional(),
  until: z.number().finite().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
// Contract: index metadata is local disk input, not trusted tool output. Return
// a bounded summary (no arbitrary tags/lineage) and never open an arbitrary URI.
const metadataSchema = z.object({
  id: artifactId,
  uri: z.string().max(4096),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  media_type: z.string().max(128),
  created_at: z.number().finite().nonnegative(),
  retention: z.string().regex(/^(permanent|session|ttl:[0-9]+)$/).max(64),
  producer: z.object({
    session_id: z.string().max(256).optional(),
    subagent_id: z.string().max(256).optional(),
    tool_name: z.string().max(256).optional(),
    task_id: z.string().max(256).optional(),
  }),
});

type Metadata = z.infer<typeof metadataSchema>;
interface ArtifactHandlerOptions { cwd?: string; storeDir?: string; indexPath?: string }

async function authorizeRecord(
  raw: unknown,
  context: ToolHandlerContext | undefined,
  opts: ArtifactHandlerOptions,
): Promise<Metadata> {
  const record = metadataSchema.parse(raw);
  const storeDir = resolve(opts.storeDir ?? getArtifactStoreDir());
  const filename = basename(record.uri);
  if (record.id !== `art_${record.hash.slice(0, 32)}` ||
      dirname(record.uri) !== storeDir ||
      !filename.startsWith(`${record.hash}.`) ||
      !/^[0-9a-f]{64}\.[a-z0-9]{1,16}$/.test(filename)) {
    throw new Error('Invalid artifact blob reference');
  }
  // IDs confer no authority. Apply the existing read floor and actor roots even
  // for metadata; then reject redirected blobs, including symlinks outside store.
  try {
    resolveAndContain(record.uri, context, 'read', opts.cwd);
  } catch {
    throw new Error('artifact not accessible');
  }
  let realStore: string, realBlob: string;
  try {
    [realStore, realBlob] = await Promise.all([realpath(storeDir), realpath(record.uri)]);
  } catch {
    throw new Error('artifact not accessible');
  }
  if (dirname(realBlob) !== realStore || basename(realBlob) !== filename) {
    throw new Error('Invalid artifact blob location');
  }
  return record;
}

function safeHandlerError(prefix: string, err: unknown): string {
  if (err instanceof ZodError) return `${prefix}: invalid artifact record`;
  if (err instanceof Error && err.message === 'Artifact size mismatch') return `${prefix}: ${err.message}`;
  if (err instanceof Error && (err.message === 'Invalid artifact blob reference' ||
      err.message === 'Invalid artifact blob location' ||
      err.message === 'artifact not accessible' ||
      err.message.startsWith('Artifact index exceeds tool read limit'))) return `${prefix}: ${err.message}`;
  return `${prefix}: artifact read failed`;
}

async function readSlice(record: Metadata, offset: number, limit: number) {
  const fh = await open(record.uri, 'r');
  try {
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size !== record.size) throw new Error('Artifact size mismatch');
    const isText = record.media_type.startsWith('text/') ||
      record.media_type === 'application/json';
    if (!isText || stat.size > 65536) {
      return { artifact: record, read_path: record.uri, contentOmitted: !isText ? 'binary' : 'large' };
    }
    const buffer = Buffer.alloc(Math.min(limit, Math.max(0, stat.size - offset)));
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { artifact: record, read_path: record.uri, contentOmitted: 'binary' };
    return {
      artifact: record, read_path: record.uri, content: bytes.toString('utf8'),
      offset, bytes_read: bytesRead, truncated: offset + bytesRead < stat.size,
      ...(offset + bytesRead < stat.size ? { next_offset: offset + bytesRead } : {}),
    };
  } finally {
    await fh.close();
  }
}

export function createArtifactHandlers(opts: ArtifactHandlerOptions = {}): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  handlers.set('artifact_get', async (input, signal, context) => {
    try {
      signal.throwIfAborted();
      const { id } = getInput.parse(input);
      const raw = artifactGet(id, opts.indexPath, MAX_INDEX_BYTES);
      const record = raw ? await authorizeRecord(raw, context, opts) : null;
      return { content: JSON.stringify(record) };
    } catch (err) {
      return { content: safeHandlerError('artifact_get', err), isError: true };
    }
  });
  handlers.set('artifact_list', async (input, signal, context) => {
    try {
      signal.throwIfAborted();
      const filter = listInput.parse(input ?? {});
      // Index reads are capped at 8 MiB; candidates and response are bounded too. Inaccessible and
      // malformed records are omitted without revealing their metadata.
      const records: Metadata[] = [];
      // Reserve envelope and commas so the complete JSON stays below 32 KiB.
      let bytes = 128;
      let truncated = false;
      const candidates = artifactList({ ...filter, limit: 1000 }, opts.indexPath, MAX_INDEX_BYTES);
      for (const raw of candidates) {
        signal.throwIfAborted();
        let record: Metadata;
        try { record = await authorizeRecord(raw, context, opts); } catch { continue; }
        const size = Buffer.byteLength(JSON.stringify(record), 'utf8');
        if (records.length >= filter.limit || bytes + size > 32768) { truncated = true; break; }
        records.push(record);
        bytes += size;
      }
      return { content: JSON.stringify({ artifacts: records, count: records.length, truncated: truncated || candidates.length === 1000 }) };
    } catch (err) {
      return { content: safeHandlerError('artifact_list', err), isError: true };
    }
  });
  handlers.set('artifact_read', async (input, signal, context) => {
    try {
      signal.throwIfAborted();
      const { id, offset, limit } = readInput.parse(input);
      const raw = artifactGet(id, opts.indexPath, MAX_INDEX_BYTES);
      if (!raw) return { content: 'null' };
      const record = await authorizeRecord(raw, context, opts);
      signal.throwIfAborted();
      return { content: JSON.stringify(await readSlice(record, offset, limit)) };
    } catch (err) {
      return { content: safeHandlerError('artifact_read', err), isError: true };
    }
  });
  return handlers;
}
