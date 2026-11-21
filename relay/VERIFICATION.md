# Review-fix local verification receipt (2026-11-20)

Branch `afk/global-chat-relayfix`. No push, Cloudflare login, deployment, or
account operation. Only assigned global-chat client/relay paths were changed.
Scratch drivers, temporary test identities, local databases, and raw logs live
under this worktree's ignored `.afk-scratch/`, never the real AFK state directory.

## Findings and commits

| Finding | Confirmed evidence and regression test | Commit |
|---------|----------------------------------------|--------|
| 7: disconnect misreports sent actions | Pending actions previously all became `not_connected`; track socket handoff, return `delivery_unknown` after handoff. Client tests cover transmitted post/report disconnects and interrupted signing before send. | `bfed15fbf` |
| 1: ingress queues | Client and adapter previously chained work without admission bounds. Client: 32 pending frames, 1 MiB, 262144 bytes/frame; overload disconnects with normal backoff. Adapter: 4096 bytes before enqueue, 16 pending events/socket. Tests pin count, bytes, single-frame overflow, UTF-8 sizing, and bystander progress. | `b899930e4` |
| 4: old genuine messages | Client previously only verified signature/sanitization. Live freshness 150 seconds, backlog seven-day/future/order filtering, 4096 FIFO seen/deleted ids independent of view. Tests pin stale/future/replay/deletion/order and FIFO eviction. | `ec5780fcb` |
| 5: quiet-room retention | Only hello previously triggered prune. Persistent alarms now select earliest hello/message expiry, physically prune 100 rows/batch, immediately rearm for remainder. Platform-neutral tests drain 205 rows; real workerd and Wrangler test SQLite row deletion with no hello/traffic while expiry occurs. | `c4a811bdd` |
| 2: growing registry/counters | Repeated successful hello previously allowed; only one now. 20 unseen keys/address/hour. Required `last_seen_at` added to fresh schema (no deployed relay, no migration); hello/post update it. Prune 100 idle unbanned keys without retained messages after 30 days. Fair limiter sweep 16/call. Memory and real SQLite tests pin bounds and exclusions. | `3b65bc13b` |
| 3: replayed moderation | Valid signatures/timestamps previously lacked consumed ids. Store author/type/id until signed timestamp + skew + 1 ms, covering future skew. Prune via alarms. Ban/unban/replayed ban and report replay tests recreate Room; real SQLite test restarts workerd. | `7ba42e8c7` |
| 6: rename mismatch | Relay previously measured 24h from first hello/observed rename. First hello now starts no clock; first observed rename allowed, subsequent changes backstopped at 10 minutes with retryAfterMs. Client keeps 24h rule. Unit and client/Room e2e tests pin delayed observation and exact retry. | `edebb6bbc` |
| 8: self-report | Confirmed unchanged: `forbidden`, exact relay text `Cannot report your own message`. Regression test asserts both. Client intentionally substitutes generic relay text; view must guard by target ownership, not original description. | pinned in `7ba42e8c7` |

No finding was refuted. Badge remains unsigned relay metadata. Timestamped hello
replay on a different socket inside the skew window is explicitly accepted and
documented, not given a new server challenge.

## Final gate results

- `pnpm lint`: exit 0 (`tsc --noEmit`).
- `pnpm test src/global-chat`: **16 files, 433 passed, 0 failed**.
  Client 100, in-memory e2e 11, relay Room 59, adapter 13, limiter 3, memory store 5.
- `pnpm audit:filesize:check`: **0 violations, 0 grandfathered, 62 warning-band files**.
- `pnpm audit:funcsize:check`: **0 violations, 0 grandfathered, 56 warning-band functions**.
- `cd relay && pnpm exec tsc --noEmit`: exit 0.
- `cd relay && pnpm test`: **12 passed, 0 failed**. Real workerd SQLite,
  restart, WebSockets, 10-second hello alarm, and quiet expiry deletion.
  Hello alarm test about 10.09 seconds; short-retention test about 1.89 seconds.
- `src/global-chat/client.test.ts` **20 consecutive runs, all 100 tests passed
  each time: 2000 test executions, 0 failed runs, 0 failed tests**.
  Raw logs `.afk-scratch/client-streak-1.log` through `client-streak-20.log`.
- Read-only independent spot-check found no confirmed regression; it highlighted
  alarm backlog rearming as an operational cost, not a failed invariant.

## Real Wrangler e2e

`WRANGLER_SEND_METRICS=false pnpm exec tsx .afk-scratch/relay-e2e.ts`, exit 0.
Real `GlobalChatClient`, `FileIdentityStore`, Node WebSocket, `wrangler dev
--local`, unique fresh `--persist-to` directory. Same directory reused only for
restart verification, never production/local ambient databases deleted.

```text
two join online: [2,2]
real client onMessage signature accepted: ["first verified post"]
third welcome exact ordered backlog: ["first verified post","second ordered post"]
burst limit: rate_limited, accepted=3, retryAfterMs=2950
fake credential locally refused: secret_detected, spans=1, sent=false
ban: action=true, targetClosed=closed, rejoin=banned, maintainerStillOpen=open, bystanderStillOpen=open
unban: rejoined=true
mode: readonly refused, restored=open
three distinct reports: deletedForAll=true, newBacklogExcludes=true, remaining=4
first observed rename: accepted=true, name=dave_renamed
restart SQLite persistence: backlogCount=4, backlogOrderPreserved=true, ban=banned
captured admin replay after unban: duplicate
second hello: bad_frame, closed=true
oversized UTF8 frame: bytes=4098, closed=true
worker HTTP routing: room=426, unknown=404
```

`WRANGLER_SEND_METRICS=false pnpm exec tsx .afk-scratch/wrangler-retention.ts`,
exit 0. Bundles the committed test-only `relay/test/retention-worker.ts` with a
source transform replacing seven-day retention by 1000 ms. Generates a scratch
Wrangler configuration; no production binding/env override exists. Real
`wrangler dev --local`, fresh state: SQLite rows before=1, rows after=0, no
reconnect and no intervening traffic while waiting 2 seconds for the real alarm.
The test-only row-count route performs no cleanup. Equivalent regression is in
`relay/test/retention.test.ts` for the normal local suite.

## Remaining verification boundaries

Hosted hibernation, compatibility behavior, alarm delays/retries/outages, trusted
address headers, platform logs, resource limits, and actual deployment are not
verified. Pinned Wrangler 3 uses workerd compatibility through 2025-07-18 and
warns when falling back from production's configured 2026-11-20 date.

There is no finite worst-case wall-clock deletion guarantee during platform
outages. Application scheduling adds 1 ms at expiry, then 100 physical deletions
per alarm batch with 1 ms requested rearming while expired rows remain, plus
event processing/platform delivery delay. This limitation is stated in README,
not hidden behind a hard seven-day real-time guarantee. Recently seen-id replay
protection is bounded at 4096 and resets across client restarts by design.
