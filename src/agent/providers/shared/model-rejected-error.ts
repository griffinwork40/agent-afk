/**
 * Typed "this specific model was rejected by the backend" error, plus the
 * structural classifier that recognizes it from raw provider SDK errors.
 *
 * Contract: classification reads STRUCTURED error fields only (HTTP `status`,
 * the parsed error body's `type` / `code`, and the body's own `message`
 * field). It never inspects a subagent's result prose. Eligible shapes:
 *   - ChatGPT/Codex backend 400 for an unsupported model (typed at the source
 *     by `clarifyResponsesError`, which constructs a {@link ModelRejectedError}).
 *   - OpenAI `code: "model_not_found"` (top-level or on the body).
 *   - Anthropic 404 `not_found_error` whose message names the model
 *     (`model: <id>`), and 400 `invalid_request_error` whose message says the
 *     model is invalid / unknown / not supported.
 * NOT eligible (always undefined): 401, 403 (incl. oauth_not_allowed_for_organization),
 * 429, any 5xx, and any 400 whose body is about something other than the model
 * (prompt too long, bad tool schema, ...).
 *
 * The `code: 'model_rejected'` marker is a stable duck-type check for callers
 * that see the error across a structured-clone or re-wrap boundary.
 *
 * @module agent/providers/shared/model-rejected-error
 */

import { getErrorStatus } from './error-status.js';

export const MODEL_REJECTED_CODE = 'model_rejected' as const;

export class ModelRejectedError extends Error {
  readonly code = MODEL_REJECTED_CODE;
  constructor(
    message: string,
    readonly model: string,
    readonly status: number | undefined,
    readonly provider: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModelRejectedError';
  }
}

/** True for a {@link ModelRejectedError} or anything carrying its stable marker. */
export function isModelRejectedError(err: unknown): err is ModelRejectedError {
  if (err instanceof ModelRejectedError) return true;
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === MODEL_REJECTED_CODE;
}

interface ErrorBody { type?: unknown; code?: unknown; message?: unknown }

/** The parsed provider error body: Anthropic nests `{error:{type,message}}`, OpenAI exposes `{type,code,message}`. */
function errorBody(err: object): ErrorBody | undefined {
  const outer = (err as { error?: unknown }).error;
  if (outer === null || typeof outer !== 'object') return undefined;
  const inner = (outer as { error?: unknown }).error;
  return (inner !== null && typeof inner === 'object' ? inner : outer) as ErrorBody;
}

const MODEL_INVALID_RE = /\b(invalid|unknown|unsupported|not (?:found|supported|available)|does not exist|no such)\b/i;

/**
 * Classify a raw provider error. Returns the typed error (possibly the input
 * itself) when the failure is a model rejection, otherwise `undefined`.
 */
export function classifyModelRejection(err: unknown, model: string, provider: string): ModelRejectedError | undefined {
  if (isModelRejectedError(err)) return err;
  if (err === null || typeof err !== 'object') return undefined;
  const status = getErrorStatus(err);
  if (status === 401 || status === 403 || status === 429 || (status !== undefined && status >= 500)) return undefined;
  const body = errorBody(err);
  const topCode = (err as { code?: unknown }).code;
  const bodyMessage = typeof body?.message === 'string' ? body.message : '';
  const original = err instanceof Error ? err.message : bodyMessage;
  const build = (): ModelRejectedError =>
    new ModelRejectedError(original || `model "${model}" rejected`, model, status, provider, { cause: err });

  if (topCode === 'model_not_found' || body?.code === 'model_not_found') return build();
  if (status === 404 && body?.type === 'not_found_error' && /^model\b/i.test(bodyMessage)) return build();
  if (status === 400 && body?.type === 'invalid_request_error' && /\bmodel\b/i.test(bodyMessage) && MODEL_INVALID_RE.test(bodyMessage)) {
    return build();
  }
  return undefined;
}
