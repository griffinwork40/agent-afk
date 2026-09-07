# Diagnosis: shadow-verify nudge hijacked `/resolve` turns (session 61db02da, 2026-07-01)

## Symptom

REPL session `61db02da-0410-4eb7-8743-dd14a2ce4186` (afk **5.15.3** global install, model opus_1m, repo cwd):
after `/review 353` completed (23:18→00:25Z, verdict DO NOT MERGE), the user typed `/resolve` three times:

| ts (UTC) | user typed | model actually processed | reply |
|---|---|---|---|
| 01:50:32 | `/resolve` #1 | **queued nudge #1** | "Shadow-verify already ran … the nudge is firing on the shadow-verifiers' own output" (0 tool calls) |
| 02:32:22 | `/resolve` #2 | **queued nudge #2** | "No new sub-agent output … this nudge is repeating" (0 tool calls) |
| 02:32:54 | `/resolve` #3 | **`/resolve` #1 text** | resolve skill finally dispatched (02:33:07Z) and ran normally |

Evidence: `~/.afk/state/sessions/61db02da-…/events.jsonl` (4 user events, 3 assistant events, tool timeline),
`~/.afk/state/transcripts/2026-07-01T23-18-17-132Z.md`, witness trace `~/.afk/state/witness/a78a89fe-c7f2-4c74-89af-9df7c7ada819/trace.jsonl`.

## Root cause — off-by-N input-queue lag (deterministic, by construction)

Four pieces compose the failure:

1. **SubagentStop `injectContext` is delivered as a standalone user message pushed into the parent's
   input stream.** `src/agent/subagent/handle.ts:470-482` → `parentInputStreamRef.pushUserMessage(decision.injectContext)`;
   ref wired from the forking parent at `src/agent/subagent.ts:509,531` → `agent-session.ts:1051`.

2. **The input stream is a plain FIFO where framework messages and real user messages share one lane.**
   `src/agent/session/input-iterable.ts:24-36` — push resolves an armed consumer or appends to `bufferedMessages`;
   the iterator (`:44-57`) drains **one message per `next()`**.

3. **The anthropic-direct provider consumes exactly one queue item per turn and never reads input mid-turn.**
   `src/agent/providers/anthropic-direct/query.ts:309-317` (`promptIterator.next()` once per `while` iteration),
   `:351` (that one item becomes the sole new `role:'user'` message). `loop.ts` contains zero input reads.
   The provider is an async **generator**: after emitting `done` it stays *suspended at `yield`*
   (`query.ts:393-407`), so it is never parked awaiting input while idle.

4. **`sendMessageStreamInternal` pushes the typed text first, then pulls provider events until the first `done`,
   assuming the events answer that text.** `src/agent/session/agent-session.ts:592` (push), `:602-626` (pull-until-done),
   with a single persistent `providerIterator` (`:303,324`).

Because the generator only reaches `promptIterator.next()` *after* the next pull, and the harness always
pushes-before-pulling, **`pendingResolve` is never armed when a nudge arrives — every SubagentStop
injectContext in a REPL session is guaranteed to buffer and displace a future user message by one queue
position.** This is not a race; mid-turn vs post-turn stop timing is irrelevant.

### Replay

- During `/review`, the main session (plugin skill loaded into context) forked 11 `agent` children
  (6 dimension/PoC + 5 shadow-verify wave; events.jsonl ts 23:19:41→00:23:01Z).
- Exactly **2** of them passed all four nudge gates in `src/agent/shadow-verify-nudge.ts:102-110`
  (≥600 chars, agentType not review/shadow-verify-tokened per `:83-90`, output not verifier-shaped `:53-59`,
  ≥2 decision markers — review findings are marker-dense). The verifier wave self-suppressed; the other
  dimension forks were suppressed by agentType token or content. → buffer `[nudge1, nudge2]`.
