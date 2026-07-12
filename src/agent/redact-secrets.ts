/**
 * Pure secret-redaction helper for text that is about to leave the local
 * process or be written to durable storage.
 *
 * Extracted from `background-summarizer.ts` (which redacts transcript tails
 * before shipping them to a third-party Haiku call) so that lightweight
 * externalization sinks can reuse the exact same patterns without importing
 * the summarizer's provider-call dependency graph. Current consumers:
 *   - `background-summarizer.ts` — transcript tail → Haiku (network egress)
 *   - `session-ledger.ts`        — tool-input summary → events.jsonl (at-rest)
 *   - `telegram/streaming.ts`    — subagent tool-input summary → Telegram (egress)
 *
 * Intentionally pure — no I/O, no SDK imports — so any layer may depend on it.
 *
 * @module agent/redact-secrets
 */

/**
 * Strip common secret patterns from a string before it leaves the local
 * process. Replaces matches with the literal string `[REDACTED]`.
 *
 * Patterns covered:
 *   - Authorization header bearer tokens   `Authorization: Bearer <value>`
 *   - Anthropic API keys                   `sk-ant-[A-Za-z0-9_-]{20,}`
 *   - JWT tokens                           `<header>.<payload>.<signature>`
 *     where header and payload are base64url JSON (always start with `eyJ`).
 *     Matched explicitly because the generic length rule below uses a
 *     dot-boundary lookbehind that would skip dot-separated JWT segments.
 *   - AWS IAM credential IDs               20-char tokens with known prefix
 *     (AKIA = long-lived, ASIA = STS, AROA = role, AIDA = user, ...) — below
 *     the generic 32-char floor so they need explicit coverage.
 *   - Generic long opaque tokens           ≥32 contiguous non-whitespace chars
 *     that consist entirely of hex or base64 alphabet characters (heuristic).
 *     Runs shaped like a filesystem/URL path are excluded — see
 *     `looksLikeFilesystemPath` — so a long bare `cd <path>` argument is not
 *     mistaken for a secret.
 *
 * Explicit patterns run BEFORE the generic length rule so short or
 * dot-separated tokens get redacted regardless of the 32-char floor.
 */
export function redactSecrets(text: string): string {
  return text
    // Authorization: Bearer <token>  (case-insensitive header)
    .replace(/\bauthorization:\s*bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]')
    // Anthropic API keys: sk-ant-<payload>
    .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    // JWT tokens: header.payload.signature — each segment is base64url-encoded
    // and `eyJ` is the deterministic prefix for `{"` (any JSON object). Three
    // segments required (unsigned JWTs with empty signature are intentionally
    // not matched here — they're rare and explicitly insecure).
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    // AWS IAM credential IDs — 20 chars total (prefix + 16 base32 chars).
    // Prefixes per AWS docs: long-term (AKIA), STS temporary (ASIA), role
    // (AROA), user (AIDA), group (AGPA), instance profile (AIPA), managed
    // policy (ANPA/ANVA), public key (APKA), server cert (ABIA), context (ACCA).
    .replace(/\b(?:AKIA|ASIA|AROA|AIDA|AGPA|AIPA|ANPA|ANVA|APKA|ABIA|ACCA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    // Generic long hex/base64 secrets (≥32 chars of [A-Za-z0-9+/=_-]).
    // The word-boundary lookaround only guards where a match may START — it
    // does NOT stop the class from swallowing `/`, so a long bare path argument
    // (`cd /Users/me/Projects/open_source/agent-afk`) matched as one contiguous
    // token and was redacted to `[REDACTED]`. The path-shape guard below carves
    // real paths back out; genuine opaque tokens are still redacted.
    .replace(/(?<![/.\w])[A-Za-z0-9+/=_-]{32,}(?![/.\w])/g, (m) =>
      looksLikeFilesystemPath(m) ? m : '[REDACTED]');
}

/**
 * True when a generic-rule match is a filesystem/URL path rather than an opaque
 * secret. The generic token class includes `/`, `_`, `-` — the characters a
 * path is built from — so a long bare path would otherwise be redacted.
 *
 * Heuristic: a run is a path when it contains a `/` separator AND none of
 * base64's exclusive characters (`+`, `=`). base64url (JWTs, most modern API
 * tokens) uses `-`/`_` and hex/alphanumeric keys have no `/` at all, so those
 * still match and are redacted; classic base64 carries `+`/`=`, so it is still
 * redacted even with a `/`. Accepted gap: a classic-base64 blob containing `/`
 * but neither `+` nor `=` is preserved — the high-value named secrets (sk-ant,
 * Bearer, JWT, AWS) are already covered by the explicit rules that run first,
 * and this generic rule is only a heuristic backstop.
 */
function looksLikeFilesystemPath(run: string): boolean {
  return run.includes('/') && !/[+=]/.test(run);
}
