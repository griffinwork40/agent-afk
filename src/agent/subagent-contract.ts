/**
 * The default subagent handoff contract.
 *
 * A zero-dependency string constant (deliberately its own leaf module so both
 * `agents/builtins.ts` and `tools/subagent/child-config.ts` can import it
 * without pulling either module's graph into the other — same isolation
 * rationale as the duplicated constants in `builtins.ts`).
 *
 * History: forked children hand their result back to the parent as the child's
 * final assistant message, verbatim, wrapped in a single tool_result (see
 * `tools/subagent/foreground-promotion.ts`). That final message is generated as
 * one long-lived model stream; when a child accumulates a large context and
 * then emits a long final report, an intermediary (proxy/gateway/LB) can close
 * the connection mid-generation, surfacing as a `StreamIncompleteError`
 * (`providers/anthropic-direct/translate.ts`) and failing the whole subagent.
 * The cheapest structural mitigation is to stop asking children to return long
 * final messages at all: push bulk output into files and keep the reply itself
 * short. This mirrors the file/scratchpad handoff pattern used by Crush, Cline,
 * and Goose. Applied to the write-capable default workers (`general-purpose`
 * and unnamed dispatches, which inherit the full tool surface); read-only
 * vendored agents keep their own upstream-pinned prompts.
 */
export const SUBAGENT_HANDOFF_CONTRACT = `Handoff contract: your final message is the ONLY thing the dispatching session receives — its intermediate tool calls, file reads, and exploration are invisible to the parent, so everything that matters must be in the reply itself.

Keep that reply compact and lead with the answer: outcome/answer first, then the key evidence (file:line where it applies), risks or caveats, and anything you did not check.

When a result is large — long analysis, generated content, extensive listings, or verbatim excerpts — do NOT paste it inline. Write it to a file in your working directory and return the file path plus a short summary. A very long final message can be truncated in transit and lost entirely, so hand off bulk output as a file and keep the message itself brief.`;
