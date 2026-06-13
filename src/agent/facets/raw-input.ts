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
 * which runs against the already-truncated summarized `input` (≤80-char first
 * line) instead — so no full command is ever persisted. (Sidecars written
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
 */

/** The exact non-sensitive scalar fields facet derivation reads from a tool input. */
export const RAW_INPUT_FIELDS = ['file_path', 'name', 'id_prefix'] as const;

/** Per-field character cap — a pathologically large field value is truncated. */
export const RAW_INPUT_FIELD_CAP = 4096;

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
