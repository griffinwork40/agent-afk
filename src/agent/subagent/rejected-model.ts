/**
 * Classifier for "this specific model was rejected" errors — the signal that
 * triggers the default-tier model fallback in the subagent dispatch paths.
 *
 * Kept in one place so every dispatch path (agent tool, skill forks, compose
 * nodes) uses identical logic and tests cover the classifier independently.
 *
 * Contract:
 *   - Returns true  → the child failed because THIS model is unusable on this
 *                     account/backend; a fallback to another model is safe.
 *   - Returns false → transient error (429, 5xx, network), account-level auth
 *                     error (org policy, OAuth scope), or unknown; do not retry
 *                     with a different model — the same error will recur.
 *
 * Invariant: we only check the error text/status from the child's ToolResult
 * content string (not a live Error object) because the dispatch paths return
 * ToolResult, not thrown exceptions. The patterns below are validated against
 * the real error strings produced by:
 *   - chatgpt-backend-errors.ts  (`clarifyResponsesError` 400 path)
 *   - chatgpt-backend-errors.ts  (`chatGptClaudeModelError`)
 *   - openai-compatible/query.ts  OpenAI 404 model-not-found
 *   - anthropic-direct/           Anthropic 400/404 model errors
 *
 * @module agent/subagent/rejected-model
 */

// ---------------------------------------------------------------------------
// HTTP-status extractor — ToolResult content is a plain string; we look for
// a leading status code produced by the provider error formatters.
// ---------------------------------------------------------------------------

/** Extract the first bare HTTP status integer from an error string. */
function extractStatus(msg: string): number | undefined {
  const m = /\b(4\d\d|5\d\d)\b/.exec(msg);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Pattern sets
// ---------------------------------------------------------------------------

/**
 * Patterns that unambiguously indicate THIS model was rejected by the
 * backend — not transient, not an account-level policy.
 *
 * Matched case-insensitively against the error string.
 */
const MODEL_REJECTION_PATTERNS: RegExp[] = [
  // chatgpt-backend-errors.ts clarifyResponsesError
  /ChatGPT\/Codex backend rejected model/i,
  // chatgpt-backend-errors.ts chatGptClaudeModelError
  /can't run on a ChatGPT subscription/i,
  // OpenAI "model not found" (404)
  /model[_ -]?not[_ -]?found/i,
  // OpenAI / Anthropic "invalid model" (400)
  /invalid model/i,
  // Anthropic "model does not exist"
  /model does not exist/i,
  // Generic backend "unsupported model"
  /unsupported model/i,
  // "no such model" (some OpenAI-compat shims)
  /no such model/i,
];

/**
 * Patterns that indicate account-level or transient errors. When any of these
 * match we do NOT fall back, even if the status is 400 or 404, because the
 * error is not model-specific.
 *
 * Matched case-insensitively against the error string.
 */
const NON_MODEL_REJECTION_PATTERNS: RegExp[] = [
  // Org-level OAuth restriction (403)
  /oauth_not_allowed_for_organization/i,
  // Usage / credit limit (distinct from rate limit)
  /usage.?limit|credit.?balance|billing/i,
  // Anthropic permission denied (not model-specific)
  /permission denied/i,
];

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export interface RejectedModelResult {
  /** True when the error is a model-specific rejection eligible for fallback. */
  isModelRejection: boolean;
  /** Short human-readable reason extracted from the error message (≤120 chars). */
  reason: string;
}

/**
 * Classify whether a failed ToolResult's error string indicates that the
 * specific model chosen for the child was rejected by the backend, making
 * a fallback to a different model safe to attempt.
 *
 * Transient errors (429, 5xx), account-level org/auth errors (403), and any
 * unrecognised error are classified as NOT a model rejection.
 *
 * @param errorContent — the `content` field of a ToolResult where `isError` is true.
 */
export function classifyRejectedModel(errorContent: string): RejectedModelResult {
  const status = extractStatus(errorContent);

  // Transient: rate-limit or any 5xx → never fall back.
  if (status === 429 || (status !== undefined && status >= 500)) {
    return { isModelRejection: false, reason: errorContent.slice(0, 120) };
  }

  // Account-level patterns override everything — not model-specific.
  for (const pat of NON_MODEL_REJECTION_PATTERNS) {
    if (pat.test(errorContent)) {
      return { isModelRejection: false, reason: errorContent.slice(0, 120) };
    }
  }

  // Model rejection: must be HTTP 400 or 404 OR match a known pattern.
  const statusIsModelError = status === 400 || status === 404;
  const patternMatches = MODEL_REJECTION_PATTERNS.some((p) => p.test(errorContent));

  if (statusIsModelError || patternMatches) {
    // Trim to a short reason for the warning line and telemetry.
    const reason = errorContent.replace(/\n/g, ' ').slice(0, 120);
    return { isModelRejection: true, reason };
  }

  return { isModelRejection: false, reason: errorContent.slice(0, 120) };
}
