# Make silent model-loop failures debuggable without hand-instrumentation

## Problem

A turn can end with **no user-visible output and no error** — a "silent stop" — when the provider returns an empty completion with a `stop_reason` other than `tool_use` (e.g. `refusal`, `end_turn`/`max_tokens`/`stop_sequence`/`pause_turn` with empty text, an unrecognized future reason, or `turnResult === null` from a mid-stream cut). The diagnostic signal that explains the stop (`stop_reason`, request block-structure, raw payload) **is captured in memory and even partly persisted to the witness trace, but is rendered nowhere an operator or AI agent can read it post-hoc** — `afk trace show` drops it, `events.jsonl` never records it, and the TUI swallows `console.*`. Debugging the recent `stop_reason: 'refusal'` wedge therefore required hand-adding a `__wedgeDbg()` to `loop.ts`/`query.ts` that wrote raw `stop_reason` + block-structure to `/tmp/afk-wedge-debug.log`, a `pnpm build`, and **three** human re-runs of the repro. None of that should be necessary again.

> Anchors below are drawn from two upstream investigations (an infra audit of existing observability, and an end-to-end hop-by-hop trace of where `stop_reason` is dropped). Line numbers were refreshed against `main` (v5.2.0); treat them as starting points.
>
> **Status update:** Recommendation 1 below — render `lastStopReason` in `afk trace show` — **has since shipped** (`src/cli/commands/trace.ts:337` now renders `stop=<reason>` on the closure line). Recommendations 2–5 remain open.

---

## Ranked recommendations (best debuggability-per-effort first)

| # | What | Effort | Eliminates |
|---|------|--------|-----------|
| **1 ✅** | **Render the already-persisted `lastStopReason` in `afk trace show`** — **LANDED** (`src/cli/commands/trace.ts:337`) | **S** | All 3 re-runs *and* all source edits — the data is already on disk |
| 2 | **Diagnostic `warning` trace event on any empty non-`tool_use` completion** | S | The "is it a hang or a silent stop?" ambiguity that started the investigation |
| 3 | **`AFK_DEBUG_PROVIDER` raw-trace flag → `~/.afk/logs/provider-trace.jsonl`** (productionized `__wedgeDbg`) | M | The `__wedgeDbg` edit + `pnpm build` step entirely |
| 4 | **Persist `stopReason` into `events.jsonl` `done` record** | S | Re-runs for *any* turn, not just the one being actively debugged |
| 5 | Per-round `stop_reason` in the witness layer (not just session-final) | M | Multi-turn ambiguity about *which* turn stopped silently |

---

### 1 ✅ — Render `lastStopReason` in `afk trace show` *(LANDED — the data already existed; the renderer gap is now closed)*

- **WHAT:** Print the provider `stop_reason` in the `closure` line of `afk trace show`.
- **MECHANISM:** `lastStopReason` is threaded from the `done`-event metadata (`src/agent/session/agent-session.ts:393` sets `this.lastStopReason = m.stopReason`) into the witness `closure` event (`src/agent/session/agent-session.ts:1133`), and the `ClosurePayload` type declares it (`src/agent/trace/types.ts:377` — *"Raw `stop_reason` from the provider, when available."*). It lands durably in `trace.jsonl` / `forge-telemetry.jsonl`. The renderer gap is now **closed**: `src/cli/commands/trace.ts:337` formats the closure line and surfaces `p.lastStopReason` as a `stop=` field:
  ```ts
  const stop = p.lastStopReason ? `  stop=${p.lastStopReason}` : '';
  return line('closure', `${p.reason}  turns=${p.finalTurnCount}${stop}  ${fmtUsd(p.finalCostUsd)}${guidance}`);
  ```
- **EFFORT:** **S** (one render line + a snapshot-test assertion).
- **HOW IT SHORTENS FUTURE SESSIONS:** Completely. The `refusal` stop reason was already being written to the witness trace on every run of the repro. With this line landed, the very first failing run now produces `afk trace show` output reading `closure  model_end_turn  stop=refusal …` — **no `__wedgeDbg`, no `pnpm build`, no second or third re-run.** This is the single change that converts "instrument + rebuild + 3 re-runs" into "run once, then read."
- **RISK / over-fire:** Effectively none — read-only, additive to one display line, gated on the field being present.

### 2 — Diagnostic `warning` event on any empty non-`tool_use` completion

