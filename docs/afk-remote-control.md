# AFK Remote Control — Bidirectional Telegram Handoff

**Status:** Implemented (iterations 1–4 committed; docs iteration 5).  
**Feature branch:** `afk/20260617-201405-0b2298`  
**Design record:** `.afk/plans/afk-telegram-bidirectional.md`

---

## What It Is

Normally the AFK Telegram integration is **outbound only**: when you step away from
the REPL (`/afk on`) the agent's output streams to your phone, but if the agent asks a
question the session hangs waiting for a keyboard reply. Returning to the computer just
to answer one question defeats the point of AFK mode.

**Bidirectional AFK** closes that loop. With a running Telegram daemon (`afk telegram
start`), you can **answer the agent's questions, redirect it, or abort its turn entirely
— from your phone, mid-flight, in the same session.** When you return to the computer
and type `/afk off`, interaction returns to the keyboard seamlessly.

---

## End-to-End Flow

```
REPL process (afk i)                  Telegram daemon (afk telegram start)
─────────────────────                  ──────────────────────────────────────
/afk on
  → swap elicitation handler
    to makeLedgerChannelHandler        (auto-subscribe loop fires every 30 s)
  → mark presence afk=true    ──────→  sees surface=cli, afk=true, sessionId
  → start abort-watcher tail          → watchManager.start(sessionId, chatId)

Agent turn begins.
Agent calls ask_question / MCP elicit.
  → elicitationRouter.route()
  → ledgerChannelHandler fires:
    1. Open ledger tail (fromStart:false,
       before emit — no reply can be missed)
    2. Emit `elicitation` record to
       ~/.afk/state/sessions/<id>/events.jsonl
    3. Race:
         a. verified ledger reply       ledger tail sees `elicitation` record
         b. stdin keyboard fallback   → renders question to your phone
         c. outer turn abort           (inline keyboard for choice/confirm,
                                         text prompt for free text)
                                      You tap/type your answer on the phone.
                                      Daemon writes HMAC-signed
                                      `elicitation_response` → ledger file.

       REPL tail sees new record ←────────────────────────────────────────
       verifies HMAC
       resolves with result
       cancels losers (stdin, tail)

Agent sees the answer; continues.

/afk off
  → restore stdin handler
  → stop abort-watcher tail
  → clear presence afk marker

Back at the keyboard.
```

### Remote abort

```
You: /abort (Telegram)
  Daemon looks up getWatched(chatId) → sessionId
  Reads session key from ~/.afk/state/sessions/<id>/session.key
  Signs: HMAC-SHA256(key, "abort_request\0<sessionId>\0<nonce>")
  Writes `abort_request` record to ledger

  REPL abort-watcher tail sees record
  verifyAbortRequest(key, sessionId, nonce, hmac) → true
  fires session AbortGraph
  session aborts cleanly
```

If the REPL has no AFK key (the operator never typed `/afk on` in this session),
the daemon replies with a helpful message and does NOT write an unsigned abort.

---

## Ledger-as-Channel Design

The REPL (`afk i`) and the Telegram daemon (`afk telegram start`) are **separate OS
processes**. They share no memory, no sockets, and no new IPC primitive. Communication
flows **only through the per-session ledger file**:

```
~/.afk/state/sessions/<id>/events.jsonl   ← append-only NDJSON
```

This file already exists for every top-level `AgentSession` (the REPL's `/watch`
feature reads it for outbound streaming). The bidirectional channel adds three new
record kinds to the open union in `src/agent/session-ledger.ts`:

| Kind | Writer | Reader |
|---|---|---|
| `elicitation` | REPL (`makeLedgerChannelHandler`) | Daemon (`_run` in `watch.ts`) |
| `elicitation_response` | Daemon (`SessionLedgerWriter`) | REPL (ledger tail) |
| `abort_request` | Daemon (`bot.ts` `/abort` command) | REPL (abort-watcher tail) |

The ledger is append-only NDJSON with torn-line skipping (`parseRecord`). Two
concurrent appenders (REPL + daemon) do not corrupt each other.

---

## Per-Session HMAC — Threat Model

When `/afk on` is first typed, the REPL writes a 32-byte random key to:

```
~/.afk/state/sessions/<id>/session.key  (mode 0600)
```

Every `elicitation_response` and `abort_request` record written by the daemon carries
an HMAC-SHA256 tag over `(recordKind, sessionId, correlator, payload)` using this key.
The REPL verifies the tag before acting; an unverified record is **silently ignored —
never actioned**.

**What this protects:**
- Accidental cross-session bleed (a reply from session A cannot resolve session B).
- Stray or buggy writers (a process that appends a raw `abort_request` without the key
  cannot abort your session).

**What this does NOT protect:**
- A malicious *same-user* process that reads the 0600 key. Such a process already holds
  the user's OS privileges — this is out of scope.

**Telegram ingress** stays gated by the existing `AFK_TELEGRAM_ALLOWED_CHAT_IDS`
allowlist, unchanged.

---

## The AFK Safety Gate Is Non-Overridable

`src/agent/afk-mode-gate.ts` enforces which tool calls are permitted in autonomous
mode. A remote phone reply is **an input to the agent's reasoning** — it answers a
question and the agent re-evaluates its next action against the gate. The gate is
**never bypassed** by a Telegram reply. This is scope-lock Invariant #1 and is tested
separately in `src/agent/afk-mode-gate.test.ts`.

