/**
 * Sanitization helpers for browser observations and witness records.
 *
 * Invariant: this module is the SINGLE source of truth for what counts as
 * a "secret" in the browser layer. Tool handlers, witness emitters, and the
 * observation builder all funnel through these helpers. If a new credential
 * format appears in the wild that we want to redact, add the pattern here
 * and call sites pick it up automatically.
 *
 * @module browser/sanitize
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

/**
 * Each pattern in this list is applied in order. A match replaces the full
 * matched substring with the literal token `'[redacted]'`. Patterns are kept
 * narrow on purpose — over-eager redaction destroys legibility of witness
 * traces; under-eager redaction leaks credentials. When in doubt, prefer the
 * narrower pattern.
 *
 * History: pattern set chosen to cover the credential shapes most likely to
 * appear in form-fill / typed values:
 *   - AWS Access Key:  20 chars AKIA + 16 alphanumeric uppercase
 *   - OpenAI-style:    sk-<≥20 alphanum/underscore/dash>
 *   - GitHub PAT:      ghp_<exactly 36 alphanum>
 *   - Slack token:     xox[abp]-<≥10 alphanum/dash>
 *   - form password:   password=<value> (form-encoded)
 *   - JWT:             three base64url segments ≥20 chars each
 *
 * Other formats (Stripe sk_live_, Twilio AC…, Cloudflare keys) can be added
 * here without touching call sites.
 */
interface RedactPattern {
  readonly name: string;
  readonly regex: RegExp;
}

const REDACT_PATTERNS: readonly RedactPattern[] = [
  // AWS access key: AKIA + exactly 16 alphanum uppercase chars.
  {
    name: 'aws-access-key',
    regex: /AKIA[0-9A-Z]{16}/g,
  },
  // GitHub PAT: ghp_ followed by exactly 36 alphanumeric chars. Tested
  // before the generic sk- pattern because both could otherwise be
  // ambiguous on the prefix.
  {
    name: 'github-pat',
    regex: /ghp_[a-zA-Z0-9]{36}/g,
  },
  // OpenAI-style bearer token: sk- followed by ≥20 alphanumeric, dash,
  // or underscore. Loose by design — the prefix is the strong signal.
  {
    name: 'openai-bearer',
    regex: /sk-[a-zA-Z0-9_-]{20,}/g,
  },
  // Slack token: xox[abp]- followed by ≥10 alphanum/dash chars.
  {
    name: 'slack-token',
    regex: /xox[abp]-[a-zA-Z0-9-]{10,}/g,
  },
  // JWT: three base64url-ish segments ≥20 chars each separated by dots.
  // We require ≥20 in each segment to avoid matching `eyJ.eyJ.sig` style
  // short test strings that aren't real tokens.
  {
    name: 'jwt',
    regex: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g,
  },
  // Form-encoded password field: password=<value> up to next & or end.
  // Replace ONLY the value, keeping the key visible — preserves trace
  // legibility while neutralizing the credential.
  {
    name: 'form-password',
    regex: /password=[^&\s]+/gi,
  },
];

/**
 * Replace secret-looking substrings with the literal `[redacted]`.
 *
 * Contract: returns the input string unchanged when no pattern matches.
 * Multiple patterns may match in a single input; each independent match is
 * replaced. The replacement preserves form-field structure for the
 * `password=` case (key name kept, value redacted).
 */
