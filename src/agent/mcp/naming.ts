/**
 * MCP tool naming — converts `<server>` × `<tool>` pairs into the
 * `mcp__<server>__<tool>` strings the Anthropic Messages API receives in
 * `tools[]` and the dispatcher routes back on tool_use.
 *
 * Anthropic API constraints we have to respect:
 *   1. Names must match `^[a-zA-Z0-9_-]{1,64}$`.
 *   2. The `mcp__` prefix is recognized by the existing UI category
 *      detector at `src/cli/tool-category.ts:123` — we must NOT change it.
 *
 * The 64-char ceiling is real (e.g. `linear` server + a long action name
 * blows past it). Strategy when the raw concatenation overflows:
 *
 *   1. Sanitize both segments to `[a-zA-Z0-9_-]` (replace each unsafe char
 *      with `_`, collapse runs).
 *   2. If still over 64, replace the server segment with a 6-char SHA-256
 *      prefix so the server is still uniquely identifiable for conflict
 *      detection.
 *   3. If still over 64, truncate the tool tail. The reverse-map in
 *      `manager.fromConfig()` catches any collisions at startup.
 *
 * Reverse routing: the prefix `mcp__` is reserved and never collides with
 * a built-in tool name (see `BUILTIN_TOOL_NAMES` in `tools/schemas.ts`).
 *
 * @module agent/mcp/naming
 */

import { createHash } from 'node:crypto';

const PREFIX = 'mcp__';
const SEPARATOR = '__';
const MAX_LEN = 64;
const SERVER_HASH_LEN = 6;

/**
 * Replace characters outside `[a-zA-Z0-9_-]` with `_` and collapse any
 * resulting runs of underscores so the encoded name stays readable.
 * Empty input is replaced with `_` so we never produce zero-length segments
 * (which would violate the API's `{1,64}` length requirement after split).
 */
export function sanitizeNameSegment(input: string): string {
  if (input.length === 0) return '_';
  const replaced = input.replace(/[^a-zA-Z0-9_-]/g, '_');
  // Collapse internal `__` runs to a single `_` so the separator `__`
  // between server and tool can be unambiguously split (and so the encoded
  // name doesn't accidentally suggest a different namespace boundary).
  const collapsed = replaced.replace(/_{2,}/g, '_');
  return collapsed.length === 0 ? '_' : collapsed;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, SERVER_HASH_LEN);
}

/**
 * Build the wire-level tool name from a (server, tool) pair. Always
 * deterministic for a given input — necessary for the reverse-routing
 * map and for stable telemetry.
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  const server = sanitizeNameSegment(serverName);
  const tool = sanitizeNameSegment(toolName);
  const raw = `${PREFIX}${server}${SEPARATOR}${tool}`;
  if (raw.length <= MAX_LEN) return raw;

  // Overflow path: hash the server, keep the tool name in full if it fits.
  const hashedPrefix = `${PREFIX}${shortHash(serverName)}${SEPARATOR}`;
  const candidate = `${hashedPrefix}${tool}`;
  if (candidate.length <= MAX_LEN) return candidate;

  // Still over budget — truncate the tool tail. Conflict detection in the
  // manager will catch any name collisions this causes.
  return candidate.slice(0, MAX_LEN);
}

/**
 * Detection helper used by routing layers that need to know whether a
 * tool name came from an MCP server (vs. a built-in or skill tool).
 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(PREFIX);
}

/**
 * Result of building a per-manager name registry. The `tools` map is
 * `wireName → { serverName, originalToolName }` for use by the dispatcher's
 * `handlers.get(wireName)` lookup path; `conflicts` is the populated-only-
 * when-non-empty list of collisions the caller must surface as a startup
 * failure.
 */
export interface McpNameRegistry {
  tools: Map<string, { serverName: string; originalToolName: string }>;
  conflicts: Array<{
    wireName: string;
    pairs: Array<{ serverName: string; originalToolName: string }>;
  }>;
}

/**
 * Build the wire-name → origin map for every (server, tool) pair across
 * all connected servers. Returns conflicts separately so the manager can
 * fail loudly at startup rather than silently shadowing the duplicate.
 */
export function buildMcpNameRegistry(
  entries: Iterable<{ serverName: string; toolNames: string[] }>,
): McpNameRegistry {
  const tools = new Map<string, { serverName: string; originalToolName: string }>();
  const collisions = new Map<string, Array<{ serverName: string; originalToolName: string }>>();

  for (const { serverName, toolNames } of entries) {
    for (const toolName of toolNames) {
      const wireName = buildMcpToolName(serverName, toolName);
      const origin = { serverName, originalToolName: toolName };
      const existing = tools.get(wireName);
      if (existing === undefined) {
        tools.set(wireName, origin);
        continue;
      }
      // Same (server, tool) pair encountered twice — idempotent, ignore.
      if (
        existing.serverName === serverName &&
        existing.originalToolName === toolName
      ) {
        continue;
      }
      // Real collision — record both pairs.
      const bucket = collisions.get(wireName) ?? [existing];
      bucket.push(origin);
      collisions.set(wireName, bucket);
    }
  }

  const conflicts: McpNameRegistry['conflicts'] = [];
  for (const [wireName, pairs] of collisions) {
    conflicts.push({ wireName, pairs });
  }

  return { tools, conflicts };
}
