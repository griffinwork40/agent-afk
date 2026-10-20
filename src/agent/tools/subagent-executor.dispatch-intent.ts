/**
 * Pre-dispatch implementation-intent gate (#3754).
 *
 * Read-only named agents (e.g. research-agent) given implementation briefs
 * used to evade the read-only bash classifier and write files anyway, so such
 * dispatches are refused BEFORE forking. This module owns the classifier and
 * the refusal builders for both dispatch paths:
 *   - the `agent` tool (`checkReadOnlyDispatchIntent`, subagent-executor.execute-once.ts);
 *   - compose DAG nodes (`checkComposeReadOnlyDispatchIntent`, compose-executor.ts).
 *
 * Conservative by design: false positives (blocking a legitimate recon or
 * review brief) are far worse than false negatives (a misrouted brief still
 * hits the read-only tool surface and the post-run warning path).
 *
 * @module agent/tools/subagent-executor.dispatch-intent
 */

import type { RegisteredAgent } from '../agents/index.js';
import type { ToolResult } from './types.js';

/**
 * Contract: Strip clearly-delimited quoted content from a prompt before intent
 * classification (#4057). Write verbs that appear inside quoted or attributed
 * content should not trigger the implementation-intent gate.
 *
 * Stripped regions (conservative — only complete, balanced delimiters):
 *   1. Fenced code blocks: ```...``` or ~~~...~~~  (multiline, balanced)
 *   2. Inline code spans: `...`  (single-line only — a backtick that opens
 *      but never closes on the same line is left in place, failing closed)
 *   3. Markdown blockquote lines: lines beginning with > (one or more)
 *   4. Double-quoted strings: "..."  (single-line only, balanced — an
 *      unclosed double-quote on the same line is left in place, failing closed)
 *   5. Attributed critic items: a bullet (`-`, `*`, `•`) followed by a
 *      critic name and a REQUIRED parenthesised severity keyword
 *      (low|medium|high|critical), e.g. `- pragmatist (medium): edit …`.
 *      The severity paren is mandatory so that plain labelled steps such as
 *      `- Step 1: edit src/a.ts`, `- Fix: rewrite …`, or `- Task: implement …`
 *      are NOT stripped — they are genuine directives addressed to the agent.
 *      Only horizontal whitespace ([ \t]) is used; \s is excluded to prevent
 *      the pattern from matching across a newline (#4101).
 *
 * Invariant: Only COMPLETE delimiters are stripped; an unclosed fence/quote/span
 *   leaves the content in place so a real instruction cannot hide behind it.
 *   The raw prompt (not the stripped version) is used for RECON_EXEMPTION_RE
 *   so negation phrases inside quotes still exempt the whole prompt.
 *   The stripped text may be shorter but is never replaced with content that
 *   introduces new verbs — replacements are empty string or a single space.
 *
 * Exported for tests; not part of the public API.
 */
