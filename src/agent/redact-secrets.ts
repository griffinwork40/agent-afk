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
 * `looksLikeFilesystemPath` is also exported standalone (not just used inside
 * `redactSecrets`'s generic-token rule): `session/prompt-dump.ts`'s
 * `NAME=value` replacers reuse it directly to spare path-shaped values from a
 * key-name-only match (issue #949) — see that module for why key-name alone
 * is unreliable evidence of a secret.
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
 *   - Bearer tokens (bare or in header)     `Bearer <value>` / `Authorization: Bearer <value>`
 *   - Anthropic API keys                   `sk-ant-[A-Za-z0-9_-]{8,}`
 *   - OpenAI / generic `sk-` keys          `sk-<payload>` (non-ant prefix)
 *   - JWT tokens                           `<header>.<payload>.<signature>`
 *     where header and payload are base64url JSON (always start with `eyJ`).
 *     Matched explicitly because the generic length rule below uses a
 *     dot-boundary lookbehind that would skip dot-separated JWT segments.
 *   - AWS IAM credential IDs               20-char tokens with known prefix
 *     (AKIA = long-lived, ASIA = STS, AROA = role, AIDA = user, ...) — below
 *     the generic 32-char floor so they need explicit coverage.
 *   - Slack tokens                         `xox[baprs]-<payload>`
 *   - Telegram bot tokens                  `<8–12 digits>:<35 alphanum chars>`
 *   - Generic long opaque tokens           ≥32 contiguous non-whitespace chars
 *     that consist entirely of hex or base64 alphabet characters (heuristic).
 *     Runs shaped like a filesystem/URL path are excluded — see
 *     `looksLikeFilesystemPath` — so a long bare `cd <path>` argument is not
 *     mistaken for a secret. An opaque token fused into a path segment
 *     (`/tmp/uploads/<token>`) is still redacted (rule 3 of that guard).
 *     Git object names (40/64-char lowercase-hex SHA-1/SHA-256, including a
 *     `NAME=<sha>` shell assignment) are also excluded — see `isGitObjectName`
 *     — so `git show <sha>` and `REF=<sha>` render legibly in tool-lane labels
 *     instead of `git show [REDACTED]`. Only an exact-match allowlist of
 *     git-ish names (`REF`, `SHA`, `COMMIT`, `BASE`) is spared; any other
 *     assignment (`TOKEN=<sha>`, `COOKIE=<sha>`) is still redacted.
 *
 * Explicit patterns run BEFORE the generic length rule so short or
 * dot-separated tokens get redacted regardless of the 32-char floor.
 */
export function redactSecrets(text: string): string {
  return text
    // Bare Bearer <token> — case-insensitive, no header prefix required.
    // Matches e.g. `API error: Bearer eyJ…` in addition to the header form below.
    // Must run BEFORE the Authorization-header rule so the header form is also
    // caught by this pass (the header rule is kept as a belt-and-suspenders
    // variant that preserves the `Authorization: Bearer` label text).
    //
    // False-positive guard: require ≥8 non-whitespace chars after `bearer ` AND
    // exclude common English stopwords (`of`, `to`, `the`, `a`, `an`, `token`,
    // `tokens`) via a negative lookahead — so `the bearer of bad news` and
    // `invalid bearer token` are NOT redacted, while `Bearer abcdef01234567`
    // still is. The 8-char floor is low enough to catch real short-lived tokens
    // (per-request nonces) while rejecting single English words.
    // The `bearer` keyword itself is captured so its original casing is preserved
    // in the replacement (e.g. `authorization: bearer …` keeps lower-case `bearer`
    // rather than being rewritten to Title-case by a literal replacement string).
    //
    // NOTE: the stopword lookahead uses `\s` (not `\b`) because `\b` fires at a
    // hyphen boundary — `token-abc12345` has a `\b` after `token`, so the old
    // `\b`-terminated lookahead incorrectly matched `token` in that string and
    // suppressed redaction of `Bearer token-abc12345`. Using `\s` requires the
    // stopword to be followed by actual whitespace, so hyphenated tokens like
    // `token-abc12345` or `the-quick-brown` are no longer false-positives (issue #3967).
    .replace(/\b(bearer)\s+(?!(?:of|to|the|an?|tokens?)\s)\S{8,}/gi, '$1 [REDACTED]')
    // Authorization: Bearer <token>  (case-insensitive header — full label
    // preserved via capture group so `authorization: bearer …` is not rewritten
    // to Title-case. Belt-and-suspenders over the bare-bearer rule above; fires
    // on any residual header forms the bare rule did not reach).
    .replace(/\b(authorization:\s*bearer)\s+\S+/gi, '$1 [REDACTED]')
    // Anthropic API keys: sk-ant-<payload ≥8 chars> (floor matches original inline pattern)
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    // OpenAI / generic sk- keys (non-ant): sk-<payload ≥20 chars>
    .replace(/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    // Slack bot/user/app/workspace tokens: xox[baprs]-<payload>
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
    // Telegram bot tokens: <8–12 digits>:<35 alphanumeric chars>.
    // No leading \b on the digit run — \b between a letter and a digit does not
    // fire (e.g. `/bot123456789:…`), so the old inline pattern had no \b here.
    // Use a negative lookbehind for digits to avoid splitting a longer number,
    // and a negative lookahead to avoid matching a prefix of a longer token.
    .replace(/(?<!\d)\d{8,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, '[REDACTED]')
    // JWT tokens: header.payload.signature — each segment is base64url-encoded
    // and `eyJ` is the deterministic prefix for `{"` (any JSON object). Three
    // segments required (unsigned JWTs with empty signature are intentionally
    // not matched here — they're rare and explicitly insecure).
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    // AWS IAM credential IDs — 20 chars total (prefix + 16 base32 chars).
    // Prefixes per AWS docs: long-term (AKIA), STS temporary (ASIA), role
    // (AROA), user (AIDA), group (AGPA), instance profile (AIPA), managed
    // policy (ANPA/ANVA), public key (APKA), server cert (ABIA), context (ACCA).
    // No leading \b — the old inline pattern had none, so `keyAKIA…` (lowercase
    // before the prefix) is still caught. A negative lookbehind for uppercase
    // letters blocks matches mid-uppercase-run (e.g. `XAKIAFAKEKEY…` would
    // match the `AKIA` inside `XAKIA`). Trailing \b is kept so we don't clip a
    // longer uppercase run mid-token.
    .replace(/(?<![A-Z])(?:AKIA|ASIA|AROA|AIDA|AGPA|AIPA|ANPA|ANVA|APKA|ABIA|ACCA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    // Generic long hex/base64 secrets (≥32 chars of [A-Za-z0-9+/=_-]).
    // The word-boundary lookaround only guards where a match may START — it
    // does NOT stop the class from swallowing `/`, so a long bare path argument
    // (`cd /Users/me/Projects/open_source/agent-afk`) matched as one contiguous
    // token and was redacted to `[REDACTED]`. The path-shape guard below carves
    // real paths back out; genuine opaque tokens — including one fused into a
    // path segment (`/tmp/uploads/<token>`, rule 3) — are still redacted.
    .replace(/(?<![/.\w])[A-Za-z0-9+/=_-]{32,}(?![/.\w])/g, (m) =>
      looksLikeFilesystemPath(m) || isGitObjectName(m) ? m : '[REDACTED]');
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
export function looksLikeFilesystemPath(run: string): boolean {
  if (!run.includes('/') || /[+=]/.test(run)) return false;
  const isOpaqueTokenSegment = (seg: string): boolean =>
    seg.length >= 32 && !seg.includes('.') && /[A-Za-z]/.test(seg) && /[0-9]/.test(seg);
  return !run.split('/').some(isOpaqueTokenSegment);
}

/**
 * True when a generic-rule match is a git object name (a SHA-1 or SHA-256
 * commit/tree/blob id) rather than an opaque secret — same hex shape, so the
 * generic rule used to redact `git show <sha>` to `git show [REDACTED]`. Two
 * shapes are spared: a bare SHA arg (`git cat-file -t <sha>`), and a
 * `NAME=<sha>` shell assignment (`REF=<sha> && git show $REF:…`, matched whole
 * because `=` is in the token class).
 *
 * Spared only when EXACTLY 40/64-char lowercase-hex (uppercase/off-width stays
 * redacted). For the assignment form, NAME must EXACT-match (case-insensitive)
 * an ALLOWLIST — `REF`, `SHA`, `COMMIT`, `BASE` — not a denylist of
 * secret-sounding words: a denylist defaults to *spared* for any unrecognized
 * name (`COOKIE=`, `SESSION=`, `BEARER=`, `PAT=` all slipped through an
 * earlier version of this check); this allowlist defaults to *redacted*.
 *
 * Accepted residual risk (narrow): a BARE 40/64-char lowercase-hex secret
 * (e.g. a legacy 40-hex GitHub PAT, or `openssl rand -hex 20/32` output) is
 * still spared by the unnamed branch above — the allowlist only gates the
 * `NAME=<sha>` form. Named high-value secrets (sk-ant, Bearer, JWT, AWS key
 * ids, base64/base64url/mixed-case blobs) are still caught by the explicit
 * rules that run BEFORE the generic rule.
 */
function isGitObjectName(run: string): boolean {
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(run)) return true;
  const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(?:[0-9a-f]{40}|[0-9a-f]{64})$/.exec(run);
  return assign !== null && /^(?:ref|sha|commit|base)$/i.test(assign[1] ?? '');
}
