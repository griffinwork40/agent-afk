/**
 * Shared `tool_call` witness-payload builders.
 *
 * Both provider loops (`anthropic-direct/loop.ts` and
 * `openai-compatible/query/dispatch-append.ts`) construct the SAME two
 * `tool_call` trace payloads (`started` / `completed`) around their own
 * (structurally distinct) tool-dispatch loops. Before this module existed the
 * object literals were duplicated verbatim at both sites — when `subagentId`
 * was added (issue #612) it had to be hand-edited into both, which is exactly
 * the shotgun-surgery this module eliminates. Future payload fields now touch
 * ONE place.
 *
 * Lives in `providers/shared/` — NOT `trace/` — because it imports the
 * provider-specific {@link ToolResult} type; `trace/` must stay
 * provider-agnostic (it is shared with the openai-compatible AND
 * anthropic-direct providers, and any future provider).
 *
 * Both functions are pure: no I/O, no trace-writer access. Callers remain
 * responsible for the fire-and-forget `void emitToolCall(writer, ...)` call —
 * this module only builds the payload object.
 *
 * @module agent/providers/shared/tool-call-trace
 */

import { createHash } from 'crypto';

import type {
  ToolCallCompletedPayload,
  ToolCallStartedPayload,
} from '../../trace/types.js';
import type { ToolResult } from '../anthropic-direct/types.js';

/**
 * Build the `tool_call.started` payload emitted BEFORE a tool dispatches.
 *
 * `inputBytes` is computed here from the raw (pre-validation) tool input so
 * callers never need to repeat the `Buffer.byteLength(JSON.stringify(...))`
 * incantation. `subagentId` is included only when defined, matching the
 * absent-key-on-root-session contract asserted by both providers' trace
 * tests (`'subagentId' in payload === false` for a top-level session).
 */
export function buildToolCallStartedPayload(args: {
  toolUseId: string;
  name: string;
  /** Raw tool input; inputBytes and argsFingerprint are computed from this. */
  input: unknown;
  subagentId?: string | undefined;
}): ToolCallStartedPayload {
  const { toolUseId, name, input, subagentId } = args;
  const raw = input ?? {};
  const serialized = JSON.stringify(raw);
  // Invariant: argsFingerprint must NOT leak secrets. browser_act fill
  // actions carry the typed secret in `value`; the browser witness layer
  // (sanitize.ts) redacts it downstream, but we hash BEFORE that runs.
  // Redact known-sensitive fields before hashing. inputBytes stays on the
  // raw input for accurate sizing (it's a byte count, not content).
  const hashInput = JSON.stringify(redactSensitiveFields(name, raw));
  const resourceFp = computeResourceFingerprint(name, raw);
  return {
    phase: 'started',
    toolUseId,
    name,
    inputBytes: Buffer.byteLength(serialized, 'utf8'),
    argsFingerprint: createHash('sha256').update(hashInput).digest('hex'),
    ...(resourceFp !== undefined ? { resourceFingerprint: resourceFp } : {}),
    ...(subagentId !== undefined ? { subagentId } : {}),
  };
}

/**
 * Strip known-sensitive tool input fields before hashing. Returns a shallow
 * copy with secrets replaced by a fixed sentinel so the hash is stable but
 * content-free. Only tools with known secret params need cases here.
 *
 * Invariant: `inputBytes` is computed from the RAW (un-redacted) input for
 * accurate sizing. Only `argsFingerprint` uses this function's output.
 */
function redactSensitiveFields(toolName: string, input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case 'browser_act':
      // `value` carries the typed secret for fill actions.
      if (obj['action'] === 'fill' && 'value' in obj) {
        return { ...obj, value: '[REDACTED]' };
      }
      return input;

    case 'config_set':
      // `value` may carry a secret when target=env (env vars include
      // secret-class keys like API tokens). The engine refuses secret
      // writes from agent tools, but the attempt's input is still hashed.
      // Config keys (target=config) are all non-secret by design.
      if (obj['target'] === 'env' && 'value' in obj) {
        return { ...obj, value: '[REDACTED]' };
      }
      return input;

    default:
      return input;
  }
}