- **WHAT:** Emit a structured warning whenever a turn exits with empty content and `stopReason !== 'tool_use'` (and `!== 'refusal'`, which already self-describes).
- **MECHANISM:** The exact fork already exists in `loop.ts`. The `refusal` branch (`loop.ts:473–491`) yields an explicit notice; the generic `if (turnResult.text.length > 0)` guard at **`loop.ts:492`** is precisely where empty completions fall through silently. In the `else` of that guard, emit a witness `warning` event (and a one-line operator notice) carrying `{ stopReason: turnResult.stopReason, blockKinds: turnResult.assistantBlocks.map(b => b.type) }`. This generalizes the refusal fix to the whole silent class enumerated by the gap trace (`end_turn`/`max_tokens`/`stop_sequence`/`pause_turn`/unknown + empty).
- **EFFORT:** **S** (mirror the existing `refusal` branch; reuse the `warning` event kind already in `trace/types.ts`).
- **HOW IT WOULD HAVE SHORTENED THIS SESSION:** The investigation opened with "the turn just stops, is it hung?" A `warning` event naming the stop reason removes that ambiguity at the source — the operator sees *why* the turn produced nothing without opening a trace at all, and the trace carries the block-structure that `__wedgeDbg` was hand-collecting.
- **RISK / over-fire:** A genuinely empty `end_turn` (model legitimately had nothing to add after tools) would warn. Acceptable as a `warning` (not an error); keep the operator-facing text low-key and gate the *console* surface so it doesn't fire on every benign empty turn.

### 3 — `AFK_DEBUG_PROVIDER` raw-trace flag (productionize `__wedgeDbg`)

- **WHAT:** An env-gated flag that appends every request/response `stop_reason` + content block-structure (+ optionally the raw payload) to `~/.afk/logs/provider-trace.jsonl`.
- **MECHANISM:** Register alongside the existing debug flags in `env.ts` (model: `AFK_DEBUG_COMPOSITOR` at `env.ts:846`, `category: 'debug'`). The capture site is exactly where `__wedgeDbg` was bolted on and where the signal is richest: `translate.ts` already has a hoisted `traceEnabled` flag (`translate.ts:140`) and sees the raw `message_delta.stop_reason` (`translate.ts:249`) and the assembled `buildTurnResult` (`translate.ts:308`). Gate a file-writer there (and at the request-build site in the provider loop) on `env.AFK_DEBUG_PROVIDER`. **Must write to a file, not `console.*`** — the gap trace confirms the TUI does not suppress `console`, but the existing `AFK_TELEGRAM_TRACE` `console.log` calls are useless under the REPL compositor; a JSONL file under `~/.afk/logs/` is the durable, agent-readable equivalent of `/tmp/afk-wedge-debug.log`.
- **EFFORT:** **M** (env registration + a small append-only writer + two call sites).
- **HOW IT WOULD HAVE SHORTENED THIS SESSION:** This *is* `__wedgeDbg`, minus the source edit and the `pnpm build`. Re-running the repro with `AFK_DEBUG_PROVIDER=1` would have produced the raw `stop_reason` + block-structure log on the first try, with zero recompilation.
- **RISK / over-fire:** Raw payloads can contain prompt/PII and grow large — keep it strictly opt-in (off by default), document it as debugging-only (mirror the `AFK_TELEGRAM_TRACE` wording), and prefer logging block *kinds* + `stop_reason` by default with full payloads behind a second opt-in level.

### 4 — Persist `stopReason` into the `events.jsonl` `done` record

