/**
 * `artifact_publish` handler — model-facing write surface for the artifact registry (#1415).
 *
 * Accepts a filesystem path (register an existing file the model already wrote)
 * or inline UTF-8 content (register a small generated output directly).
 *
 * Safety contract (mirrors artifact-failure-reporter.ts):
 *   - An artifact publish failure MUST NOT fail the caller's turn.
 *   - Handler always returns { content, isError? }; it never throws.
 *
 * Authorization:
 *   - Path inputs: the source path must pass the existing read-root /
 *     credential-floor check (resolveAndContain). The model must already have
 *     read access to the file; artifact_publish does not grant new access.
 *   - Inline content: bounded at INLINE_CONTENT_MAX_BYTES (64 KiB). No path
 *     authorization is required because the model is supplying bytes directly.
 *
 * Quota admission:
 *   - Per-actor session cap: AFK_ARTIFACT_SESSION_LIMIT (default 50).
 *     Calls without a session ID share a process-wide fallback allowance.
 *   - If the cap is reached, the handler returns isError:true without writing.
 *
 * Lineage validation:
 *   - Each entry in `inputs` must match the artifact-ID format (art_<32hex>).
 *     IDs that do not exist in the index are accepted (best-effort lineage).
 *
 * @module agent/tools/handlers/artifact-publish
 */

import { stat } from 'node:fs/promises';
import { z, ZodError } from 'zod';
import { artifactPut } from '../../artifact-registry/store.js';
import { env } from '../../../config/env.js';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';
import { makeSessionCounter } from './_image-operation.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_LIMIT = 50;
/** Inline content ceiling: 64 KiB. Larger outputs should be pre-written to disk. */
const INLINE_CONTENT_MAX_BYTES = 64 * 1024;
/** Upper bound on metadata string fields to prevent index bloat. */
const META_STRING_MAX = 256;
const TAG_COUNT_MAX = 16;
const PROCESS_QUOTA_KEY = '\0artifact_publish:no-session';

// ---------------------------------------------------------------------------
// Per-factory session quota counter
// ---------------------------------------------------------------------------

// Module-level singleton so the quota is shared across handler re-creations
// within one process (matches the image_generate pattern).
const publishCounter = makeSessionCounter();

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const artifactIdPattern = /^art_[0-9a-f]{32}$/;
const retentionPattern = /^(permanent|session|ttl:[1-9][0-9]*)$/;

