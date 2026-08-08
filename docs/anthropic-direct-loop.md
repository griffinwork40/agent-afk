# The anthropic-direct turn loop

Reference for `src/agent/providers/anthropic-direct/loop.ts` and its `loop/`
modules — the per-turn agentic loop that drives one user turn through the
Messages API and the tool dispatcher.

This document carries the `History:`-class material (root causes, incident
records, decision log) that the long-comment convention in `AFK.md` keeps out of
the source. Ordering constraints and protocol rules stay inline in the code as
`Invariant:` / `Contract:` blocks.

## Module map

`loop.ts` is the orchestrator: it owns the round `while` loop and nothing else.
Each phase lives in its own module.

| Module | Responsibility |
|---|---|
| `loop/round-request.ts` | Wire projection of tool defs, prompt-cache breakpoint, params build, connection-phase 529/503 retry, watchdog arming |
| `loop/throttle-signals.ts` | Races a parked `messages.create` against the throttle queue so backoff is visible live |
| `loop/stream-consumer.ts` | Drives `translateMessageStream`, yields translated events, classifies how the round ended |
| `loop/round-retry.ts` | Trace phase, `stream.retry` reset, class-appropriate backoff, post-backoff abort check |
| `loop/turn-terminal.ts` | The three non-`tool_use` exits: refusal, text completion, empty completion |
| `loop/tool-round.ts` | Coordinator for a `tool_use` round: assistant push, rollback, epilogue, cap |
| `loop/tool-dispatch.ts` | Builds `ToolCall`s, emits start events, abort gate, batch/sequential dispatch |
| `loop/tool-results.ts` | `tool.output` / `tool.diff` events, `tool_result` block assembly, history commit |
| `loop/turn-accumulator.ts` | Turn-scoped tallies: usage, iterations, tool-call count, cap flag |
| `loop/retry-budget.ts` | Retry predicates, tuning constants, per-round `RoundRetryBudget` |
| `loop/turn-trace.ts` | Witness bracket: `loop_start`, `interrupt_halt`, `loop_end` |
| `loop/outcomes.ts` | Discriminated unions passed between phases |
| `loop/thinking-diagnostic.ts` | Console diagnostic for a thinking-block rejection |

### The three state lifetimes

Before the split, ten mutable locals sat in one prologue with no way to tell
which survived a `continue`. They now map to three objects:

- **`TurnAccumulator`** — lives for the whole turn, never reset. Usage,
  iterations, cumulative tool-call count, the cap flag, and the wall-clock
  origin every terminal event is measured against.
- **`RoundRetryBudget`** — released as a unit by `reset()` once a round gets
  past every retry decision, so each round starts with a full allowance. The
  stream consumer READS it; the retry handler SPENDS it. They must be handed the
  same instance.
- **`TurnTrace`** — outlives any single phase. Its abort listener can fire at
  any moment and its timestamp is read only at teardown.

## Immutable Fast-mode turn snapshot

At the start of each top-level user turn, `query/turn-request.ts` resolves Fast
eligibility once. That immutable decision builds both parts of the protocol pair:
`fast-mode-2026-02-01` in the beta header and `speed: "fast"` in the body.
`RunTurnInput` then carries the decision through every tool-loop round and retry, so
a mid-turn preference or model change cannot split header and body or downgrade a
retry. Excluded auxiliary/child paths never receive the controller.

## Retry classes

Three distinct failure modes get three distinct budgets. They are deliberately
not unified — the costs differ by an order of magnitude.

### Connection-phase transient (529 / 503)

A real HTTP status on a thrown SDK error, handled inside `createWithRetry`
before any stream exists. Up to `OVERLOAD_MAX_RETRIES` (3) attempts with
exponential backoff (5s → 10s → 20s) plus additive jitter.

Jitter was added in #762: concurrent sessions hitting the same capacity event
were retrying in lockstep and re-hammering an already-overloaded upstream. The
jitter is additive, so the documented minimum delay still holds.

### Mid-stream overload

The SDK throws an `overloaded_error` from inside the stream iterator with **no
HTTP status** — `messages.create` already returned 200 and the error arrives in
the SSE body. `createWithRetry` is status-based and connection-phase only, so it
never sees this. `translate.ts` converts the throw into an in-band error event,
and `isOverloadedErrorEvent` recognises it by the nested body type in both its
double-nested and flat shapes.

Retrying is safe because `input.messages` is unmutated for the round: the
assistant turn and usage are committed only on clean completion, so the re-drive
re-sends identical history. Already-streamed text may re-emit, which is why a
`stream.retry` event is emitted first to make surfaces discard the partial paint.

