/**
 * Post-run result content warnings for SubagentExecutor (issue #944).
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
 * Both warnings are lightweight heuristics and are not guaranteed to fire on
 * every case; they are opt-in helpers, not hard constraints.
 *
 * @module agent/tools/subagent-executor.write-intent
 */

/** Pattern matching write-intent phrases in an agent prompt. */
const WRITE_INTENT_RE =
  /\b(write|save|persist|create|output|emit|dump|generate)\s+(a\s+)?(file|report|output|artifact|doc|document|markdown|\.md)\b|\b(write|save|persist|create|output|emit|dump|generate)\s+\S+\.(md|json|txt|ts|js|yaml|yml|csv|html)\b/i;

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
 * @param prompt       - The raw prompt string sent to the child.
 * @param childWriteCapable - Whether the child's tool surface allows writes.
 * @param supportsVisionFn - Injected capability check (default: model-caps).
 */
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
