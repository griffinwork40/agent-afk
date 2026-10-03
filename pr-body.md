# feat(peer): show peer session activity in list_sessions

## Summary

`list_sessions` now returns an optional `activity` field on each peer session
entry, so an agent can see what a peer is working on without sending a message
and burning that session's wake budget.

```json
{
  "sessionId": "abc123",
  "turnState": "busy",
  "activity": {
    "promptHead": "analyze the new feature request",
    "turns": 7,
    "lastTurnEndedAt": "2026-10-03T15:44:12.000Z"
  }
}
```

For deeper per-turn detail (tool calls, subagents, phases), use `read_witness`
with the peer's `sessionId`. Note: `read_witness` may return empty results for
a very new session that has not yet written its witness trace.

---

## Design

### `activity` field

New optional field on `PresenceFileInfo` (additive, no schema version bump):

| Sub-field | Description |
|---|---|
| `promptHead` | First <=120 chars of the raw user-typed text, whitespace-collapsed, `redactSecrets`-filtered. Set at turn **start** so a busy session shows the current prompt. |
| `turns` | Total completed turns. Incremented at turn **end**. |
| `lastTurnEndedAt` | ISO timestamp of when the most recent turn finished. Set at turn end. |

`lastToolName` is omitted: sourcing it cheaply requires new cross-cutting
plumbing (the turn-run loop has no cheap access to last-tool-name after
`runTurn` returns), and `read_witness` already exposes the full tool-call
history per session.

### Raw-prompt-only (injection isolation)

`promptHead` is sourced from the raw `text` variable in `loop-iteration.ts`
-- captured at line 196, **before** `prependTurnInjections` at line 204
prepends peer-message or bg-subagent-result content to produce `runText`.

This is the load-bearing invariant: peer message bodies from OTHER sessions
must never appear in THIS session's presence file (presence files are
0600 but on the same machine and same user). The code path:

```
text         ← what the operator typed (raw)
runText      ← text + injected peer/bg content
               (prependTurnInjections at loop-iteration.ts:204)

markPresenceTurn('busy', text)          ← raw; goes to promptHead
runOneTurn(runText, ..., rawUserText=text)
markPresenceTurn('idle')                ← calls setPresenceActivityTurnEnd
```

`rawUserText` is threaded as an optional parameter through `runOneTurn` so
the invariant is explicit at the call site and testable in isolation.

### Slash-commands and empty text

`normalizePromptHead` returns `undefined` for empty or whitespace-only input.
`setPresenceActivityPromptHead` no-ops in that case, leaving any existing
`promptHead` intact. A `/slash` command that expands into a non-empty seed
message will set the promptHead from that message on the next submitted turn.

### Write serialization

Both `setPresenceActivityPromptHead` and `setPresenceActivityTurnEnd` route
through `patchPresenceFile` -> `enqueuePresenceWrite` (presence.ts:242),
the existing per-session serialized write queue. No concurrent write can lose
another mutation.

### Why no `inspect_session` tool

The session ledger (`state/sessions/<id>/events.jsonl`) holds raw user and
assistant message text, tool output, and HMAC'd elicitation/abort records.
Reading it cross-session creates a leak and injection surface -- a peer could
craft prompt content that shows up in another session's tool result. The plan
explicitly rejected this. `read_witness` already exists and is scoped to
trace events (tool names/timing/bytes, subagent lifecycle, phases) with no
conversation text.

---

## Files changed

| File | Change |
|---|---|
| `src/agent/awareness/presence.activity.ts` | NEW -- `normalizePromptHead`, `setPresenceActivityPromptHead`, `setPresenceActivityTurnEnd`, `PresenceActivity` type |
| `src/agent/awareness/presence.activity.test.ts` | NEW -- 25 tests |
| `src/agent/awareness/presence.ts` | Added `activity?` to `PresenceFileInfo` |
| `src/agent/tools/handlers/peer.ts` | `listSessionsHandler` spreads `activity` when present |
| `src/agent/tools/schemas.peer.ts` | Updated `list_sessions` description (adds `acceptsMessages`, `activity`, `read_witness` hint) |
| `src/cli/commands/interactive/loop-iteration.injections.ts` | `markPresenceTurn` accepts `rawUserText`, calls activity helpers |
| `src/cli/commands/interactive/loop-iteration.turn-run.ts` | `runOneTurn` accepts `rawUserText?`, passes to `markPresenceTurn` |
| `src/cli/commands/interactive/loop-iteration.ts` | Passes raw `text` as `rawUserText` to `runOneTurn` |
| `docs/peer-messaging.md` | Expanded `list_sessions` field table, updated presence schema table, added `acceptsMessages` |

---

## Verification

```
pnpm lint                     ✓  (tsc --noEmit, 0 errors)
pnpm build (tsc only)         ✓  (dashboard/node_modules absent in worktree -- pre-existing, not this PR)
pnpm test src/agent/awareness/presence.activity.test.ts   ✓  25/25
pnpm test src/agent/awareness/presence.peer.test.ts       ✓  21/21
pnpm test src/agent/tools/handlers/peer.test.ts           ✓  16/16
pnpm test (full)              ✓  24905 passed, 26 pre-existing skips
pnpm audit:filesize:check     ✓  all within ceiling
pnpm audit:funcsize:check     ✓  all within ceiling
pnpm audit:env:check          ✓  0 violations
pnpm audit:module-state:check ✓  no duplicated module state
pnpm audit:chalk:check        ✓  0 violations
```

---

## Deferred / uncertain

- `lastToolName` omitted as documented above; could be added later by threading
  a callback from `runTurn` into `runOneTurn`.
- Slash-command expansion: the expanded seed text (not the slash command name)
  will appear as `promptHead` on the next submitted turn. The previous
  `promptHead` is preserved while the expansion is in the `seedBuffer`.
- This PR does NOT change liveness logic (PR1 is a parallel PR for that).
