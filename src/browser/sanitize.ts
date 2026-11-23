/**
 * Sanitization helpers for browser observations and witness records.
 *
 * @module browser/sanitize
 */

import { createHash } from 'crypto';

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
