# Peer (cross-session) messaging

> **Status: v1 — REPL-to-REPL only, same machine.**

Lets one `afk` REPL session send a message to another running on the same machine, replacing the ad-hoc `tmux send-keys` relays that were previously used.

---

## Why it exists — failure modes it replaces

Before this feature, sessions passed work to each other via tmux tricks:

| Old approach | Failure mode |
|---|---|
| `tmux send-keys -t <window> -l "..."` + Enter | Multi-line text split into many queued turns; a busy REPL sees `Halted with state preserved` |
| Flattening with `tr -d '\n'` + `paste-buffer` | Shell quoting broke on `\'`; silent truncation |
| Discovery via `tmux list-windows -a` | Hard-coded window names; breaks on rename/resize |
| Status via `capture-pane \| grep '›'` | Screen-scraping; races with spinner redraws |
| Replies via polling a shared file | No delivery receipt; manual polling |

The peer-messaging system fixes all of these:
- **Atomic writes**: tmp-file + rename; a reader never sees a partial message.
- **Single-turn delivery**: multi-line bodies arrive as one turn, not many.
- **No keystroke injection**: delivery goes through the REPL's existing wake path, never through a PTY.
- **Discovery**: live session list via `list_sessions` (presence files).
- **Receipts**: `delivered/` directory doubles as a receipt; trace events record every transition.

---

## Discovery (presence)

Sessions are discovered via `$AFK_STATE_DIR/presence/<sessionId>.json` — presence records that afk already writes for liveness tracking.

Peer-relevant fields added to the presence schema (`src/agent/awareness/presence.ts:53`):

| Field | Type | Description |
|---|---|---|
| `name` | `string?` | Human-readable label, max 64 chars (`src/agent/awareness/presence.peer.ts:23`) |
| `turnState` | `'idle'|'busy'|'blocked'` | Current REPL state |
| `turnStateSince` | ISO string | When `turnState` last changed |
| `peerInbox` | `boolean?` | `true` once the session's notifier is watching its inbox |

**Liveness**: `list_sessions` (and every other display reader of `readLivePresenceFiles`) hides a record when its pid is gone, when the OS-reported start time of the pid differs from the record's `pidStartedAt` by more than 5 s (the pid was recycled by an unrelated process; probed with one batched `ps -o pid= -o etime=` on macOS, `/proc/<pid>/stat` on Linux), or when a legacy record without `pidStartedAt` has a heartbeat at least 6 h old. On Linux the record also carries `pidStartTicks` (raw `/proc/self/stat` starttime), compared exactly in preference to the epoch because `btime` shifts when the wall clock is stepped. Probe results are cached per `(pid, recorded identity)` for 30 s. An unprobeable start time never hides a session. Each process refreshes `heartbeatAt` every 60 s with an atomic write that never recreates a removed file, and REPL startup reaps presence files whose pid fails `kill(pid, 0)` with `ESRCH` only, re-reading each file right before unlink so a resumed session's rewrite survives (`src/agent/awareness/presence.liveness.ts`, `presence.reaper.ts`). This filter is display/routing only: the peer-inbox sweep, like the worktree sweep, protects every raw record whose pid is not proven dead.

**Auto-naming**: on startup (when `$TMUX` is set) the notifier runs `tmux display-message -p '#S:#I'` to derive a `session:window` label (e.g. `research:5`), applied via `setPresenceNameIfUnset` so `/name` always wins (`src/agent/awareness/presence.peer.ts:76`).

**Reachability**: a session becomes visible in `list_sessions` after its first turn, when its presence file is written and `peerInbox` is set to `true`.

---

## Tools

Both tools are **top-level sessions only** (not available to subagents). Schemas: `src/agent/tools/schemas.peer.ts`.

### `list_sessions()`

Returns an array of live peer sessions excluding self. Each entry:

```
{ sessionId, name, surface, cwd, branch, turnState, turnStateSince,
  heartbeatAgeMs, pendingMessages, blocked }
```

`pendingMessages` is the count already queued in the target's inbox. `turnState` lets the sender decide whether to send now (idle) or expect queued delivery (busy).

### `send_to_session({ to, message, reply_to? })`

