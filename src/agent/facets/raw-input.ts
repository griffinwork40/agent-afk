/**
 * Raw tool-input whitelist for facet derivation.
 *
 * The provider hot loop (anthropic-direct/loop.ts, openai-compatible/query.ts)
 * stamps a `toolInputRaw` field onto each tool-use event so facet derivation
 * (derive.ts) can extract the exact tool-input fields the summarized `input`
 * string loses. The whitelist holds ONLY non-sensitive scalar identifiers:
 *   - file_path  → read/write/edit evidence pointers
 *   - name       → skill label
 *   - id_prefix  → agent (subagent) label
 *
 * `command` is deliberately NOT whitelisted. A bash command is the single
 * highest inline-secret risk of any tool input (`export TOKEN=…`,
 * `curl -H "Authorization: Bearer …"`, `psql "postgres://user:pass@…"`), and
 * persisting it verbatim to the on-disk session sidecar would defeat the point
 * of this whitelist. derive.ts's only use of `command` is git-commit detection,
 * which runs against the already-truncated summarized `input` (a flattened,
 * ≤160-char one-line summary) instead — so no full command is ever persisted.
 * (Sidecars written
 * before this fix may still carry `command` in inputRaw; derive.ts reads it
 * there for backward-compat, but nothing writes it anymore.)
 *
 * Persisting the FULL raw input would write large and/or sensitive fields
 * verbatim to the sidecar on every tool call — write_file `content`, edit_file
 * `new_string`/`old_string`, browser_act `value`, and bash `command` — for zero
 * derivation benefit. `extractRawToolInput` projects the input down to the
 * whitelisted fields above and caps each, bounding sidecar growth and shrinking
 * the secret-at-rest surface.
 *
 * Invariant: RAW_INPUT_FIELDS must hold only non-sensitive scalar fields that
 * derive.ts reads AND that are safe to persist verbatim. This module is the
 * single source of that contract — never add a secret-bearing field (notably
 * `command`); add a field only when derive.ts consumes it and it cannot leak.
 *
 * `extractCaptureToolInput` is the CAPTURE-ONLY variant. It includes `command`
 * after passing it through the secret redactor, and applies a generous byte cap
 * (CAPTURE_FIELD_CAP). It is NOT used by derive.ts and MUST NOT be wired into
 * the session sidecar or the facet pipeline — those consumers require the strict
 * whitelist. Its sole consumer is subagent-output-capture.ts, which writes an
 * opt-in witness artifact that already carries a best-effort-redaction banner.
 */

import { redactSecrets } from '../redact-secrets.js';

/** The exact non-sensitive scalar fields facet derivation reads from a tool input. */
export const RAW_INPUT_FIELDS = ['file_path', 'name', 'id_prefix'] as const;

/** Per-field character cap — a pathologically large field value is truncated. */
export const RAW_INPUT_FIELD_CAP = 4096;

/**
 * Character cap for a single field in `extractCaptureToolInput`. Generous
 * enough to preserve a real bash command or file path, tight enough to bound
 * the witness artifact when a tool emits a multi-KB value (e.g. write_file
 * `content`, edit_file `new_string`).
 */
export const CAPTURE_FIELD_CAP = 8192;

/**
 * Project a tool input down to the whitelisted scalar fields facet derivation
 * consumes, JSON-serialized. Returns `undefined` when the input is not an
 * object or carries none of the relevant fields, so callers store nothing
 * rather than an empty `{}`. String fields are capped at RAW_INPUT_FIELD_CAP.
 */
export function extractRawToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of RAW_INPUT_FIELDS) {
    const value = obj[key];
    if (value === undefined) continue;
    picked[key] =
      typeof value === 'string' && value.length > RAW_INPUT_FIELD_CAP
        ? value.slice(0, RAW_INPUT_FIELD_CAP)
        : value;
  }
  return Object.keys(picked).length > 0 ? JSON.stringify(picked) : undefined;
}

/**
 * Extract verbatim tool input for CAPTURE purposes only — NOT for facet
 * derivation or the session sidecar. Unlike `extractRawToolInput`, this
 * function includes `command` (and all other scalar string fields) after
 * running each value through the secret redactor. All string values are
 * capped at CAPTURE_FIELD_CAP characters; non-string scalars are included
 * as-is; object and array fields are omitted.
 *
 * Contract: do NOT use this in derive.ts, the session sidecar, or any
 * consumer that stores data outside the opt-in witness artifact. Those paths
 * require the strict RAW_INPUT_FIELDS whitelist above. The caller
 * (subagent-output-capture.ts) already carries a best-effort-redaction
 * banner so the explicit redaction pass here still applies but is not a
 * security guarantee.
 *
 * Returns `undefined` for non-object inputs so callers can fall back cleanly.
 */
export function extractCaptureToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      const capped = value.length > CAPTURE_FIELD_CAP ? value.slice(0, CAPTURE_FIELD_CAP) : value;
      out[key] = redactSecrets(capped);
    } else if (value !== null && value !== undefined && typeof value !== 'object') {
      // Scalar non-strings (numbers, booleans) are safe to include verbatim.
      out[key] = value;
    }
    // Objects and arrays are omitted — they can be arbitrarily large and are
    // not useful for the "what command did the agent run" capture use case.
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : undefined;
}
