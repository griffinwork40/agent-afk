/**
 * Post-run result content warnings and pre-dispatch intent checks for
 * SubagentExecutor (issues #944, #3754).
 *
 * Centralises the warning prefixes that SubagentExecutor prepends to a tool
 * result after a child run completes:
 *
 * 1. Vision warning — the child model is not vision-capable but attachments
 *    were supplied (pre-existing behaviour, extracted here to reclaim headroom
 *    in the baselined subagent-executor.ts).
 * 2. Read-only write-intent warning — a read-only named agent (e.g.
 *    research-agent) received write-intent instructions; it completed silently
 *    with no artifact. Surfacing this in the tool result tells the dispatching
 *    model what happened and that findings are in the message, not a file.
 *
 * Also exports {@link classifyDispatchIntent} — the pre-dispatch gate added in
 * #3754 that rejects implementation briefs sent to read-only agents BEFORE
 * forking, so the parent receives an actionable error rather than a silent
 * no-op.
 *
 * Both post-run warnings are lightweight heuristics and are not guaranteed to
 * fire on every case; they are opt-in helpers, not hard constraints.
 * {@link classifyDispatchIntent} is conservative by design: false positives
 * (blocking a legitimate recon prompt) are far worse than false negatives, so
 * the patterns require unambiguous implementation verbs paired with file or
 * commit targets.
 *
 * @module agent/tools/subagent-executor.write-intent
 */

/**
 * Pattern matching write-intent phrases in an agent prompt.
 *
 * Branch 1 — verb + optional article + optional adjective(s) + noun keyword:
 *   Matches "write a brief document", "generate a detailed report",
 *   "save a file with findings".
 *
 * Branch 2 — verb + up to ~40 chars + filename.ext:
 *   Matches "write findings.md", "write F-rubric-audit.md",
 *   "save a plan.md", "write the results to output.md".
 *   The bounded .{0,40} keeps false positives low while covering intervening
 *   articles/prepositions like "a", "the", "a plan".
 *
 * This is a heuristic; false positives are worse than false negatives.
 */
const WRITE_INTENT_RE =
  /\b(write|save|persist|create|output|emit|dump|generate)\s+(a\s+)?(\w+\s+)?(file|report|artifact|doc|document|markdown|\.md)\b|\b(write|save|persist|create|output|emit|dump|generate)\s{1,5}.{0,40}\.(md|json|txt|ts|js|yaml|yml|csv|html)\b/i;

/**
 * Collect any warning prefixes to prepend to a subagent tool result.
 *
 * Returns the concatenated prefix (possibly empty string) to prepend to
 * `result.content`. Handles both the vision-capability and read-only
 * write-intent cases so the executor call site is a single expression.
 *
 * @param model        - Effective child model string (for vision check).
 * @param hasAttachments - Whether the dispatch included image attachments.
 * @param agentName    - Named agent type, or undefined for bare dispatches.
 *                       Bare dispatches (undefined) are exempt from the
 *                       write-intent warning even when childWriteCapable is false.
 * @param prompt       - The raw prompt string sent to the child.
 * @param childWriteCapable - Whether the child's tool surface allows writes.
 * @param supportsVisionFn - Injected capability check (default: model-caps).
 */
/**
 * Patterns that signal a brief is asking for file edits, commits, or code
 * changes — work a read-only agent structurally cannot perform.
 *
 * Conservative by design: we match ONLY unambiguous implementation verbs
 * paired with a code/file/commit target. Recon prompts that merely *mention*
 * editing (e.g. "do not edit files", "report what should be changed",
 * "identify which files need updating") must NOT match — the negation/passive
 * exemption below handles this.
 *
 * Pattern breakdown:
 *   Branch A — imperative edit/apply/implement + code target:
 *     "edit src/foo.ts", "apply the patch", "implement the feature",
 *     "fix the bug in auth.ts", "refactor the module", "update config.ts".
 *   Branch B — push with a destination:
 *     "push to main", "push to branch". Commit/deploy with a target are
 *     covered by branch A; a bare "commit" is often a git-history noun.
 *   Branch C — write_file / edit_file tool call intent:
 *     "call write_file", "use edit_file to".
 *
 * Not matched (conservative):
 *   - Negations: "do not edit", "never modify", "without changing".
 *   - Passive/report forms: "report what should be changed",
 *     "identify files to update", "describe edits needed".
 *   - Read-only recon mentions: "check if edit_file was called".
 */
