# Local verification receipt (2026-11-20)

No Cloudflare login, deployment, or account operation was performed. Changes are
on `afk/global-chat-relayfix`, not pushed. Test identities used temporary files,
never the real AFK state directory. Throwaway drivers and raw outputs are in
this worktree's ignored `.afk-scratch/` directory.

## Commands and outcomes

- `pnpm lint`: exit 0 (`tsc --noEmit`).
- `pnpm test src/global-chat/relay`: 3 files, 69 tests passed, 0 failed.
  Breakdown: Room 55, adapter 10, memory store 4.
- `pnpm audit:filesize:check`: 0 violations, 0 grandfathered, 62 warning-band files.
- `pnpm audit:funcsize:check`: 0 violations, 0 grandfathered, 55 warning-band functions.
- `cd relay && pnpm exec tsc --noEmit`: exit 0.
- `cd relay && pnpm test`: 9 tests passed, 0 failed, real workerd SQLite and
  WebSockets. The 10-second persistent alarm test completed in about 10.1 seconds.
- `WRANGLER_SEND_METRICS=false pnpm exec tsx .afk-scratch/relay-e2e.ts`:
  exit 0. Real `GlobalChatClient` and `FileIdentityStore`, Node global `WebSocket`,
  `wrangler dev --local`, local vars for salt and test maintainer key. Removed
  `relay/.wrangler` before initial start; kept its state for the restart assertion.

The SQLite tests exercise `ensureSchema`, `insertMessage`, `markDeleted`,
`getBacklog`, `getMessageById`, `pruneOlderThan`, `countPostsByKeySince`, `addBan`,
`removeBan`, `isBannedKey`, `isBannedIp`, `getKeyRecord`, `upsertKeyRecord`,
`addReport`, `countReporters`, `getRoomMode`, and `setRoomMode`. Tests cover quoted
SQL-like input as data, shared-address bans, key-only unban, distinct reports,
first-seen preservation, deleted-backlog exclusion, >100-row pruning, and restart.
No query interpolates caller inputs into SQL.

## Real-client observed output

```text
two join online: [2,2]
real client onMessage signature accepted: ["first verified post"]
third welcome exact ordered backlog: ["first verified post","second ordered post"]
burst limit: {"code":"rate_limited","retryAfterMs":2948,"accepted":3}
fake credential locally refused: {"code":"secret_detected","spans":1,"sent":false}
ban: {"action":true,"targetClosed":"closed","rejoin":"banned","maintainerStillOpen":"open"}
unban: {"rejoined":true}
mode: {"readonly":"readonly","restored":"open"}
three distinct reports: {"deletedForAll":true,"newBacklogExcludes":true,"remaining":4}
immediate rename: {"code":"name_change_too_soon","retryAfterMs":86399979}
restart SQLite persistence: {"backlogCount":4,"backlogOrderPreserved":true,"ban":"banned"}
worker HTTP routing: {"room":426,"unknown":404}
```

`onMessage` is emitted only after the real client verifies the signature. The
third joiner's backlog was asserted for exact equality and order, not merely
"at least one". Three distinct non-author reporters each received successful
action results; all connected participants observed deletion. A later joiner
and a restarted runtime excluded the deleted row. For the ban-persistence test,
the target was offline when banned so the shared local test address would not
prevent the maintainer from rejoining.

## Original smoke anomalies: reproduced and explained

Original driver found at sibling worktree
`global-chat-relay/.afk-scratch/integration-test.mjs` and launcher
`run-integration.sh`. Reproduction driver
`.afk-scratch/reproduce-original.ts` bundles the original adapter from commit
`d96cbc8b7`, runs that original smoke script in real workerd/Miniflare on fresh
temporary state, disposes the runtime, then repeats against the same persisted
state. Observed output:

```text
RUN 1 CLEAN STATE
c1 welcome ok, online= 1
c2 welcome ok, online= 2
presence ok, online= 1
c1 got late presence, online= 2 (skipping)
c3 backlog ok, messages= 1 sig verified
RUN 2 SAME PERSISTED STATE AFTER RESTART
c1 welcome ok, online= 1
c2 welcome ok, online= 2
presence ok, online= 1
c1 got late presence, online= 2 (skipping)
c3 backlog ok, messages= 2 sig verified
```

**Presence cause:** the relay broadcasts presence after each successful hello,
including to the new participant. The driver consumes only c1's welcome at line
93, leaving its own `presence(1)` queued. Lines 108-115 consume that frame and
mislabel it as c2's join. The correct c2-join `presence(2)` is consumed later at
lines 124-129. No stale-attachment or production-only explanation is needed.

**Extra backlog cause:** the launcher starts ordinary persisted `wrangler dev`
without clearing state (lines 10-12). Each smoke run generates a new message id
and stores one post. A clean run has exactly one row; a second run correctly has
two. This is intended persistence, not an extra post created by the relay.
The old script also emitted three generic `WS error` lines when the test runtime
was disposed while its close handshakes were unfinished; these occurred after
`ALL ASSERTIONS PASSED`, not while validating presence or backlog.

The new concurrent hello/post tests separately demonstrate genuine old adapter
interleaving: without the event queue, concurrent hello snapshots lose online
counts and duplicate post IDs can broadcast twice. SQLite's primary key alone
cannot prevent the duplicate broadcast after both existence checks pass.

## Corrections and remaining boundary

Additional fixes: private ban errors instead of terminal errors to every user;
ack/error-id correlation for signed actions; close handshake completion and
closing-attachment filtering; same-key multi-socket presence; memory-store
key-only unban and SQLite parity; prune-associated-report cleanup and immediate
retention filtering despite bounded physical cleanup.

Relay rename clock: first successful hello sets `firstSeenAt`; unchanged name
is a no-op; first rename waits 24 hours from that first hello, later renames wait
24 hours from the last accepted rename. Maintainers bypass that interval. The
client uses identity creation time, so an identity created long before its first
hello can disagree. This is outside this lane and was reported, not changed.

Cloudflare docs confirm input gates cover storage I/O, not arbitrary crypto
awaits; hence an explicit event queue is required. Persistent alarms and socket
attachments are the documented hibernation-safe mechanism for hello deadlines.
The local runtime supports dates through 2025-07-18 and warns when falling back
from the configured 2026-11-20. Hosted hibernation, compatibility behavior, alarm
retry/delay behavior, trusted address headers, platform logs and load limits
need deployed staging verification. No such environment was contacted.

Current protocol constants already distinguish 4096-byte client frames from
262144-byte relay frames; the old shared 4096-byte welcome-cap conflict is not
present on this branch. The end-to-end run did not fill all 50 backlog slots.
