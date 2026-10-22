# Subagent Yield (proposed)

Status: **design, not implemented.** Decided in a 2026-10-22 session after two
devils-advocate passes and one composition-boundary check. The second pass's
recommendation folds in the boundary check's findings but has not had a second
boundary check yet (see Open questions).

## Problem

A foreground subagent that hits a question only its parent can answer has no
structured way out. Today:

- Forks are non-interactive by default, so `ask_question` is stripped from the
  child toolset (`src/agent/subagent/fork-child-config.ts:379-387`).
- The identity preamble tells non-interactive children to "proceed on the most
  reasonable assumption, or stop, and put the open question in your reply"
  (`src/agent/subagent/identity-preamble.ts:116-121`). That is an informal
  yield: the escape hatch exists, but the parent gets unstructured prose and no
  resume handle.
- Model-owned steering (`send_message_to_agent`) covers background children
  only. Foreground children are steered by the human alone
  (`docs/subagent-steering.md`).

## Decision 1: yield-and-resume, not a live channel

Foreground children get **child-initiated yield-and-resume**. They do not get a
live bidirectional channel with the parent model.

Why not a live channel: while a foreground child runs, the parent model is
suspended inside its own `agent` tool call. There is no parent turn to receive a
message or produce a reply, and the Messages API requires each `tool_use` to be
followed immediately by its `tool_result`, so the parent cannot take a turn in
the middle of the call. Progress events confirm the constraint: they reach the
parent "at its next user-turn boundary"
(`src/agent/subagent/fork-progress-events.ts:66`), which a blocked foreground
parent does not have until the child returns. A design where the child waits
for a parent-model answer deadlocks until the idle watchdog or the wall clock
kills it.