const IMPL_INTENT_VERB_RE =
  /\b(edit|apply|implement|fix|refactor|update|modify|change|patch|write|commit|push|deploy)\s+(?:the\s+|a\s+|an\s+|your\s+)?(?:code|file|files|patch|diff|changes?|commit|implementation|feature|bug|fix|function|module|class|method|src|test|tests)\b|\b(edit|apply|implement|fix|refactor|update|modify|change|patch|write)\s+\S+\.\w{1,6}\b|\bpush\s+to\s+(?:the\s+)?(?:[\w./-]+\s+)?(?:branch|main|master)\b|\b(write_file|edit_file)\b/i;

/**
 * Patterns whose presence indicates the prompt is a RECON brief that merely
 * mentions editing in a negative or passive context. When any of these match
 * the same prompt, `classifyDispatchIntent` returns `false` (not
 * implementation intent) even if IMPL_INTENT_VERB_RE also matched.
 *
 * Covers:
 *   - Explicit negations: "do not edit", "don't modify", "never change",
 *     "without editing", "avoid writing".
 *   - Passive/report forms: "report what should be", "identify what needs",
 *     "describe which files", "list files that need", "find where edits".
 *   - "do not" / "don't" anywhere near an imperative verb.
 */
const RECON_EXEMPTION_RE =
  /\b(do\s+not|don'?t|never|avoid|without|instead\s+of)\s+\w*\s*(edit|modify|change|write|commit|push|apply|implement|patch|fix|update|refactor)\b|\b(report|describe|identify|list|find|check|show|tell|summarise?|summarize?|note|document)\s+(?:what|which|where|how|if|whether|any)\b/i;

/**
 * Classify a dispatch brief to determine whether it is requesting
 * implementation work that a read-only agent cannot perform.
 *
 * Returns `true` when the prompt unambiguously asks for file writes, code
 * edits, commits, or deployments — i.e. work the child's read-only tool
 * surface structurally cannot deliver. Returns `false` for legitimate recon
 * prompts that mention editing only in a negative or passive context (e.g.
 * "do not edit files", "report what should be changed").
 *
 * This is a CONSERVATIVE pre-dispatch gate (#3754). The threshold is
 * deliberately high: false positives (blocking a valid recon prompt) are far
 * worse than false negatives (letting a misrouted brief through to the
 * existing post-run warning path). Bare dispatches (no named agent) are
 * exempted by the caller — this function tests the brief only; the caller
 * decides whether to apply the check.
 */
export function classifyDispatchIntent(prompt: string): boolean {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return false;
  if (!IMPL_INTENT_VERB_RE.test(prompt)) return false;
  // Exempt recon prompts that mention editing only in a negative/passive context.
  if (RECON_EXEMPTION_RE.test(prompt)) return false;
  return true;
}

export function collectPostRunWarnings(
  model: string,
  hasAttachments: boolean,
  agentName: string | undefined,
  prompt: string,
  childWriteCapable: boolean,
  supportsVisionFn: (m: string) => boolean,
): string {
  let prefix = '';
  if (hasAttachments && !supportsVisionFn(model)) {
    prefix += `WARNING: child model ${model} is not vision-capable; attached images were dropped.\n\n`;
  }
  if (!childWriteCapable && agentName !== undefined && WRITE_INTENT_RE.test(prompt)) {
    prefix +=
      `WARNING: ${agentName} is read-only — write instructions were ignored. ` +
      `Findings are in the message below, not a file. ` +
      `Use a general-purpose agent when the task requires file output.\n\n`;
  }
  return prefix;
}