const publishInput = z.object({
  /** Existing filesystem path to register. Mutually exclusive with `content`. */
  path: z.string().max(4096).optional(),
  /** Inline UTF-8 string content to register. Mutually exclusive with `path`. */
  content: z.string().max(INLINE_CONTENT_MAX_BYTES).refine(
    (value) => Buffer.byteLength(value, 'utf8') <= INLINE_CONTENT_MAX_BYTES,
    { message: 'Inline content must not exceed 64 KiB of UTF-8 bytes' },
  ).optional(),
  /** MIME type. Defaults to text/plain for inline content; inferred from file extension for path inputs. */
  media_type: z.string().max(128).optional(),
  /** Retention policy: `permanent`, `session` (default), or `ttl:<ms>` where <ms> is a positive integer. */
  retention: z.string().regex(retentionPattern).max(64).refine(
    (v) => {
      if (!v.startsWith('ttl:')) return true;
      const ms = parseInt(v.slice(4), 10);
      return Number.isFinite(ms) && ms > 0 && String(ms) === v.slice(4);
    },
    { message: 'ttl value must be a finite positive integer (milliseconds)' },
  ).optional(),
  /** Stable IDs of input artifacts this was derived from (lineage). */
  inputs: z.array(z.string().regex(artifactIdPattern).max(38)).max(16).optional(),
  /** Free-form key/value tags (bounded). */
  tags: z.record(z.string().max(META_STRING_MAX), z.string().max(META_STRING_MAX)).refine(
    (tags) => Object.keys(tags).length <= TAG_COUNT_MAX,
    { message: 'At most 16 tags may be supplied' },
  ).optional(),
}).refine(
  (d) => (d.path !== undefined) !== (d.content !== undefined),
  { message: 'Exactly one of path or content must be supplied' },
);

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function safePublishError(err: unknown): string {
  if (err instanceof ZodError) return `artifact_publish: invalid input — ${err.issues[0]?.message ?? 'validation error'}`;
  if (err instanceof Error) {
    if (err.message.startsWith('artifact_publish:')) return err.message;
    // Redact arbitrary I/O errors — do not leak internal paths.
    return 'artifact_publish: registration failed';
  }
  return 'artifact_publish: registration failed';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ArtifactPublishHandlerOptions {
  cwd?: string;
  storeDir?: string;
  indexPath?: string;
}

/**
 * Create the `artifact_publish` tool handler.
 *
 * Accepts the same options as `createArtifactHandlers` so both can be
 * constructed with a shared `{ cwd, storeDir, indexPath }` options object.
 */
export function createArtifactPublishHandler(
  opts: ArtifactPublishHandlerOptions = {},
): ToolHandler {
  return async (input, signal, context: ToolHandlerContext | undefined) => {
    let quotaKey: string | undefined;
    let published = false;
    try {
      signal.throwIfAborted();

      // 1. Parse and validate input.
      const params = publishInput.parse(input);

      // 2. Reserve quota synchronously before any await; release on every failure.
      const sessionId = context?.sessionId;
      const limitStr = env.AFK_ARTIFACT_SESSION_LIMIT;
      const parsedLimit = parseInt(limitStr ?? '', 10);
      const limit =
        Number.isFinite(parsedLimit) && parsedLimit > 0
          ? parsedLimit
          : DEFAULT_SESSION_LIMIT;
      const key = sessionId ?? PROCESS_QUOTA_KEY;
      if (publishCounter.get(key) >= limit) {
        const scope = sessionId ? `session ${sessionId}` : 'global (no session id)';
        return {
          content:
            `artifact_publish: per-session publish cap reached (${limit}) for ${scope}. ` +
            `Set AFK_ARTIFACT_SESSION_LIMIT to increase the cap or use fewer publishes per session.`,
          isError: true,
        };
      }
      publishCounter.increment(key);
      quotaKey = key;

      // 3. Resolve and authorize path inputs.
      let resolvedPath: string | undefined;
      if (params.path !== undefined) {
        try {
          resolvedPath = resolveAndContain(params.path, context, 'read', opts.cwd);
        } catch (err) {
          return {
            content: `artifact_publish: source path is not accessible — ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        // Confirm the resolved path is a regular file (not a directory, device, etc.).
        const st = await stat(resolvedPath);
        if (!st.isFile()) {
          return {
            content: `artifact_publish: path must be a regular file`,
            isError: true,
          };
        }
      }

      // 4. Register the artifact; the finally block releases failed reservations.
      const record = await artifactPut(
        {
          ...(resolvedPath !== undefined
            ? { path: resolvedPath }
            : { content: params.content! }),
          media_type: params.media_type,
          retention: params.retention as 'permanent' | 'session' | `ttl:${number}` | undefined,
          inputs: params.inputs,
          tags: params.tags,
          producer: {
            session_id: sessionId,
            tool_name: 'artifact_publish',
          },
        },
        opts.storeDir,
        opts.indexPath,
      );
      published = true;

      // 5. Return bounded metadata only (no arbitrary tags or full lineage).
      return {
        content: JSON.stringify({
          id: record.id,
          uri: record.uri,
          hash: record.hash,
          size: record.size,
          media_type: record.media_type,
          retention: record.retention,
          created_at: record.created_at,
          producer: record.producer,
        }),
      };
    } catch (err) {
      return { content: safePublishError(err), isError: true };
    } finally {
      if (quotaKey !== undefined && !published) publishCounter.decrement(quotaKey);
    }
  };
}
