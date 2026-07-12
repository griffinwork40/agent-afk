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
 *     mistaken for a secret. An opaque token fused into a path segment
 *     (`/tmp/uploads/<token>`) is still redacted (rule 3 of that guard).
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
    // real paths back out; genuine opaque tokens — including one fused into a
    // path segment (`/tmp/uploads/<token>`, rule 3) — are still redacted.
    .replace(/(?<![/.\w])[A-Za-z0-9+/=_-]{32,}(?![/.\w])/g, (m) =>
      looksLikeFilesystemPath(m) ? m : '[REDACTED]');
}

/**
 * True when a generic-rule match is a filesystem/URL path rather than an opaque
 * secret. The generic token class includes `/`, `_`, `-` — the characters a
 * path is built from — so a long bare path would otherwise be redacted.
 *
 * A run is a path only when ALL hold:
 *   1. it contains a `/` separator, and
 *   2. it carries none of base64's exclusive chars (`+`, `=`) — classic base64
 *      (JWT sigs aside) is a secret, not a path, so a run with `+`/`=` is redacted;
 *   3. no single `/`-delimited segment is itself a long opaque token — i.e. a
 *      secret fused into a path segment (`/tmp/uploads/<44-char token>`) is
 *      redacted, not spared. "Long opaque token" = ≥32 chars, mixing letters
 *      and digits, with no dotted extension. (The generic-rule class excludes
 *      `.`, so a matched run never contains one; the dot check is defensive for
 *      standalone use.)
 *
 * base64url tokens (JWTs, most modern API keys) use `-`/`_` and have no `/`, so
 * they never reach this guard and are redacted by the generic rule; a token
 * fused into a path is caught by rule 3.
 *
 * Accepted residual gap: an unusually long (≥32-char) DOTLESS path segment that
 * mixes letters and digits — a raw hash directory or a UUID-without-dashes — is
 * over-redacted (treated as a token). Rare and cosmetic; it fails safe, and the
 * common case (short word segments, e.g. `/Users/me/Projects/open_source/agent-afk`)
 * is preserved. The high-value NAMED secrets (sk-ant, Bearer, JWT, AWS) are
 * covered by the explicit rules that run first, regardless of path context.
 */
function looksLikeFilesystemPath(run: string): boolean {
  if (!run.includes('/') || /[+=]/.test(run)) return false;
  const isOpaqueTokenSegment = (seg: string): boolean =>
    seg.length >= 32 && !seg.includes('.') && /[A-Za-z]/.test(seg) && /[0-9]/.test(seg);
  return !run.split('/').some(isOpaqueTokenSegment);
}