export function redactSecrets(input: string): string {
  if (input.length === 0) return input;
  let out = input;
  for (const { regex, name } of REDACT_PATTERNS) {
    // Special handling for form-password: keep the 'password=' key prefix
    // and only redact the value. All other patterns replace the entire match.
    if (name === 'form-password') {
      out = out.replace(regex, 'password=[redacted]');
    } else {
      out = out.replace(regex, '[redacted]');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// shouldRedactElementValue
// ---------------------------------------------------------------------------

/**
 * Description of an element's identifying fields, as far as redaction cares.
 * All fields optional so the helper can be called against partial DOM info.
 */
export interface ElementRedactionInput {
  /** ARIA role of the element. */
  role?: string;
  /**
   * Element subtype. For `<input>` this is the `type` attribute; for
   * buttons it is the variant. `null` (not undefined) means "not applicable
   * to this role" — both are treated identically here.
   */
  kind?: string | null;
  /** Best human-readable label, after resolution. May be empty. */
  label?: string;
}

/**
 * Sensitive-label regex. Catches `password`, `secret`, `token`,
 * `api_key`/`api-key`/`apikey`, `otp`, `2fa` in any case. Anchored loosely
 * because labels can contain extra words (`'Enter password'`, `'API Token'`).
 */
const SENSITIVE_LABEL_RE = /password|secret|token|api[_-]?key|otp|2fa/i;

/**
 * Returns `true` when the element's current value should be replaced with
 * the literal string `'[redacted]'` in the observation.
 *
 * The decision is the union of two rules:
 *   1. `role === 'textbox' && kind === 'password'` — the input-type signal.
 *   2. `label` matches the sensitive-label regex — covers placeholder text,
 *      aria-label, or visible label resolved by the observer.
 */
export function shouldRedactElementValue(el: ElementRedactionInput): boolean {
  if (el.role === 'textbox' && el.kind === 'password') return true;
  if (el.label && SENSITIVE_LABEL_RE.test(el.label)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// hashSelector
// ---------------------------------------------------------------------------

/**
 * Hash a CSS/xpath selector for inclusion in witness without exposing the
 * raw selector. Selectors can carry secrets (e.g. an attribute selector
 * matching a CSRF token), so the witness layer references them by their
 * 8-hex-char SHA-256 prefix only.
 *
 * Deterministic: same input always produces the same output.
 */
export function hashSelector(selector: string): string {
  return createHash('sha256').update(selector, 'utf8').digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// truncateTargetText
// ---------------------------------------------------------------------------

/**
 * Compress a target-text value for inclusion in a witness `target.text`
 * field. Collapses runs of whitespace (including newlines) to a single
 * space, trims, and truncates to 80 chars with a `...` ellipsis when the
 * collapsed length exceeds 80.
 *
 * The 80-char cap matches the contract in `BrowserEventTarget.text`.
 */
export function truncateTargetText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 80) return collapsed;
  return collapsed.slice(0, 77) + '...';
}

// ---------------------------------------------------------------------------
// summarizeObservation
// ---------------------------------------------------------------------------

/**
 * The minimal shape `summarizeObservation` needs from a `BrowserObservation`.
 * Defined inline so callers can pass partial objects (e.g. just-built
 * observations that haven't been assembled into the full shape yet).
 */
export interface ObservationSummaryInput {
  url: string;
  title: string;
  interactive: ReadonlyArray<{ label: string; role: string }>;
  status: { httpStatus: number | null; loadingState: string };
}

/**
 * Compress an observation to ≤500 chars for the
 * `BrowserEventPayload.observationSummary` field.
 *
 * Format: `<httpStatus|--> <url> | <title> | [role:label, role:label, role:label]`
 *
 * Invariant: the returned string MUST be ≤500 chars. If the natural
 * composition exceeds 500, the URL/title/elements are truncated in that
 * order until the cap is met. The httpStatus prefix and array bracket
 * structure are always preserved so readers can pattern-match the format.
 */
export function summarizeObservation(obs: ObservationSummaryInput): string {
  const statusStr = obs.status.httpStatus === null ? '--' : String(obs.status.httpStatus);
  const top = obs.interactive.slice(0, 3);
  const elementsRendered = `[${top.map((e) => `${e.role}:${e.label}`).join(', ')}]`;
  const composed = `${statusStr} ${obs.url} | ${obs.title} | ${elementsRendered}`;
  if (composed.length <= 500) return composed;

  // Over budget — truncate the URL and title proportionally. Always keep
  // the status prefix and elements array shape intact so format consumers
  // (e.g. /afk show, future replay tooling) can still parse the line.
  // Budget breakdown:
  //   status (≤3 chars + space) + ' | ' (3) + ' | ' (3) + elements (variable)
  //   = small fixed overhead. Remaining budget split 60/40 between url/title.
  const fixedOverhead = statusStr.length + 1 + 3 + 3;
  const elementsBudget = Math.min(elementsRendered.length, 150);
  const renderedElements = elementsRendered.length <= elementsBudget
    ? elementsRendered
    : elementsRendered.slice(0, elementsBudget - 3) + '...';
  const remaining = 500 - fixedOverhead - renderedElements.length;
  const urlBudget = Math.max(20, Math.floor(remaining * 0.6));
  const titleBudget = Math.max(10, remaining - urlBudget);
  const truncatedUrl = obs.url.length > urlBudget ? obs.url.slice(0, urlBudget - 3) + '...' : obs.url;
  const truncatedTitle = obs.title.length > titleBudget
    ? obs.title.slice(0, titleBudget - 3) + '...'
    : obs.title;
  const out = `${statusStr} ${truncatedUrl} | ${truncatedTitle} | ${renderedElements}`;
  // Defense in depth: if the budget math drifted, hard-cap.
  return out.length <= 500 ? out : out.slice(0, 500);
}