- **WHAT:** Add `stopReason?` to the ledger `done` payload so every turn's stop reason is post-hoc inspectable per-session, no re-run required.
- **MECHANISM:** `usageToMetadata` already preserves it (`stream-consumer.ts:165`: `stopReason: usage.stopReason ?? undefined`) and it rides the `done` `OutputEvent` as `event.metadata.stopReason`. But `projectOutputEvent` for the `done` case (`session-ledger.ts:~110`) projects only `{ kind: 'done', costUsd?, durationMs? }` and discards `stopReason`; the `LedgerPayload` `done` variant (`session-ledger.ts:52`) has no such field. Add `stopReason?: string` to that variant and copy `event.metadata?.stopReason` through in the projection.
- **EFFORT:** **S** (one type field + one projection line; `events.jsonl` is append-only NDJSON so it's backward-compatible).
- **HOW IT WOULD HAVE SHORTENED THIS SESSION:** Complements #1. `events.jsonl` is per-session and always-on (unless `AFK_*` disabled), so even *without* invoking `afk trace show` the stop reason for the failing turn would already be on disk to `grep`. Removes re-runs for the general case where someone notices the silent stop after the fact.
- **RISK / over-fire:** Negligible — additive optional field; consumers that don't read it are unaffected.

### 5 — Per-round `stop_reason` in the witness layer

- **WHAT:** Record `stop_reason` per round/turn, not only as the session-final `closure.lastStopReason`.
- **MECHANISM:** Today `this.lastStopReason` is **overwritten every turn** (`src/agent/session/agent-session.ts:393`) and surfaces only once, in the terminal `closure` event. For a multi-turn session where an *intermediate* turn stops silently, the closure reason reflects the *last* turn, not the offending one. Attach `stopReason` to a per-turn witness event (a `turn`-scoped trace event, or carry it on the `assistant.message`/`done` projection). This subsumes the gap trace's "DROPPED from the message object" finding (`src/agent/session/stream-consumer.ts:316` attaches no `stopReason` to the `Message`).
- **EFFORT:** **M** (new/extended per-turn event + threading through the message projection).
- **HOW IT WOULD HAVE SHORTENED THIS SESSION:** Lower marginal value *here* — the refusal wedge was the final turn, so the session-final `lastStopReason` (#1) already pinpoints it. Pays off for the harder variant: a silent stop mid-conversation that later turns mask.
- **RISK / over-fire:** Trace volume grows by one field per turn (cheap). Main cost is plumbing, not runtime.

---

## ⭐ Highest-leverage single change

**Recommendation 1 — render `lastStopReason` in `afk trace show` — has since LANDED (`src/cli/commands/trace.ts:337`).**

The decisive fact from the audit: the offending signal was **already being persisted to the witness trace on every run** (`src/agent/session/agent-session.ts:1133` → `ClosurePayload.lastStopReason`, type declared at `src/agent/trace/types.ts:377`). The investigation rebuilt the binary and re-ran the repro three times to recover a value that was sitting on disk the whole time, unread, because the human-facing reader omitted one field. One render line + a test turned the entire "hand-instrument → `pnpm build` → re-run ×3" loop into a single read-only `afk trace show` — **this has since shipped (`src/cli/commands/trace.ts:337`).** Highest debuggability-per-effort by a wide margin; with #1 done, layer #2 and #4 (both S) next to make the signal loud and always-on, then #3 (M) for the raw-payload deep dives.

---

## Already covered — do **not** build

From the infra audit; these exist and should be *extended*, not reinvented:

- **`afk trace show` / `afk trace list`** (`cli/commands/trace.ts`) — a read-only human reader for the witness trace already exists, with a `latest` selector. Rec #1 extends it; **do not build a new `afk inspect`/`afk replay` command.**
- **`stop_reason` persistence to the witness trace** — `lastStopReason` is already captured (`src/agent/session/agent-session.ts:393`) and written to the `closure` event (`src/agent/session/agent-session.ts:1133`); the `ClosurePayload.lastStopReason` field already exists (`src/agent/trace/types.ts:377`). The rendering gap (#1) is now **closed** (`src/cli/commands/trace.ts:337`); the remaining gap is *granularity* (#5), **not capture.**
- **`stop_reason` on the `done` event metadata** — `usageToMetadata` already preserves it (`stream-consumer.ts:165`); it survives to any stream consumer. Rec #4 only adds the *ledger projection*; the upstream plumbing is done.
- **`refusal` is already non-silent** — `loop.ts:473–491` yields an explicit operator-facing notice. Rec #2 generalizes this to the *remaining* empty-completion reasons; **don't re-handle `refusal`.**
- **`max_tokens` / `length` already classified as `truncated`** — `src/agent/session/closure-reason.ts` (precedence rule 6, `isTruncationStopReason`) already maps these to a non-`model_end_turn` closure reason, so a truncated empty completion is *already* flagged in the witness layer. This narrows rec #2's target set to `end_turn`/`stop_sequence`/`pause_turn`/unknown + empty content.
- **Witness-trace opt-out + receipts** — `AFK_TRACE_DISABLED`, the trace factory (`trace/factory.ts`), and `RunReceipt` summarization (`trace/receipt.ts`, which already lists `lastStopReason` in the receipt) exist. New flags should follow these patterns, not duplicate them.
- **General debug-flag plumbing** — `AFK_DEBUG`, `AFK_DEBUG_COMPOSITOR`, `AFK_DEBUG_CLIPBOARD`, `AFK_TELEGRAM_TRACE` are registered in `env.ts` (`category: 'debug'`). Rec #3's `AFK_DEBUG_PROVIDER` should register the same way. **Note the trap:** the existing `AFK_TELEGRAM_TRACE` uses `console.log` (`translate.ts:145`), which is invisible under the REPL compositor — that is *why* `__wedgeDbg` wrote to a file. #3 must write to `~/.afk/logs/`, not console.

### Out of scope for this issue

- **OpenAI-compatible provider path** (`src/agent/providers/openai-compatible/`) — has its own loop and stop-reason (`finish_reason`) handling that was **not** traced. Recs #1/#4/#5 are provider-agnostic (they act on normalized `metadata.stopReason`/`lastStopReason`), but #2 and #3 are anchored in the Anthropic loop and would need a sibling patch in the OpenAI loop. File as a follow-up.
- **Telegram surface rendering** of `done`/`metadata` was not traced; #1/#2/#4 should benefit it for free via the shared event/ledger layers, but verify separately.
