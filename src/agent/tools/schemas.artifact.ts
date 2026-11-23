/** Read-only model surface for the existing immutable artifact registry (#1415). */
import type { AnthropicToolDef } from './types.js';

const id = { type: 'string', pattern: '^art_[0-9a-f]{32}$', description: 'Stable artifact ID returned by the registry.' };

export const artifactGetTool: AnthropicToolDef = {
  name: 'artifact_get', category: 'read', concurrencySafe: true,
  description: 'Retrieve bounded artifact metadata by stable ID, not its content. Requires read access to the stored blob; does not grant new filesystem access.',
  input_schema: { type: 'object', properties: { id }, required: ['id'] },
};

export const artifactListTool: AnthropicToolDef = {
  name: 'artifact_list', category: 'read', concurrencySafe: true,
  description: 'List registered artifacts visible within your existing read roots, oldest first. Returns bounded metadata and read paths, never file content. Filters are ANDed. No automatic registration or retention changes.',
  input_schema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Filter by producing session.' },
      subagent_id: { type: 'string', description: 'Filter by producing subagent.' },
      tool_name: { type: 'string', description: 'Filter by producing tool.' },
      media_type: { type: 'string', description: 'Exact MIME type filter.' },
      since: { type: 'number', description: 'Inclusive registration timestamp lower bound, epoch milliseconds.' },
      until: { type: 'number', description: 'Inclusive registration timestamp upper bound, epoch milliseconds.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum records (default 20). Total response capped at 32 KiB.' },
    },
    required: [],
  },
};

export const artifactReadTool: AnthropicToolDef = {
  name: 'artifact_read', category: 'read', concurrencySafe: true,
  description: 'Read small UTF-8 text artifacts in bounded byte slices (default 4 KiB, max 16 KiB). Binary and large artifacts (>64 KiB) return metadata plus a read path only. Existing read-root and credential policy applies; IDs do not confer access. Offsets are bytes, not lines.',
  input_schema: {
    type: 'object',
    properties: {
      id,
      offset: { type: 'integer', minimum: 0, description: 'Starting byte offset (default 0).' },
      limit: { type: 'integer', minimum: 1, maximum: 16384, description: 'Maximum bytes to read (default 4096).' },
    },
    required: ['id'],
  },
};

export const artifactPublishTool: AnthropicToolDef = {
  name: 'artifact_publish', category: 'write', concurrencySafe: false,
  description: 'Register a local file or inline UTF-8 content in the content-addressed artifact registry, returning a stable ID and metadata. Accepts either `path` (an existing file the model already has read access to) or `content` (inline string, max 64 KiB). Exactly one must be supplied. Path authorization uses the existing session read roots — IDs do not grant new access. Per-actor session publish cap controlled by AFK_ARTIFACT_SESSION_LIMIT (default 50); calls without a session ID share a process-wide allowance.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or session-relative path to an existing file to register. Mutually exclusive with `content`.' },
      content: { type: 'string', description: 'Inline UTF-8 string content to register (max 64 KiB). Mutually exclusive with `path`.' },
      media_type: { type: 'string', description: 'MIME type (e.g. `text/markdown`, `application/json`). Optional: defaults to `text/plain` for inline content; inferred from file extension for path inputs.' },
      retention: { type: 'string', description: 'Retention policy: `permanent` (never swept), `session` (default, swept with originating session), or `ttl:<ms>` (evict after given milliseconds from registration; <ms> must be a finite positive integer).' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'Stable IDs of input artifacts this was derived from (lineage). Each entry must match `art_<32hex>`.' },
      tags: { type: 'object', description: 'String key/value tags for filtering and discovery (max 16 tags; keys and values max 256 characters).' },
    },
    required: [],
  },
};

export const artifactToolSchemas = [artifactGetTool, artifactListTool, artifactReadTool, artifactPublishTool] as const;