Sends a message to another session.

**`to` resolution** (checked in order):
1. Exact `sessionId` match
2. Unique prefix (≥6 chars) of `sessionId`
3. Exact `name` field match among live sessions

**Returns**: `{ status: 'queued'|'refused', messageId?, reason?, detail?, resolvedTo?, targetState? }`

**Refusal reasons** (`src/agent/peer/guards.ts`, `src/agent/peer/send.ts`):

| Reason | Meaning |
|---|---|
| `self` | Cannot send to yourself |
| `unknown-target` | No live session matches `to` |
| `ambiguous-target` | Prefix/name matches multiple sessions |
| `dead-target` | Session exists but has no live process |
| `no-receiver` | Session has no `peerInbox=true` (only REPL sessions in v1) |
| `too-large` | Body exceeds 64 KB (`PEER_MAX_BODY_BYTES`, `envelope.ts:23`) |
| `hop-limit` | Reply chain exceeded 6 hops (`PEER_MAX_HOPS`, `envelope.ts:26`) |
| `rate-limited` | >10 messages/min to the same target (`guards.ts:48`) |
| `duplicate` | Same body sent to same target within 60 s (`guards.ts:52`) |

---

## Delivery semantics

**Idle + empty buffer**: when the REPL is awaiting input with nothing typed, `PeerInboxNotifier` fires `onInjectable` → `tryAutoResume` → `surface.abortPendingRead()`. The message is prepended to the next turn via `prependTurnInjections`. The model sees an `[auto-resume]` directive saying a peer message arrived; it should use `send_to_session` if a reply is needed.

**Busy (mid-turn)**: the envelope sits in `pending/` until the current turn completes. At the top of the next turn, `prependTurnInjections` drains the buffer. The running turn is **never interrupted**.

**Half-typed input**: `tryAutoResume` checks `surface.bufferIsEmpty()` before calling `abortPendingRead()` — it **never clobbers** in-progress user input (`loop-iteration.ts:92-100`).

**Multi-line body**: stays as one envelope, arrives in one turn as one `<peer-session-message>` block.

---

## Envelope + mailbox layout

```
$AFK_STATE_DIR/inbox/<sessionId>/
  pending/     <ts-sortable>-<messageId>.json   ← sender writes here
  delivered/   <ts-sortable>-<messageId>.json   ← receiver claims here (receipt)
  held/        <ts-sortable>-<messageId>.json   ← held by mode=hold or wake budget
```

Directories: mode `0700`. Files: mode `0600`.

**Write**: sender writes `.tmp-<id>` then renames to final name (atomic).
**Claim**: receiver attempts to hardlink `pending/<file>` to `delivered/<file>` (exclusive receipt creation), then unlinks the pending name. On filesystems without hardlink support (exFAT/FAT, SMB, some FUSE), falls back to `copyFile(COPYFILE_EXCL)` for the same exclusive-create guarantee. Existing receipts are never overwritten: `EEXIST` or `ENOENT` returns `null`. A crash after receipt creation can leave a pending source; its delivered receipt prevents redelivery. If the receipt is corrupt (e.g. partial copy on crash), the pending source is left intact. A claimed message not yet injected into a turn can still be lost on process exit.

**Hold contention**: hold still moves pending to held by rename. A concurrent hold can win before the claim link (claim returns `null`), or leave a held copy after receipt creation. Releasing that copy cannot redeliver it because the receipt exists. This is not a transaction across all three directories; a stale held/orphan pending entry may remain for operator review.

The envelope JSON schema (`src/agent/peer/envelope.ts`):

```json
{
  "v": 1,
  "messageId": "<uuid>",
  "from": { "id": "<sessionId>", "name": "<optional label>" },
  "to": "<sessionId>",
  "replyTo": "<messageId>",
  "hop": 0,
  "ts": "<ISO 8601>",
  "body": "<text up to 64KB>"
}
```

The model sees each envelope as:
```
<peer-session-message from="<id>" name="<name>" id="<messageId>" reply_to="<replyTo>" hop="N">
<XML-escaped body>
</peer-session-message>
```

