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
  /** Raw tool input; inputBytes is computed from this. */
  input: unknown;
  subagentId?: string | undefined;
}): ToolCallStartedPayload {
  const { toolUseId, name, input, subagentId } = args;
  return {
    phase: 'started',
    toolUseId,
    name,
    inputBytes: Buffer.byteLength(JSON.stringify(input ?? {}), 'utf8'),
    ...(subagentId !== undefined ? { subagentId } : {}),
  };
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
    ...(result.circuitBreaker === true ? { circuitBreaker: true } : {}),
    ...(result.failureClass ? { failureClass: result.failureClass } : {}),
    ...(typeof result.batchIndex === 'number' && typeof result.batchSize === 'number'
      ? { batchIndex: result.batchIndex, batchSize: result.batchSize }
      : {}),
    ...(subagentId !== undefined ? { subagentId } : {}),
  };
}