/**
 * Compute a resource-level fingerprint for tools that access a single nameable
 * resource. Returns `undefined` for tools where no single resource identity
 * exists.
 *
 * For `read_file` / `list_directory` / `grep`: the resource is the normalized
 * file path, ignoring offset/limit/pattern so that two reads of the same file
 * at different offsets share a fingerprint.
 *
 * Security note: the hash is plain SHA-256 with no salt and no HMAC. This is
 * intentional. `redactSensitiveFields` is NOT called here — file paths are not
 * secrets, and the witness trace these values land in is a local-only file
 * under `~/.afk/state/witness/`. Note: the trace writer uses default umask
 * (typically 0644 files / 0755 dirs), so on a multi-user host these hashes
 * are world-readable. This is acceptable because the fingerprints are
 * truncated SHA-256 digests of project-local paths — low value to other
 * local users. If resource fingerprints are ever transmitted to an external
 * service, or if paths may contain sensitive identifiers, add HMAC-SHA256
 * keyed on a session secret so brute-force path recovery is infeasible.
 */
function computeResourceFingerprint(
  toolName: string,
  input: unknown,
): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case 'read_file':
    case 'list_directory': {
      // Both use a path-like key: read_file → file_path, list_directory → path
      const raw = (obj['file_path'] ?? obj['path']) as string | undefined;
      if (typeof raw !== 'string' || raw.length === 0) return undefined;
      // Normalize: trim whitespace, collapse consecutive slashes, strip trailing /
      const normalized = raw.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
      return createHash('sha256').update(normalized).digest('hex');
    }

    case 'grep': {
      // grep's resource is `path` (directory/file being searched) + `pattern`,
      // but `include` / other args change what is read. Keep it narrow: only
      // hash when `path` is present.
      const raw = obj['path'] as string | undefined;
      if (typeof raw !== 'string' || raw.length === 0) return undefined;
      const normalized = raw.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
      return createHash('sha256').update(normalized).digest('hex');
    }

    default:
      return undefined;
  }
}

/**
 * Build the `tool_call.completed` payload emitted AFTER a tool dispatch
 * settles, pairing with the `started` event above via `toolUseId`.
 *
 * `truncated` and `durationMs` are passed IN rather than derived here: both
 * are local consts at each call site that the surrounding `tool.output`
 * yield ALSO reads, so deriving them inside this builder would either
 * duplicate the derivation (risking drift) or force the caller to destructure
 * them back out of the built payload (awkward, and `noUnusedLocals` would
 * flag the now-orphaned local at each site if the derivation moved here
 * without a caller-side use). Keeping the derivation at the call site and
 * threading the values through preserves the exact prior behavior.
 */
export function buildToolCallCompletedPayload(args: {
  toolUseId: string;
  name: string;
  result: ToolResult;
  truncated: boolean;
  durationMs: number;
  subagentId?: string | undefined;
}): ToolCallCompletedPayload {
  const { toolUseId, name, result, truncated, durationMs, subagentId } = args;
  return {
    phase: 'completed',
    toolUseId,
    name,
    resultBytes: Buffer.byteLength(result.content, 'utf8'),
    isError: result.isError === true,
    truncated,
    durationMs,
    ...(result.incomplete === true ? { incomplete: true } : {}),
    ...(result.incompleteReason ? { incompleteReason: result.incompleteReason } : {}),
    ...(result.circuitBreaker === true ? { circuitBreaker: true } : {}),
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    ...(typeof result.batchIndex === 'number' && typeof result.batchSize === 'number'
      ? { batchIndex: result.batchIndex, batchSize: result.batchSize }
      : {}),
    ...(subagentId !== undefined ? { subagentId } : {}),
    ...(result.testResult !== undefined ? { testResult: result.testResult } : {}),
  };
}