---

## Five Hard Invariants

These are frozen in `.afk/plans/afk-telegram-bidirectional.scope.lock.md` and
enforced by tests:

1. **AFK gate non-overridable.** `afk-mode-gate.ts` has no Telegram override path;
   remote replies feed the agent's next reasoning step, never bypass the gate.
2. **Daemon is the sole Telegraf poller.** The REPL never constructs a `Telegraf`
   instance or calls `getUpdates`. A second poller would cause Telegram 409 Conflict.
   Enforced by `src/cli/afk-no-telegraf-poller.test.ts`.
3. **Additive channel.** The stdin keyboard fallback is always live alongside the
   phone. If the daemon is not running, the keyboard still works. No daemon-liveness
   dependency, no `bot.pid` gating.
4. **HMAC-gated writes.** `elicitation_response` and `abort_request` are acted upon
   **only** after successful per-session HMAC verification. Key-absent → ledger branch
   disabled; the safe degrade is keyboard-only.
5. **Ledger-only IPC.** The only cross-process hop is the session ledger file. No
   sockets, pipes, or new IPC primitives.

---

## Key Source Files

| File | Role |
|---|---|
| `src/agent/afk-channel.ts` | Per-session HMAC helpers (`ensureSessionKey`, `signElicitationResponse`, `verifyAbortRequest`, …) |
| `src/agent/afk-ledger-channel.ts` | `makeLedgerChannelHandler` (REPL phone+keyboard race) + `makeAbortWatcher` |
| `src/agent/session-ledger.ts` | Append-only NDJSON ledger; `tailLedger`, `SessionLedgerWriter`, `LedgerRecord` union |
| `src/cli/afk-mode-toggle.ts` | `/afk on/off` swap logic — installs the ledger channel, starts abort-watcher, sets presence marker |
| `src/cli/commands/interactive/surface-setup.ts` | Pre-builds stdin handler + exposes `swapElicitationHandler` callback |
| `src/agent/elicitation-router.ts` | Module-scope router; `install()` swap is the only coupling point |
| `src/telegram/watch.ts` | Daemon `SessionWatchManager._run` — intercepts `elicitation` records and triggers write-back |
| `src/telegram/bot.ts` | Daemon lifecycle, `/abort` command, presence auto-subscribe loop |
| `src/telegram/handlers/message.ts` | `ledgerOriginatedPendingChats` bypass for the `state==='idle'` guard |
| `src/telegram/elicitation-handler.ts` | `makeTelegramElicitationHandler` — reused to render questions to the phone |

---

## Known Limitations / Future Work

These were deferred because the scope-lock budget was exhausted at iteration 4. Each
needs a separate focused change.

### (a) Daemon writer fd leak (low severity, slow)

When the daemon writes back an `elicitation_response` or `abort_request`, it creates a
`new SessionLedgerWriter(sessionId)` to perform the one append. This writer **must not
be `close()`d** — calling `close()` would write a spurious `closed` record into the
REPL's ledger, which would terminate the REPL's `tailLedger` loop and break subsequent
questions in the same session.

As a result, the fd created by the writer lives until GC reclaims the object. For a
single-session interaction this is invisible. For a very long-lived daemon that serves
many sessions over many hours, it is a slow fd leak.

**Proper fix:** add a one-shot `appendAndClose` path to `SessionLedgerWriter` (or to
the `session-ledger.ts` module) that writes the record and closes the underlying stream
without emitting a `closed` record. Requires a small change in `src/agent/session-ledger.ts`
(currently OUT OF SCOPE per scope.lock — file is frozen from Phase 1).

### (b) Auto-subscribe stops a manually `/watch`'d non-AFK session

The auto-subscribe tick (every 30 s) calls `watchManager.start(sessionId, chatId)` for
any `surface=cli, afk=true` session. On the next tick, if the user had manually
`/watch`'d a different (non-AFK) session in the same chat, the auto-subscribe call can
replace it with the AFK session's watch, silently stopping the manual one.

**Proper fix:** track whether a current watch was started manually (`/watch` command)
vs. automatically (auto-subscribe) and skip the auto-start when a manual watch is
active.

### (c) `bot.action` handlers accumulate per watch cycle

Each time `SessionWatchManager._run` arms a new `bot.action` handler (for
inline-keyboard callback confirmations), the handler is appended to Telegraf's internal
middleware stack and is never removed, even after the watch ends. Over many watch
cycles the stack grows unboundedly.

**Proper fix:** expose a handler-removal API from Telegraf (or use a delegating
middleware that is registered once and routes by run ID) so each watch cycle can clean
up after itself.

### (d) Inline-keyboard elicitation not yet end-to-end tested

`choice` and `confirm` elicitation types render as Telegram inline keyboards (via
`makeTelegramElicitationHandler`). The `ledgerOriginated: true` path through
`elicitation-handler.ts` and `message.ts` is code-reviewed and unit-tested but has not
been exercised in an end-to-end integration test with a real Telegram bot.

**Proper fix:** add an integration / live test that fires a `confirm`-type elicitation
through the full chain (REPL ledger emit → daemon render → callback query → signed
write-back → REPL resolve).