- `/resolve` #1 → buffer `[n1,n2,r1]`, provider shifts **n1** → model sees only a bare nudge → replies to it.
- `/resolve` #2 → `[n2,r1,r2]`, shifts **n2** → "this nudge is repeating" (literally true — the model saw a
  second consecutive bare nudge message).
- `/resolve` #3 → `[r1,r2,r3]`, shifts **r1** → resolve skill dispatches.
- **Latent:** buffer still holds `[r2, r3]`. The next two submissions into that session will be answered by
  the two stale `/resolve` dispatches. The lag is permanent (each submission enqueues 1, consumes oldest 1)
  until those drain or the session is closed.

### Why it was invisible

`pushUserMessage` bypasses the ledger/witness user record — `recordUser` fires only in
`sendMessageStreamInternal` (`agent-session.ts:596-599`) for typed text. events.jsonl shows `/resolve`;
the nudge the model actually received is nowhere in durable state. Transcripts therefore read as
"user: /resolve → assistant: nudge-talk", i.e. as model misbehavior instead of queue lag.

### Version scope

Day-one design: `input-iterable.ts` / `handle.ts` push path unchanged since initial public release
(`0a23cff`); present in installed 5.15.3 bundle (verified: `bufferedMessages`, `pendingResolve`,
"Skipping SubagentStop injectContext", nudge string all in `/opt/homebrew/lib/node_modules/agent-afk/dist/cli.mjs`).
#345 (injectContext concatenation, 5.15.1) and #348 are orthogonal — single handler produced these
injections, and 2 pushes = 2 separate SubagentStop dispatches.

### Secondary finding

Nudge suppression worked as designed for 9/11 forks, but any raw `agent` fork with a generic `id_prefix`
and decision-dense output nudges — inside a skill that *is itself* the verifying orchestrator. The
orchestrator-suppression check keys off the **child's** agentType, not the dispatching context, so
plugin skills loaded into the main context (review, shadow-verify) get no umbrella suppression for the
forks they instruct the main session to make.

## Resolution (2026-07-01)

Implemented as **PR #359** (`fix/framework-context-prepend`, commit 51c46d8, CI green):
`AgentSession.queueFrameworkContext()` + drain-and-prepend in `sendMessageStreamInternal`;
SubagentStop delivery prefers the queue channel with `pushUserMessage` fallback. The
secondary bug hit during diagnosis (vendored PascalCase tool allowlists denying every
subagent call) was already fixed upstream by **#350** (v5.15.5); this machine's global
binary was upgraded 5.15.3 → 5.15.5 and services restarted.

## Fix recommendation (as designed — implemented in PR #359)

Minimal, contract-clean: **stop enqueueing framework context as standalone input-stream messages.**

1. Hold SubagentStop `injectContext` in cross-turn session state (e.g. `pendingHookContext: string[]` on
   `AgentSession`); on the next real `sendMessageStream`, prepend it to the typed content the way
   UserPromptSubmit already does (`loop-iteration.ts:433-434` prepends to `runText`). One turn, both texts,
   no displacement, correct attribution. (The `loop-iteration.ts:573` comment already names
   "injectContext-into-next-turn needs cross-turn state" as the known-deferred design.)
2. Record any injected framework context via the ledger (`recordUser` or a dedicated `recordFrameworkContext`)
   so witness/transcripts show what the model saw.
3. Optional hardening: tag/expire queued context by turn generation so anything stale by >1 boundary is dropped;
   consider dispatch-context-aware suppression (parent-turn skill = verified orchestrator ⇒ suppress children).

Tradeoff note: true mid-turn steering (pushing a user message while a turn runs) still uses the FIFO
legitimately; the fix should special-case *hook-generated* context, not remove `pushUserMessage`.

## Operator guidance for the live session

Session 61db02da (if still open): the in-flight resolve run is legitimate — let it finish. Two stale
`/resolve` messages remain queued; expect the next two submissions there to trigger duplicate resolve turns
(likely no-ops, but they will consume turns). Prefer closing that REPL after the resolve run lands.
