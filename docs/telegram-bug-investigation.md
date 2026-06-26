# Telegram bot reliability — root-cause investigation

Investigation date: 2026-06-26. Method: 5 parallel read-only sub-agent investigators
(cutoff, false-errors, progress-spam, general-sweep, daemon) + direct code reads.
Scope: `src/telegram/**`, `src/agent/session/**`, `src/agent/subagent/**`, `src/telegram.ts`,
`src/service/**`. **No code was changed** — this is diagnosis only.

**Shadow-verification (2026-06-26):** the three load-bearing claims (Bug 1 cutoff mechanism,
Bug 2 false-rate-limit, Bug 4 timer leak) were independently re-derived from primary sources by
three parallel adversarial verifiers — **all CONFIRMED**. Corrections folded in below. Net new
facts from verification: `session.interrupt()` (agent-session.ts:628-632) and `session.abort()`
(agent-session.ts:423) **already exist** and route to `AbortCoordinator.requestAbort('interrupted')`
→ the Bug 1 "smallest fix" is confirmed viable; `isRateLimitError` has **two more** vulnerable
call sites at `message.ts:330` (photo) and `message.ts:422` (text outer handler) beyond the one
in `processOne`.

---

## TL;DR — the three reported bugs share one causal chain

A single heavy turn (one that fans out sub-agents — `/ground-state`, `/diagnose`, `compose`,
research skills) triggers **all three** complaints at once, in this order:

1. **Spam** — `subagentSink` appends one `◦ label: tool args` line **per child tool call**,
   unbounded, into a single ever-growing edited message. This is the "recon: read_file …" wall.
2. **False "rate limit"** — that per-tool-call editing **floods Telegram's API**, which returns
   HTTP **429 "Too Many Requests"**. The classifier matches that string and tells the user
   *"⏳ Rate limit reached"* — as if **Claude** rate-limited them. It didn't; **Telegram** did.
3. **Cutoff** — while the sub-agents run, the **parent** stream is silent at the provider level
   for >60s, so the streaming timeout fires, throws, and **abandons the stream without aborting
   the underlying turn**. The turn keeps running; its events buffer; the user sees an error.
   Sending `.` starts a new consumer that **drains the buffered events** → the delayed final answer.

So: **spam → edit-flood → Telegram 429 → false "rate limit"**, and **fan-out silence → 60s
timeout → orphaned turn → "cut off, recovered by a period."** Fixing the spam (cap/coalesce) and
the timeout (abort-on-timeout + reset-on-subagent-activity) removes the whole cluster.

---

## Bug 1 — Mid-turn cutoff; final result withheld until a follow-up message  ⟶ CRITICAL

**Symptom (user):** turn starts, gets cut off mid-agent, no final result; sending a `.` later
delivers the withheld result with lag.

**Root cause chain** (confidence: High):
1. `streaming.ts:199-233` `nextWithTimeout()` rejects with *"Response timed out"* after
   `NEXT_EVENT_TIMEOUT_MS = 60_000` (streaming.ts:22) of **parent-stream** silence.
2. During sub-agent fan-out the parent provider loop is parked inside the tool dispatcher; **no
   `OutputEvent` crosses the parent `providerIterator` until all tools return.** Sub-agent
   progress reaches Telegram via the out-of-band `subagentSink`/`runWithSink` channel
   (`streaming.ts:238-250`, `skill-sink-channel.ts`) which calls `sendOrEdit` directly and **does
   not reset the 60s timeout.** So a busy turn looks "silent" and the timeout fires falsely.
3. On timeout, `streamResponse` throws; the `finally` (streaming.ts:438-444) calls
   `iter.return?.()`. That runs the generator's cleanup `finally` in `agent-session.ts:489-497`
   (sendMessageStream) / `541-543` (sendMessageStreamInternal), setting `currentState = 'idle'` —
   **but never aborts `providerQuery` / the turn's `AbortController`.** The shared `providerIterator`
   is created once per session in `initSdkLifecycle` (`agent-session.ts:254-255`) and reused by
   every `sendMessageStream` call — so the provider keeps streaming into it, now unconsumed.
   [verified: shared-iterator lifecycle re-derived from agent-session.ts + query.ts + abort-coordinator.ts]
4. User sees a generic/timeout error (`message.ts:602-608`).
5. The `.` follow-up sees `session.state === 'idle'` (set in step 3) → `processOne` →
   `sendMessageStream('.')` pulls from the **same** `providerIterator`, draining the *original*
   turn's buffered events (including its `done`/final answer) → delayed answer + lag.

**Why this is the in-process path, not a restart:** after a real process restart the buffered
events would be gone, so a `.` could not recover the original answer. Recovery-by-poke proves the
turn survived in-process. (Daemon restart is a *separate*, rarer cutoff path — see Bug 8.)