Live two-way messaging stays with background agents (#1418), where the parent
really is free.

### Shape of a yield

1. The child ends its turn with a question.
2. The runtime returns a typed `needs_input` result as the parent's normal
   `agent` tool_result. It always contains the question, a self-contained
   summary of the work done so far, and the child's full final text. It contains
   a `continuation_chain_id` only when the chain is actually continuable.
3. The parent either continues the chain with its answer, or re-dispatches a
   fresh child with the summary plus the answer. The parent also decides
   whether to escalate to the human; children never reach the operator directly.
4. A yielding child gives up its concurrency slot and its wall-clock and idle
   budgets. A paused child holds nothing.

### Amendments from the first critique

- **Always self-contained.** Many chains cannot be resumed: worktree-isolated
  chains are `continuable: false`, compose nodes refuse `continuation_chain_id`,
  and all chains are in-memory only, lost on restart and `/resume`
  (`docs/subagent-continuation.md:140,159-163`). Because every yield carries a
  summary written for a stranger, the fresh-re-dispatch path covers all of
  these. The runtime, not the child, decides which path applies.
- **Typed result.** `needs_input` vs `result` is an explicit discriminator so a
  parent cannot read a pause as a final answer.
- **Runtime-enforced cap.** 1 to 2 yields per chain, counted by the runtime,
  not left to prompt wording.

Remaining dissent: chains are in-memory only, so resume is fragile in long
sessions. The self-contained summary limits the damage: losing a chain costs
history, not the answer.

## Decision 2: how children learn about it

Children are told, but through conventions they already have, **not a new
tool**. All three critics in the second pass independently rejected a dedicated
`ask_parent` tool.

1. **Wire format: the existing Asking terminal state.** A child yields by
   ending with an **Asking** block (question, the assumption it resolves, what
   happens once answered) plus a short work summary. The agent-layer parser
   already extracts the question (`src/agent/outcomes/terminal-state.ts:200,423`).
   Nothing upstream fights a child that ends on Asking: the stop-hook seam is a
   no-op for forks (`src/agent/providers/shared/stop-hook-continuation.ts:214`),
   and the terminal-state gate only acts on `done`
   (`terminal-state-gate.ts:92`).
2. **Teaching: one conditional preamble paragraph.** It replaces
   `identity-preamble.ts:119-120` when, and only when, the runtime will honor a
   yield for this child. It states the real cost (asking ends your turn; you may
   resume with history or a fresh child may continue from your summary), tells
   the child to write question and summary for a stranger, sets the bar at
   information only the parent holds (user intent, the original conversation,
   sibling findings, never anything the child's own tools can answer), and shows
   the remaining yield count. Leaving the paragraph out is as honest a
   capability signal as leaving out a tool, and it follows the preamble's
   existing rule that every line is derived from the child's resolved config.
3. **Parent side ships in the same change.** The `agent` tool description
   documents `needs_input` and how to answer it (continue the chain, or
   re-dispatch with the summary). A child that yields to a parent that does not
   recognise the result is the main misread risk.

### Why the tool lost

The problems a tool would solve (result shape, interception point, nested yield
cascades) are the same either way. The convention reuses wording and parsing
that already exist, and its failure mode is graceful: a missing or malformed
Asking block falls through as an ordinary final reply, which is today's
behavior. A tool stays available as a purely additive follow-up if traces show
children under-yielding or false positives causing real harm.

## Implementation constraints (from the boundary check)

- **Detect in `runToResult`, the one place every path converges.** Every
  dispatch path ends in `handle.runToResult()`: the foreground `agent` tool
  (`src/agent/tools/subagent/foreground-handoff.ts`), compose
  (`src/agent/dag-subagent.dispatch.ts:217`), and skill forks
  (`src/agent/tools/skill-executor/fork-dispatch.ts:458`), with background jobs
  awaiting the same call (`src/agent/background-registry.ts:297`).
  `runToResult` turns the child's final message into a `SubagentResult` through
  `buildResultFromMessage` (`src/agent/subagent/handle.streaming.ts:372-386`).
  Detect the Asking block there and tag the result; the per-path ToolResult
  assemblers only need to honor the tag. (An earlier draft of this doc said
  there was no single choke point and named a non-existent
  `buildSuccessResult`; both were wrong.)
- **Bypass output schemas.** `buildResultFromMessage` is also where the Zod
  `outputSchema` is applied (`handle.streaming.ts:383`). Detection must run
  before validation: a yielding child cannot also satisfy a schema, so an
  Asking result must skip validation rather than surface a spurious
  `schemaError`.
- **The journal is the resume record, not the catch point.** Subagent journals
  are written through an async `SerialQueue` that reports and skips failed
  writes so it can never wedge a session (`src/agent/journal/append-queue.ts:4-6`),
  a SIGKILL can lose queued records, and the journal flush is post-result
  bookkeeping that finishes *after* the result is delivered
  (`src/agent/subagent/continuation-registry.ts:68-71`). Control flow cannot
  wait on it. It is, however, the durable copy of the child's history that
  continuation already resumes from (`journalUsable` in `recordTerminal`). The
  continuation registry is only an in-memory index over it, so the
  "chains are lost on restart" weakness could be fixed by rebuilding a chain
  from its journal instead of falling back to a fresh re-dispatch. That is
  unverified: check `src/agent/journal/hydrate.ts` and `reader.ts` before
  relying on it.
- **Guard false positives.** `parseTerminalState` is tail-anchored (last 40
  lines) and fenced-code-aware. Blockquoted headings (`> **Asking**`) do NOT
  match because `lineToKind()` preserves the `>` character
  (`src/agent/outcomes/terminal-state.ts:254-282`). The real false-positive
  surface is a bare unquoted `**Asking**` heading in the tail 40 lines of
  a child that is reporting or summarizing another agent's output. Because
  `needs_input` always carries the full final text, a misdetection degrades to
  today's output plus a label.
- **Compose.** A compose node cannot be resumed, so a yield there means
  fresh-re-dispatch semantics or yields off by default for nodes. Downstream
  nodes must never silently consume a yield as a complete result.
- **Facets are likely unaffected.** `src/agent/facets/derive.ts:102-103` reads
  the last non-empty `turns[].assistant` string to find the parent's terminal
  state, and a child's Asking block arrives inside a `tool_result` in a
  user-role message. The mechanism that populates `turn.assistant` from the
  journal has not been verified end-to-end, so this is plausible but
  CONFIRMED safe (see resolved question 5 below).

## Resolved questions

1. ~~Composition-boundary check on the detection point.~~
   **Resolved.** All five consumer paths silently discard a `needsInput` tag
   today and need targeted changes:
   - `foreground-handoff.ts` (path 1, low): spread `needsInput` onto ToolResult.
   - `dag-subagent.dispatch.ts` (path 2, low-medium): fail-fast on yield.
   - `fork-result.ts` (path 3, low): spread `needsInput` onto ToolResult.
   - `continuation-dispatch.ts` (path 4, medium): extend `reasonOf` to map
     `needsInput` to `'asking'`.
   - `background-registry` (path 5, high): handle is torn down on terminal;
     no return path exists. **Deferred to v2** (needs handle kept alive).
   Cross-cutting: parent-side routing (deciding what to do with a `needsInput`
   ToolResult) is in neither of these files; it lives in the parent model's
   tool-result handling.
2. ~~Whether forks inherit the parent's assembled system prompt.~~
   **Resolved: NO.** `assembleSystemPrompt` appends `END_OF_TURN_DIRECTIVE`
   (containing the full Asking block format) only for `repl` and `telegram`
   surfaces (`src/agent/routing-directive.ts:151-170`). Forks get a separately
   built prompt through `src/agent/tools/subagent/child-config.helpers.ts:204-207`
   (named agent: definition body; unnamed: `composeUnnamedWorkerPrompt` in
   `src/agent/tools/system-prompt.ts:181-186`, which is the bare operator
   overlay plus the framework base). `fork-child-config.ts:297` computes
   `taskPrompt` only for the workspace-store query, not for the child config.
   **Consequence: the conditional preamble paragraph must spell out the Asking
   block format itself.** Children have never seen it through inheritance.
3. ~~Whether compose nodes get yields at all in v1.~~
   **Resolved: NO.** A yielding compose node looks like a successful completion
   to the DAG executor (`status: 'succeeded'`), so downstream nodes proceed on
   partial data and fail-fast does not trigger. V1 disables yields for compose
   nodes (preamble paragraph not injected) with a fail-fast safety net in
   `dag-subagent.dispatch.ts`.
4. ~~Whether a lost continuation chain can be rebuilt from the journal.~~
   **Resolved: PARTIAL.** The journal read side already works
   (`loadJournalMessages` in `reader.ts:128-133` is the exact call continuation
   uses). But 9 of 13 `ChainRecord` fields have no disk representation; the
   hard blocker is the `owner` field (random token per process,
   `continuation-registry.ts:109-118`). Fix = persist a `.chain.json` sidecar
   alongside each subagent journal in `recordChainTerminal`. **Deferred.**
5. ~~Facet pipeline safety.~~
   **Resolved: CONFIRMED safe.** `tool_result` text never reaches
   `turn.assistant`. The structural firewall is in `transformProviderEvent`
   (`stream-consumer.ts:329-336` vs `:365-369`): `assistant.message` and
   `tool.output` are mutually exclusive arms populating separate fields
   (`TurnRecord.assistant` vs `TurnRecord.toolEvents`). A child's Asking block
   arrives as tool_result content and is never scanned as the parent's own
   terminal state.

## V1 scope

- Foreground `agent` tool dispatches: full yield support.
- Skill forks (`fork-dispatch.ts`): full yield support.
- Compose/DAG nodes: yields disabled; fail-fast safety net.
- Background children: **not needed.** They already have `emit_progress`
  (child to parent, delivered at the parent's next turn boundary) and
  `send_message_to_agent` (parent to child, delivered at the child's next
  tool-round boundary). Both work because the parent model is not blocked
  while a background child runs. Yield exists to fill the gap that only
  foreground children have.
- Journal-based chain rebuild: deferred (chain sidecar needed).

## Related

- `docs/subagent-steering.md`: human-owned foreground and model-owned
  background steering.
- `docs/subagent-continuation.md`: continuation chains and their limits.
- #1418: addressable agent messaging for running (background) agents.
- #3897: mid-turn user steering at every tool-round boundary.
