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

const EDIT_VERB = String.raw`(?:edit|apply|implement|fix|refactor|update|modify|change|patch|write)`;

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
      String.raw`(${EDIT_VERB}\s+(?:(?:the|a|an|your)\s+)?(?:code|file|files|patch|diff|changes?|commit|implementation|feature|bug|fix|function|module|class|method|src|test|tests)\b)`,
    'i',
  ),
  new RegExp(
    CLAUSE_LEAD +
      String.raw`((?:commit|push|deploy)\s+(?:(?:the|your|these|this|all|my)\s+)?(?:changes?|code|fix(?:es)?|work|it|them|to\s+(?:(?:the|a)\s+)?[\w./-]+(?:\s+branch)?|origin\s+[\w./-]+))`,
    'i',
  ),
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
 */
export function classifyDispatchIntent(prompt: string): string | undefined {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return undefined;
  let matched: string | undefined;
  for (const re of IMPL_INTENT_PATTERNS) {
    const m = re.exec(prompt);
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