**Smallest correct fix:** in the `finally`, after `iter.return?.()`, also call
`session.interrupt?.()` so the provider turn is actually aborted and `providerIterator` is left at
a clean turn boundary. **[verified] `session.interrupt()` (agent-session.ts:628-632) and
`session.abort()` (agent-session.ts:423) already exist** and route to
`providerQuery.interrupt()` → `AbortCoordinator.requestAbort('interrupted')` → the turn's signal
aborts and `loop.ts` short-circuits — so this fix wires into an existing, tested path.
**Cleaner structural fix:** push the inactivity timeout into the session layer — have
`sendMessageStream` accept an `AbortSignal` (e.g. `AbortSignal.timeout(...)` extended on each
received event), so a timeout cleanly interrupts `providerIterator.next()` via the existing
`providerQuery.interrupt()` path instead of orphaning it.
**Also:** reset the inactivity timer on sub-agent sink activity (or raise `NEXT_EVENT_TIMEOUT_MS`
substantially) so deep fan-out does not look idle.

---

## Bug 2 — Spurious error / timeout / "rate limit" messages  ⟶ HIGH

Four distinct misclassifications, ranked by likely frequency (confidence: High unless noted):

1. **False "⏳ Rate limit reached" from a Telegram 429.** [verified — incl. telegraf source]
   telegraf builds `TelegramError.message` as `"429: Too Many Requests: retry after N"`
   (`node_modules/telegraf/lib/core/network/error.js`). The unswallowed reply call sites — initial
   `ctx.reply` (`streaming.ts:103-110`), overflow `ctx.reply` (`streaming.ts:434`), and
   `deliverClean` (`streaming.ts:154-161`) — throw a `TelegramError` up to `processOne`'s catch
   (rate-limit reply at `message.ts:602-603`), where `isRateLimitError()`
   (`utils/error-classifiers.ts:22-28`) matches `"too many requests"` **with no Telegram-origin
   exclusion** and fires *"⏳ Rate limit reached"*. **This is a Telegram rate limit, misreported as
   a Claude one — and it is caused by the Bug 3 edit-flood.** The **same** classifier mistake
   exists at two more catch sites: `message.ts:330` (photo handler) and `message.ts:422` (outer
   text handler).
2. **False "🌐 Network error"** from transient telegraf/undici blips (`ECONNRESET`, `ETIMEDOUT`,
   `fetch failed`) reaching `isNetworkError()` via the same unswallowed call sites — blames the
   *user's* connection for a bot↔Telegram hiccup.
3. **False "An unexpected error occurred"** via `bot.catch` (`bot.ts:263`): benign Telegram
   `400 "message is not modified"` / `400 "message to edit not found"` / `403 "bot was blocked"`
   / expired callback queries all fall through to the generic message.
4. **False "Response/Request timed out"** (medium confidence): the 60s/90s `nextWithTimeout`
   thresholds also fire on a slow *bot→Anthropic* path; the message contains `"timeout"` so it is
   then re-classified as a network error and blames the user's connection.

**Fix:** classify `instanceof TelegramError` **before** the provider rate-limit/network
classifiers, and route Telegram-origin 429/400/403 to log-only or a distinct "Telegram is busy"
message — never to the Claude rate-limit path. Distinguish the inactivity-timeout error class
from network errors. (The deepest fix is Bug 3: stop flooding Telegram so the 429s stop.)

---

## Bug 3 — Tool-call progress spam (the "recon: read_file …" wall)  ⟶ HIGH

**Mechanism** (confidence: High): every child tool call emits a `tool_use_detail` chunk
(`subagent/handle.ts:257-263`; `compose-executor.ts:557` per node). The Telegram `subagentSink`
(`streaming.ts:238-250`) does, **for each one**:
`accumulated += "\n◦ " + label + ": " + toolName + " " + toolArgs; void sendOrEdit(accumulated);`
There is **no cap, no coalescing, no dedup** — the buffer grows one line per tool call across all
sub-agents, and `splitLongMessage` (`formatter.ts`) eventually splits the giant buffer into many
Telegram messages (the long scroll in the screenshot).

**Blast radius:** N sub-agents × M tool calls = N·M retained lines + a Telegram edit per line
(throttled to one per 300ms, but the *buffer* is never bounded). A typical fan-out (5 agents ×
15 reads) ≈ 75 lines → multi-message spam and sustained edit pressure → Telegram 429 (→ Bug 2.1).

**`cleanFinal` does NOT save it on the bad paths:** the clean-final delivery + preview deletion
(`streaming.ts:390-399`) only runs on the `done` event. On timeout/error/abort (Bug 1) the turn
throws first, so the noisy buffer is what the user is left with.

**Fix design (recommended):** keep a *rolling* progress indicator instead of an append log —
e.g. a single line `◦ sub-agents working — <K> tool calls (<lastTool>)` updated in place, or cap
retained progress lines to the last K (collapsing consecutive same-tool lines), and throttle the
**buffer growth**, not just the edit. Optionally render progress as a separate ephemeral message
deleted on `done`. This preserves "something is happening" signal without the wall.

---

## Additional bugs found in the general sweep (ranked)

