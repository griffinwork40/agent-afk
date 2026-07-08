/**
 * Failure-path payload + telemetry shaping helpers.
 *
 * Extracted from `subagent-executor.ts`: the best-effort telemetry wrapper and
 * the small pure helpers that shape the structured JSON failure payload
 * returned to the parent model. Shared by the fork-error, background, and
 * foreground paths in `execute()`. All functions are pure — no dependency on
 * the executor instance.
 *
 * @module agent/tools/subagent/failure-payload
 */

import { appendRoutingDecision } from '../../routing-telemetry.js';

/**
 * Best-effort telemetry helper. Wraps {@link appendRoutingDecision} so a
 * synchronous throw (shouldn't happen — the helper already swallows) cannot
 * propagate into the dispatch path.
 */
export function emitTelemetry(entry: Parameters<typeof appendRoutingDecision>[0]): Promise<void> {
  try {
    return appendRoutingDecision(entry).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Truncate short telemetry strings; we never log full error bodies. */
export function truncate(s: string, max = 240): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/** Measure partial output size without serializing large structures repeatedly. */
export function measurePartial(partial: unknown): number | undefined {
  if (partial === undefined || partial === null) return undefined;
  if (typeof partial === 'string') return partial.length;
  try {
    return JSON.stringify(partial).length;
  } catch {
    return undefined;
  }
}

/**
 * Maximum serialized size of `partialOutput` we will surface to the parent
 * model. Above this, we replace the payload with a `{ truncated, chars }`
 * marker so the parent learns partial output existed without flooding its
 * context.
 */
const MAX_PARTIAL_OUTPUT_CHARS = 4096;

/** Maximum length of the `error` field in the structured failure payload. */
const MAX_ERROR_MESSAGE_CHARS = 1024;

/**
 * Shape a partial output for inclusion in the structured failure payload.
 * Returns `undefined` when the input is null/undefined (key is omitted).
 * Returns a `{ truncated, chars }` marker when serialization exceeds the cap.
 */
function shapePartialOutput(
  partial: unknown,
): unknown | undefined {
  if (partial === undefined || partial === null) return undefined;
  const chars = measurePartial(partial);
  if (chars !== undefined && chars > MAX_PARTIAL_OUTPUT_CHARS) {
    return { truncated: true, chars };
  }
  return partial;
}

/**
 * Build the structured JSON payload returned to the parent model on the
 * failure path. Intentionally small: status + short error + optional schema
 * error string + optional (size-capped) partial output + subagent id.
 *
 * Excludes by design: prompts, full subagent assistant messages, file
 * contents, tool inputs/outputs, credentials, stack traces.
 */
export interface StructuredFailurePayload {
  status: string;
  error: string;
  schemaError?: string;
  partialOutput?: unknown;
  subagent_id: string;
}

export function buildFailurePayload(args: {
  status: string;
  errorMessage: string;
  schemaErrorMessage?: string;
  partialOutput?: unknown;
  subagentId: string;
}): StructuredFailurePayload {
  const payload: StructuredFailurePayload = {
    status: args.status,
    error: truncate(args.errorMessage, MAX_ERROR_MESSAGE_CHARS),
    subagent_id: args.subagentId,
  };
  if (args.schemaErrorMessage) {
    payload.schemaError = truncate(args.schemaErrorMessage, MAX_ERROR_MESSAGE_CHARS);
  }
  const shaped = shapePartialOutput(args.partialOutput);
  if (shaped !== undefined) {
    payload.partialOutput = shaped;
  }
  return payload;
}