**Incident (#762) — exhausted budget was lossy.** Before the fix, when the
budget went false on the 4th hit, control fell past the interrupt check and the
StreamIncomplete branch into `yield out.event; translatorErrored = true` — the
same lane as an auth failure. That set `sawProviderError` in `agent-session.ts`
→ `closure {reason:'abort'}` → seal `failed` with `finalTurnCount: 0`,
discarding every accumulated turn of the session. One real incident lost 9 turns
and roughly 2.02M cache-read tokens across five failed resumes.

The fix routes exhaustion to a CLEAN `turn.completed` stamped with
`OVERLOAD_EXHAUSTED`, so the turn counts (`turnCount++`) and `afk --resume`
restarts from saved state. The failure stays loud — the sentinel still maps to
an `abort` closure and a `failed` seal, exactly like the `tool_use_loop_capped`
precedent — it simply stops being lossy.

### Mid-stream clean close (`StreamIncompleteError`)

The SSE stream ended with neither a `message_stop` nor a `stop_reason` *after*
content had already streamed — an intermediary proxy, gateway, or load balancer
dropped the connection mid-generation. The raw SDK stream ends without throwing,
so `translate.ts` constructs and yields the error in-band rather than throwing it.

This matches neither other class: not a TTFB stall (a first byte was seen, so
the timer never fires) and not an overload (no `overloaded_error`). Without a
dedicated branch it falls straight through to the fatal path.

The budget is deliberately LOW — `STREAM_INCOMPLETE_MAX_RETRIES` = 2, below the
overload budget of 3. Each failed attempt burns a partial, often long,
generation before the cut, so a retry costs far more here than a fast 529
rejection. Two attempts rescue the common transient blip while capping wasted
spend on a deterministic (too-long-for-the-proxy) cut. The companion
default-subagent contract — write bulk output to files, keep the final message
short — shrinks the generation so these retries stay cheap.

The delay is short (1s → 2s, not 5s/10s/20s): a dropped connection is not a
server-overload signal, so reconnect promptly while still avoiding a tight loop
against a flapping intermediary.

## Stall bounds

Two progress bounds guard a degrading upstream. They are mutually exclusive by
construction: the post-first-byte watchdog stays dormant until the first
translated event, so the pre-first-byte window is governed solely by the TTFB
bound and the two can never both be pending.

### Time-to-first-byte (#583)

A call that never streams a first CONTENT token — text/thinking delta, tool_use,
or the end-of-stream turn-result — is aborted at `AFK_MODEL_TTFB_TIMEOUT_MS` and
re-driven ONCE per round, then surfaces as an error. Without it, a degrading
endpoint hung up to the SDK's ~10-minute default.

`message_start` and keep-alive pings yield no translated output, so they do not
count as a first byte. The retry is once-per-round (a boolean, not a counter) so
it cannot stack on top of the overload backoff into a longer worst case.

The trace phase is `ttfb_timeout`, deliberately NOT `rate_limit`: this timer is
ours, fires with no server throttle and no retry-after, and the two were
otherwise indistinguishable in a trace — which made every self-inflicted 180s
stall read as provider throttling.

### Post-first-byte stall (#762)

The TTFB bound is cleared by the first content token, so before this watchdog a
stream that stalled mid-flight had NO bound of any kind. Two real sessions hung
38.9 and 63.5 minutes and sealed `incomplete: true` — the process-exit backstop
— with no `loop_end` and no `closure` at all.

The watchdog is progress-AWARE: every translated output event re-arms it, so a
legitimately long, actively streaming round is never cut off, while a round that
goes silent for the whole window dies loudly with a real terminal error. There
are two reset sources — translated events, and an `onRawProgress` callback
covering content deltas the translator consumes without yielding (a tool call's
streaming argument payload, a thinking signature). Without the second source, a
long `input_json_delta` run looks identical to a wedged socket.

A mid-stream stall is deliberately NOT retried. Unlike a TTFB stall, which costs
only a prefill, it has already burned a partial generation — and the pre-fix
behaviour was an invisible 38–63-minute hang, so terminating loudly *is* the fix.

## History mutation and rollback

`runTurn` mutates `input.messages` in place. For a `tool_use` round the sequence
is: push the assistant turn, dispatch, then push a user turn carrying a
`tool_result` for every `tool_use`.

The Anthropic API requires every `tool_use` block to be followed by a matching
`tool_result` in the next user message. A throw between the two pushes would
leave history terminating in an unmatched `tool_use`, and **every subsequent API
call would 400**. `tool-round.ts` therefore captures the pre-push length and
splices it back out in a `catch` that spans dispatch and commit as one unit.

Two paths deliberately do not enter that catch, because they leave history
already consistent: the signal-aborted gate (which pushes synthetic aborted
results for every call) and the denial-circuit-breaker return (which fires after
the commit).

`iterations += 1` sits outside the try: a round that threw and rolled back did
not happen.

The same constraint drives the non-`tool_use` exit. When the turn ends without
dispatching tools, any `tool_use` blocks the translator collected — from a call
truncated by `max_tokens`, or one paired with a `pause_turn` stop — are stripped
before the assistant turn is pushed, or they become orphans on the next request.

## The render channel

`ToolResult.render` is never model-facing. `tool-results.ts` destructures only
`content`, `isError`, and `image` when building the `tool_result` block, so
`render` is structurally out of scope at the push site rather than merely
excluded by convention. Diffs travel to surfaces on a separate `tool.diff` event.
`image` is the one structured field that IS model-facing: when set it becomes an
`image` content block alongside the text.

## Watchdog disposal

`ttfb.dispose()` and `stall.dispose()` are called at each early-exit path AND
once more at the end of stream consumption. Both handles are idempotent, so the
duplicates are harmless.

This is deliberate, not an oversight. Disposal is **not** consolidated into a
`finally`, because `openRound` returns both handles LIVE on success — ownership
transfers to the stream consumer, and a blanket `finally` in either module would
disarm timers the other still needs.

## Decomposition record

`loop.ts` was 1418 lines, dominated by a single ~1065-line `runTurn` generator
with 31 `yield` sites, 16 `return`s, and 10 mutable locals — all inside one
`while (true)` with no natural exit.

It was split in seven stages (see `.afk/plans/split-anthropic-direct-loop.md`),
leaf-first so that control-flow surgery happened only after the state contracts
were explicit. Phases communicate through the discriminated unions in
`loop/outcomes.ts`, and every extracted phase that yields is an
`AsyncGenerator` delegated to with `yield*` — which preserves event ordering by
construction, and is what made the 82 pre-existing end-to-end tests a real proof
of behaviour preservation rather than a smoke check.

The loop is intentionally NOT shared with the `openai-compatible` provider. See
`shared/tool-loop-cap.ts` — only cross-cutting primitives live in
`providers/shared/`; the loop stays per-provider by design, and the two have
already diverged structurally.