export function stripQuotedContent(prompt: string): string {
  let s = prompt;

  // 1. Fenced code blocks (``` or ~~~, balanced open/close fence).
  //    The fence marker must be at least 3 chars; the closing fence must match
  //    the opening marker character. `[\s\S]*?` is non-greedy so nested fences
  //    are handled conservatively (outer wins).
  s = s.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\s*$/gm, '');

  // 2. Inline code spans: `...` — single backtick, same line only.
  //    The negative lookahead prevents matching across a newline.
  s = s.replace(/`[^`\n]+`/g, '');

  // 3. Markdown blockquote lines (one or more leading `>`).
  s = s.replace(/^[ \t]*>+[^\n]*/gm, '');

  // 4. Double-quoted strings — same-line only, balanced.
  //    Allows escaped quotes inside: \"  (simple backslash escape only).
  s = s.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  // 5. Attributed critic items: `- CriticName (severity): rest of line`
  //    Matches a bullet followed by a critic name (letters/digits/spaces/hyphens)
  //    and a REQUIRED parenthesised severity keyword (low|medium|high|critical),
  //    then `: ` and the rest of the line. The entire line is replaced with just
  //    the bullet so list structure is preserved but the attributed content is gone.
  //
  //    Invariant: only horizontal whitespace ([ \t]) is used throughout — \s is
  //    excluded to prevent the label from spanning a newline and silently hiding
  //    a directive on the following line (#4101). The severity paren is mandatory
  //    so plain steps like `- Step 1: …`, `- Fix: …`, `- Task: …` are not stripped.
  s = s.replace(
    /^([ \t]*[-*•][ \t]+)[A-Za-z][\w -]{0,40}[ \t]*\((?:low|medium|high|critical)\)[ \t]*:[ \t]+[^\n]+$/gm,
    '$1',
  );

  return s;
}

/**
 * Directive position: an implementation verb only counts when it opens a
 * clause — start of the brief, after sentence punctuation or a newline, after
 * a list bullet, or after an explicit directive connector ("then", "please",
 * "you must", "your task is to"). Why: review briefs mention commits, fixes,
 * and changes as NOUNS mid-sentence ("Review the fix commit 4b6babb",
 * "review commit 4b6babb on branch afk/pr-3889", "post-change file contents");
 * a real implementation brief issues the verb as an imperative. Anchoring on
 * clause position (instead of matching the verb anywhere, which also let `\b`
 * fire after a hyphen in "post-change") removes those false positives while
 * keeping "fix the bug in auth.ts" / "Read X, then edit src/foo.ts".
 */
const CLAUSE_LEAD =
  String.raw`(?:^\s*|[.!?;:]\s+|\n\s*|\b(?:please|then|and|also|now|first,?|next,?|finally,?|(?:task|job|goal)\s+is\s+to|you\s+(?:must|should|will|need\s+to))\s+)(?:[-*•]\s+|\d+[.)]\s+)?`;

const EDIT_VERB = String.raw`(?:edit|apply|implement|fix|refactor|update|modify|change|patch|write|rewrite)`;

/**
 * Ordered implementation-intent patterns. Capture group 1 is the phrase
 * reported back in the refusal so the parent can see exactly what tripped it.
 *   1. edit-verb + filename: "edit src/foo.ts", "update config.ts" (first, so
 *      the reported phrase carries the full path rather than "edit src").
 *   2. edit-verb + code target noun: "implement the feature", "fix the bug".
 *   3. commit/push/deploy + work object: "commit the changes", "push to main".
 *      A bare hash ("commit 4b6babb") or past tense ("pushed") never matches.
 *   4. explicit write-tool instruction: "use edit_file", "call write_file".
 */
const IMPL_INTENT_PATTERNS: readonly RegExp[] = [
  new RegExp(CLAUSE_LEAD + String.raw`(${EDIT_VERB}\s+[^\s.]\S*\.\w{1,6}\b)`, 'i'),
  new RegExp(
    CLAUSE_LEAD +
      String.raw`(${EDIT_VERB}\s+(?:(?:the|a|an|your)\s+)?(?:code|file|files|patch|diff|changes?|commit|implementation|feature|bug|fix|function|module|class|method|src|test|tests|handler|parser)\b)`,
    'i',
  ),
  new RegExp(
    CLAUSE_LEAD +
      String.raw`((?:commit|push|deploy)\s+(?:(?:the|your|these|this|all|my)\s+)?(?:changes?|code|fix(?:es)?|work|it|them|to\s+(?:(?:the|a)\s+)?[\w./-]+(?:\s+branch)?|origin\s+[\w./-]+))`,
    'i',
  ),
  // Pattern 4 does not use CLAUSE_LEAD: "use edit_file" / "call write_file"
  // name a TOOL explicitly, so position is irrelevant — any appearance of the
  // tool name as the object of a dispatch verb is an unambiguous write intent
  // regardless of whether it sits at a clause boundary.
  /((?:use|call|invoke|using|via)\s+(?:the\s+)?(?:write_file|edit_file)\b)/i,
];

/**
 * Negation/passive recon phrasing. When present anywhere, the brief is treated
 * as recon even if an implementation pattern matched ("do not edit files",
 * "report what should be changed", "find where the bug is but do not fix it").
 */
const RECON_EXEMPTION_RE =
  /\b(do\s+not|don'?t|never|avoid|without|instead\s+of)\s+\w*\s*(edit|modify|change|write|commit|push|apply|implement|patch|fix|update|refactor)\b|\b(report|describe|identify|list|find|check|show|tell|summarise?|summarize?|note|document)\s+(?:what|which|where|how|if|whether|any)\b/i;

/**
 * Classify a dispatch brief. Returns the matched implementation phrase (e.g.
 * `"edit src/foo.ts"`) when the brief unambiguously asks for file writes,
 * code edits, or commits; `undefined` for recon/review briefs. Bare
 * dispatches are exempted by the callers, not here.
 *
 * Implementation patterns are matched against a stripped copy of the prompt
 * (quoted content removed via `stripQuotedContent`) so that write verbs
 * appearing inside fenced blocks, inline code spans, blockquote lines,
 * double-quoted strings, or attributed list items do not trigger the gate
 * (#4057). RECON_EXEMPTION_RE is still evaluated against the raw prompt so
 * negation phrases inside quoted regions also exempt the whole brief.
 */
export function classifyDispatchIntent(prompt: string): string | undefined {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return undefined;
  const stripped = stripQuotedContent(prompt);
  let matched: string | undefined;
  for (const re of IMPL_INTENT_PATTERNS) {
    const m = re.exec(stripped);
    if (m?.[1] !== undefined) {
      matched = m[1].trim();
      break;
    }
  }
  if (matched === undefined) return undefined;
  if (RECON_EXEMPTION_RE.test(prompt)) return undefined;
  return matched;
}

/** Shared refusal text so the agent and compose paths read the same. */
function refusalText(agentName: string, matched: string): string {
  return (
    `Cannot dispatch implementation work to read-only agent "${agentName}" ` +
    `(matched: ${JSON.stringify(matched)}). ` +
    `This agent type is read-only and cannot write files, apply edits, or commit changes. ` +
    `Use a write-capable agent (e.g. general-purpose) for implementation tasks, ` +
    `or ask this agent to return a patch/findings for the parent to apply.`
  );
}

/**
 * `agent`-tool gate. Returns a refusal when a read-only named agent
 * (`!childWriteCapable`) receives an implementation brief; `undefined` when
 * the dispatch is permitted. Bare dispatches (`namedAgent === undefined`) are
 * exempt.
 */
export function checkReadOnlyDispatchIntent(
  childWriteCapable: boolean,
  namedAgent: RegisteredAgent | undefined,
  prompt: string,
  classifyFn: (p: string) => string | undefined,
): ToolResult | undefined {
  if (childWriteCapable || namedAgent === undefined) return undefined;
  const matched = classifyFn(prompt);
  if (matched === undefined) return undefined;
  return { content: refusalText(namedAgent.name, matched), isError: true };
}

/**
 * Compose gate. Mirrors the eager agent_type-miss failure: runs after every
 * node's agent_type resolved and before any node forks, refusing the WHOLE
 * call and naming the first offending node. Only nodes whose resolved agent is
 * read-only (`readOnly: true`, derived from the same write-capability
 * predicate as the agent path) are checked; bare nodes are exempt.
 *
 * **Length/shape invariant**: `nodes` and `resolvedAgents` MUST be parallel
 * arrays of the same length — `resolvedAgents[i]` is the resolution result
 * for `nodes[i]`. The caller (compose-executor.ts) satisfies this by building
 * `resolvedAgents` with `parsed.nodes.map(resolveComposeNodeAgent)` over the
 * same `parsed.nodes` array passed here as `nodes`. If the arrays are ragged,
 * out-of-bounds indices return `undefined`; the `?.readOnly !== true` guard
 * then treats the orphaned node as write-capable and skips it silently — a
 * safe conservative default, but the invariant must be maintained by callers.
 */
export function checkComposeReadOnlyDispatchIntent(
  nodes: ReadonlyArray<{ id: string; prompt: string; agent_type?: string }>,
  resolvedAgents: ReadonlyArray<{ readOnly?: true }>,
  classifyFn: (p: string) => string | undefined = classifyDispatchIntent,
): ToolResult | undefined {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n === undefined || n.agent_type === undefined || resolvedAgents[i]?.readOnly !== true) continue;
    const matched = classifyFn(n.prompt);
    if (matched === undefined) continue;
    return { content: `Compose node "${n.id}": ${refusalText(n.agent_type, matched)}`, isError: true };
  }
  return undefined;
}