| # | Bug | File:line | Severity | Fix direction |
|---|-----|-----------|----------|---------------|
| 4 | `countdownInterval` / `editInFlight` leak when `streamResponse` throws before `done`/`error` (e.g. the Bug 1 timeout) — interval keeps firing `sendOrEdit` on a dead message forever [verified] | declared `streaming.ts:80`, set `streaming.ts:355`; cleared **only** at `:373` (resumed) / `:386` (done) / `:415` (error); **`finally` `:438-444` does not clear it**, and the callback's only guard (`pausedUntil===null`) is never satisfied on the throw path | High | Clear the interval (and reset `editInFlight`) in the `finally`. |
| 5 | `splitLongMessage` splits inside HTML tags/entities → malformed HTML → Telegram `400 can't parse entities`; overflow chunks (sent with `parse_mode:HTML`) can be silently lost | `formatter.ts:19-65`; callers `streaming.ts:119,430,433,153` | High | Make the splitter HTML-aware (never bisect a tag/entity) or split pre-HTML. |
| 1 | `drainQueue` has no re-entrancy guard; it is `public` and also called directly from `bot.ts` after `/compact`, so two concurrent drains for one chat can double-process/reorder | `message.ts:622-635`; `streaming.ts:609-614`; `bot.ts` compact path | High | Add a per-chatId `draining` flag set before `shift()`, cleared in `finally`. |
| 6 | `enqueueClear` / `enqueueCompact` bypass `MAX_QUEUE_DEPTH` (=5) — spamming `/clear` during a busy turn grows the queue unbounded (each item holds a live `Context`) | `message.ts:537-556` | Med | Apply the depth gate (or dedup) to command enqueues. |
| 7 | Elicitation `pending` map is a module-scope singleton never cleared on bot restart; stale resolvers/entries accumulate; only `_resetPendingForTests` clears it | `elicitation-telegram.ts:84,329` | Med | Clear `pending` in `stop()` / `elicitationRouter.uninstall()`. |
| 8 | `/clear` calls `getSession()` (which can **spawn** a session) just to check state, with no try/catch — an unhandled throw if creation fails (e.g. missing key); also redundant spawn-then-close | `bot.ts:98-101` | Med | Use a non-spawning state check; wrap in try/catch. |
| 9 | `pushMarkdown` fallback re-sends the **entire** original text when any single chunk fails → duplicate delivery | `push.ts:148` | Med | Resend only the failed chunk. |

---

## Bug 8 (daemon) — version-drift / KeepAlive restart can sever an in-flight turn  ⟶ MED

**Verdict: the daemon/service layer is a SECONDARY, occasional contributor — not the cause of the
"cut off, recovered by a period" symptom** (that is the in-process Bug 1).

Facts (telegram.ts:496-555; `src/service/launchd*`):
- The bot can run as a macOS LaunchAgent (`com.afk.telegram`) under launchd **KeepAlive**, or
  standalone (`afk telegram start` / `pnpm telegram:start`).
- A **version-drift watchdog** ticks every 5 min: if the on-disk `afk` version differs from the
  running one (i.e. an upgrade happened), it `process.exit(0)` so KeepAlive relaunches the new
  binary. It **defers while any session is mid-turn** (`getBusySessionCount() > 0`) — good — **but
  has a bounded escape hatch**: after `MAX_DRIFT_DEFERRALS` (~1h) it **force-exits anyway, even
  mid-turn** (`case 'force-exit'`, telegram.ts:530-533).
- The code comment is explicit (telegram.ts:508-516): force-exiting mid-stream "severs the
  in-flight turn (plus its queued messages and sub-agent dispatch), and the cold relaunch cannot
  resume it (\"An unexpected error occurred\")."
- `shutdown` on SIGINT/SIGTERM (telegram.ts:540-547) calls `bot.stop()` then `process.exit(0)`
  and **does not drain in-flight turns** — a launchd restart / OOM / crash mid-turn loses it.

So a post-upgrade force-exit (or crash/OOM) explains the occasional standalone "An unexpected
error occurred" with **no** recovery-by-poke (the new process has no buffered events). It is far
rarer than Bug 1 and produces a permanently-lost turn, not a recoverable one.

**Fix direction (if pursued):** on the force-exit and SIGTERM paths, attempt a bounded graceful
drain (or persist a "turn was interrupted — resend" marker) so the user is told to resend rather
than seeing a bare error; consider lengthening/》removing the hard force-exit while truly busy.

---

## Recommended fix order (highest leverage first)

1. **Bug 3 (spam cap/coalesce)** — also kills the Telegram-429 source feeding Bug 2.1.
2. **Bug 1 (abort-on-timeout + reset timer on sub-agent activity)** — fixes the cutoff and the
   false-timeout; the structural `AbortSignal` variant is the durable fix.
3. **Bug 2 (classify `TelegramError` before provider classifiers)** — stops blaming Claude.
4. **Bug 4 (clear `countdownInterval` in `finally`)** — small, stops a real timer leak.
5. **Bug 5 (HTML-aware split)** then **Bugs 1/6/7/8/9** as a cleanup pass.

All fixes are additive/local except the Bug 1 structural variant (touches the session streaming
API). None require destructive operations.