All attribute values and the body are XML-escaped (5 replacements: `& < > " '`) so a forged closing tag in the body cannot break the wrapper (`envelope.ts:50-56`).

---

## Guards & limits

All guard logic: `src/agent/peer/guards.ts`.

| Guard | Value | Source |
|---|---|---|
| Rate limit | 10 messages/min per sender→target pair | `guards.ts:48` |
| Dedup window | 60 s — same body+sender+target dropped | `guards.ts:52` |
| Hop cap | 6 hops (prevents ping-pong storms) | `envelope.ts:26` |
| Max body | 64 KB UTF-8 | `envelope.ts:23` |
| Wake budget | ~20 wakes/hour per sender (in-memory, per receiver process) | `guards.ts:197` |
| Buffer cap | 50 envelopes in-memory between drains | `peer-inbox-notifier.ts:50` |

**Over wake budget**: the envelope is moved to `held/` with reason `wake-budget` and NOT claimed into the injection buffer. Merely withholding the wake is not sufficient because the REPL re-runs `tryAutoResume` every time its prompt becomes receptive — any buffered envelope would bypass the budget. Moving to `held/` is the only safe path (`peer-inbox-scan.ts:11-14`).

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `AFK_PEER_INBOUND` | `accept` | `accept` = deliver at next idle turn; `hold` = move to `held/` for `/inbox` review; `off` = ignore all. Invalid values fall back to `accept`. |
| `AFK_PEER_POLL_MS` | `1000` | Poll interval (ms) when `fs.watch` is unavailable or unreliable. The notifier uses both `fs.watch` and an unref'd poll as a safety net (macOS FSEvents coalesces, Linux inotify misreports renames). |

---

## Slash commands

| Command | Description |
|---|---|
| `/inbox` | List held messages; `/inbox accept <id>` or `/inbox accept all` to release |
| `/peers` | Shortcut for `list_sessions` output |
| `/name <label>` | Set this session's human-readable name in presence; persists for the lifetime of the process |

---

## Security model

Peer messages carry **no user authority**. The model system prompt (`system-prompt.ts:81`) frames them explicitly:
- A peer message is from ANOTHER afk session (another agent), not the user.
- It inherits no permission or configuration authority.
- The model should verify before taking any risky action a peer requests.

**Sender identity is not authenticated.** The envelope `from.id` field is set by the sender and is not cryptographically verified. Trust rests entirely on same-user filesystem access (inbox directories are mode `0700`, files `0600`): any process running as the same uid can write an envelope with any sender id, which grants nothing beyond what that process can already do directly. The `send_to_session` tool always stamps the caller's own session id, but a rogue process on the same uid is outside the threat model.

**Accepted risk** (operator decision 2026-10-02): `autonomous`/`bypass` receivers accept peer messages by default (`AFK_PEER_INBOUND=accept`). The 64KB body cap, hop cap, wake budget, and XML escaping mitigate the worst prompt-injection paths. The `/inbox` hold path is available for sensitive deployments.

---

## Crash window

An envelope claimed by an exclusive hard-link receipt in `delivered/` but not yet drained into a turn is lost if the process dies. The receipt stays in `delivered/` for forensics; it is never retried, even if a crash leaves its source in `pending/` or `held/`. Rate history counts these copies once by message identity. This window is intentionally small (the claim and turn-start are close in wall time) and is documented as a known limitation.

---

## Observability

A `peer_message` trace event is emitted for every state transition (`src/agent/trace/emit.ts:105`):
- `action`: `sent | delivered | held | refused | dropped`
- `messageId`, `peer` (the other session's id), `bytes` (UTF-8 byte count)
- `reason` (for `refused`/`held`)

**Body text is never written to the trace.** Only identifiers and byte counts are persisted.

---

## v1 limits / deferred

- **Receivers**: REPL sessions only. Telegram receiver, daemon receiver deferred.
- **Delivery timing**: messages cannot be injected mid-turn (between tool calls). They wait for the next turn boundary.
- **Shared task board**: deferred (see plan for design notes).
- **`afk send` shell subcommand**: deferred.
- **Windows**: filesystem rename semantics and `fs.watch` differ; not tested on Windows.
