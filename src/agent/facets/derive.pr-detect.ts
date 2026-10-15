/**
 * derive.pr-detect.ts — shared `gh pr create` detection helpers.
 *
 * Extracted from derive.ts so journal-adapter.ts can reuse the same logic
 * for subagent journals without a circular import. (#2795 gap 6)
 *
 * Consumers: derive.ts (parent-session detection) and
 * journal-adapter.ts (subagent-session detection via summarizeSubagentJournal).
 */

import { BARE_PR_URL_RESULT, PR_QUERY_INPUT } from '../outcomes/artifacts.js';
import type { ToolEventInput } from './schema.js';

// Invariant: a GitHub PR URL that is the whole of one output line. gh pr create
// prints the URL on its own line; a URL embedded in grep/rg output or prose is
// on a line with other text and does not match.
const GH_PR_URL_LINE_RE = /^[ \t]*(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+)[ \t]*$/gm;

/**
 * Strip double- and single-quoted spans so that shell-separator characters
 * (|, &, ;) inside argument strings (e.g. `rg "gh pr view|gh pr create"`)
 * do not masquerade as command separators for the invocation regex below.
 * Used only for regex matching — no index-based logic relies on the result.
 *
 * Contract: $() command substitutions inside double-quoted spans are also
 * erased (e.g. `PR_URL="$(gh pr create --fill)"` becomes spaces). Use
 * GH_CMD_SUBST_CREATE_RE on the raw input to catch that case separately.
 */
function stripQuotedSpans(s: string): string {
  return s.replace(/(?:"[^"]*"|'[^']*')/g, (m) => ' '.repeat(m.length));
}

// Invariant: `gh pr create` counts as an invocation only at:
//   - the start of the string (^)
//   - right after a shell separator (`;`, `&&`, `||`, `|`)
//   - right after an open-paren (`(` covers bare subshell and `$(...)`)
// optionally with env assignments (`GH_TOKEN=x gh pr create`).
// Always apply stripQuotedSpans before testing GH_PR_CREATE_INVOCATION_RE so
// that a `|` inside a quoted argument (rg "gh pr view|gh pr create" src) is
// not treated as a separator. See GH_CMD_SUBST_CREATE_RE below for the
// complementary raw-input scan that recovers $() inside double-quoted spans.
// The /m flag is dropped: stored bash inputs are flattened to a single line
// by summarizeToolInput when inputRaw is absent, so ^ and $ behave identically
// with or without it.
const GH_PR_CREATE_INVOCATION_RE =
  /(?:^|[;|&(])[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*gh[ \t]+pr[ \t]+create(?:[ \t]|$)/;

// Complementary pattern for command substitutions inside double-quoted spans.
// stripQuotedSpans erases "$(gh pr create --fill)" entirely, so a bare
// `PR_URL="$(gh pr create --fill)"` is never matched by GH_PR_CREATE_INVOCATION_RE
// on the stripped input. This RE scans the raw (unstripped) input for the `$(`
// opener followed immediately by `gh pr create`, which is unambiguously an
// invocation and not a quoted shell separator. It does NOT match `|gh pr create`
// so the rg "...| gh pr create " false-positive is not reintroduced.
const GH_CMD_SUBST_CREATE_RE =
  /\$\([ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*gh[ \t]+pr[ \t]+create(?:[ \t]|\))/;

// Secondary pattern for the flattened multi-line case: two separate shell
// commands (`git push\ngh pr create`) are collapsed to one line by
// summarizeToolInput, losing the newline separator. The negative lookbehind
// rejects `gh` that is part of a path or hyphenated token (e.g.
// `/usr/bin/gh` or `my-gh`), keeping only `gh` that appears as a command
// word. Combined with a bare-PR-URL result gate the false-positive rate is low.
const GH_PR_CREATE_WORD_RE = /(?<![\\/\w-])gh[ \t]+pr[ \t]+create(?:[ \t]|$)/;

/** Last GitHub PR URL that sits alone on an output line, or null. */
export function lastOwnLinePrUrl(result: string): string | null {
  let url: string | null = null;
  for (const m of result.matchAll(GH_PR_URL_LINE_RE)) url = m[1] ?? url;
  return url;
}

/**
 * Scan a list of ToolEventInput records and return the last GitHub PR URL
 * whose bash event looks like a real `gh pr create` invocation, or null.
 *
 * Used by both the parent-session path (derive.ts → aggregateToolEvents) and
 * the subagent-journal path (journal-adapter.ts → summarizeSubagentJournal)
 * so the detection rules are identical for both.
 */
export function detectPrUrlFromEvents(events: readonly ToolEventInput[]): string | null {
  let detectedPrUrl: string | null = null;

  for (const ev of events) {
    if (ev.toolName !== 'bash' || ev.isError === true || !ev.result) continue;

    const parsed = tryParseJson(ev.inputRaw ?? ev.input);
    const inputStr: string =
      (parsed !== undefined ? asString(parsed['command']) : undefined) ?? ev.input ?? '';

    const stripped = stripQuotedSpans(inputStr);
    const truncated = inputStr.trimEnd().endsWith('\u2026');

    // Truncated-input path: the command may have been cut before `gh pr create`.
    const isTruncatedCreate =
      truncated && BARE_PR_URL_RESULT.test(ev.result) && !PR_QUERY_INPUT.test(inputStr);

    // Flattened multi-line path: newline-joined commands lose the separator.
    const isFlattenedCreate =
      !truncated &&
      GH_PR_CREATE_WORD_RE.test(stripped) &&
      BARE_PR_URL_RESULT.test(ev.result) &&
      !PR_QUERY_INPUT.test(stripped);

    const isInvocation =
      GH_PR_CREATE_INVOCATION_RE.test(stripped) ||
      GH_CMD_SUBST_CREATE_RE.test(inputStr) ||
      isTruncatedCreate ||
      isFlattenedCreate;

    if (isInvocation) {
      detectedPrUrl = lastOwnLinePrUrl(ev.result) ?? detectedPrUrl;
    }
  }

  return detectedPrUrl;
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported — consumers use detectPrUrlFromEvents)
// ---------------------------------------------------------------------------

function tryParseJson(s: string | undefined): Record<string, unknown> | undefined {
  if (!s) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
