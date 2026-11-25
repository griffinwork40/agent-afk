# afk-global-chat-relay

Cloudflare Worker and SQLite-backed Durable Object adapter for one public room.
No relay is deployed by this repository. Do not treat local tests as deployment.

## Required and optional settings

| Binding | Behavior |
|---------|----------|
| `ROOM` | Required Durable Object namespace, configured in `wrangler.toml` |
| `IP_SALT` | Required secret, at least 16 characters; use a long randomly generated value |
| `ADMIN_PUBKEYS` | Optional comma-separated lowercase 64-hex public keys; empty means no maintainers |
| `ROOM_NOTICE` | Optional welcome notice |
| `ROOM_MODE` | Optional `open`, `readonly`, or `closed`; overrides the stored admin-selected mode |

Missing or shorter-than-16-character `IP_SALT` refuses WebSocket admission with
HTTP 503 and logs only `Chat relay unavailable: IP_SALT must contain at least 16 characters`.
There is no unsalted fallback. Rotating the salt invalidates existing address
ban hashes; key bans remain effective. Invalid maintainer key entries are ignored.
Invalid or empty `ROOM_MODE` means use the persisted mode (default `open`).

## Local development and verification

From `relay/`:

```sh
pnpm install
pnpm test
pnpm typecheck
```

Create a gitignored `relay/.dev.vars` file with a test salt and test public key:

```dotenv
IP_SALT=local-test-salt-at-least-sixteen-characters
ADMIN_PUBKEYS=<test-maintainer-public-key>
ROOM_NOTICE=
ROOM_MODE=
```

Run `pnpm dev --local`. Connect to
`ws://localhost:8787/v1/room/global`. A non-upgrade request to that path returns
426 before obtaining a Durable Object stub; `/` is an HTTP health check; unknown
paths return 404. The health check does not validate room configuration.

Wrangler persists local SQLite state in `relay/.wrangler/state/`. Stop Wrangler
and delete that local directory before a *clean-state* test. Do not delete it
between the two halves of a persistence test. Never use your real AFK identity
for test automation; use `FileIdentityStore` with temporary file paths.

`pnpm test` bundles a test-only store harness and the production Worker into
Miniflare/workerd, covering every SQLite store method, runtime restart,
WebSocket admission, and the real 10-second hello alarm. The test harness is
not exported by the production entry point. The pinned Wrangler 3 runtime
supports compatibility dates through 2025-07-18 and warns/falls back from the
configured 2026-11-20 date. Hosted compatibility behavior still needs staging
verification before deployment; this package does not silently change that date.

## Connection lifecycle and limits

All accept, message, close, error, and alarm events join one promise queue.
Attachments are read only after that event owns the turn. Storage input gates
alone do not serialize signature-verification awaits. See Cloudflare's
[storage/input-gate documentation](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/).

Admission caps apply **before** accepting a socket, whether or not it sent hello:
5 sockets per salted address hash and `MAX_TOTAL_CONNECTIONS = 500` per object.
HTTP 429 means address cap; HTTP 503 means total cap or invalid salt. Closing
sockets count toward these resource caps until the runtime releases them, but
are excluded from presence and broadcasts. Presence counts distinct hello'd
public keys, not sockets. Closing one of several sockets for one key does not
remove that key from presence.

Each attachment stores a hello deadline of `HELLO_TIMEOUT_MS = 10000`. The
persistent Durable Object alarm is armed for the earliest hello deadline, message
expiry, inactive-key expiry, or consumed-action expiry. It closes expired pending
sockets with code 1008, prunes storage, then re-arms for the next deadline.
Attachments and alarms survive hibernation without a memory-resident timer.
A late hello is rejected even if alarm delivery was delayed. Alarms have
at-least-once execution and can be delayed by platform maintenance; 10 seconds
is a handshake deadline, not a hard real-time TCP teardown guarantee. See
[Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

Each socket may complete hello exactly once. A second hello returns `bad_frame`
(`Hello already completed`) and closes it. Before enqueueing, the adapter rejects
binary or over-4096-byte client frames and closes a socket with more than 16
pending message events. New-key registrations are limited to 20/hour per address
hash; existing keys do not consume registration quota. Idle limiter entries are
swept fairly, at most 16 entries per call. In-memory registration counters may
reset on hibernation, like post counters; this is not a durable identity quota.

Post limits are burst 5 with one token replenished per 3 seconds per key,
20/hour for keys first seen less than 24 hours ago, and 60/minute per address
hash. In-memory post counters reset on hibernation; these are abuse friction,
not durable quotas. Accepted signed actions receive an ack, rejected actions
an error carrying their request id. Ban errors go only to the banned sockets.
A live ban captures an address hash and rejects other keys from that address;
a ban of an offline key has no address hash. Unbanning removes that key's ban
row; an address shared by another ban remains blocked.

## Name rule

The client's identity store owns the user-facing 24-hour rename rule, measured
from local creation or the last local rename. The relay only has a 10-minute
abuse backstop between name changes it actually observes. First hello registers
the name but starts no rename clock; the first observed change is allowed.
Unchanged-name reconnects do not move the change clock. A refused change returns
`name_change_too_soon` with `retryAfterMs`. Maintainers bypass this backstop.
Successful changes preserve `firstSeenAt` and update `nameChangedAt`.

## Storage and privacy

| Data | Retention |
|------|-----------|
| Messages: id, signed timestamp, public key, name, text, signature, badge, deletion flag | 7 days from signed timestamp; persistent expiry alarm physically deletes batches of 100 |
| Backlog | Newest 50 non-deleted, non-expired messages in timestamp order; equal timestamps use insertion order |
| Reports: message id and distinct reporter public key | Removed when the associated message is physically pruned |
| Key registry: public key, name, first seen, last seen, last name change | Pruned after 30 inactive days if unbanned and no retained messages; batches of 100 |
| Bans: public key and captured salted address hash | Until explicitly unbanned |
| Consumed admin/report ids (namespaced by author and frame type), expiry | Until signed timestamp plus 120001 ms; bounded alarm cleanup |
| Room mode and monotonic retention cutoff | Until changed |

Expiry cleanup does not require a future connection. The adapter schedules the
first alarm at the oldest message's signed timestamp plus 7 days plus 1 ms.
Every alarm physically deletes up to 100 expired rows and associated reports,
then requests another alarm for 1 ms later while expired rows remain. A hello
also opportunistically prunes. The retention cutoff hides expired rows even
when a cleanup batch remains. Deleted messages remain for duplicate checks until
expiry, but never appear in backlog. Three distinct non-author reporters hide a
message and notify connected clients; repeating one reporter does not count.

Deletion delay: the application adds 1 ms after expiry and, for a backlog of N
expired rows, at most ceil(N/100) serialized alarm batches (each subsequent alarm
requested 1 ms later), plus event processing time. There is no finite worst-case
wall-clock guarantee during Cloudflare outages, alarm delivery delays, or retries.
This is active scheduled deletion, not a claim of hard real-time platform service.
No traffic is required. Hosted alarm delay behavior still needs staging validation.

The SQLite schema includes `last_seen_at` from creation; no old-table migration
is provided because no relay has been deployed. Use fresh local state after
upgrading an older development database. Hello and accepted posts update last
seen. Ban records remain until explicitly removed even if a key is inactive.

The adapter hashes `SHA-256(IP_SALT + CF-Connecting-IP)`; only the hash enters
attachments/storage. Raw addresses are never persisted by application code.
The relay emits no logs containing message text, names, keys, addresses, or
frames. Its only explicit log is the structural invalid-salt error above.
Cloudflare infrastructure/request logs are outside this application policy;
operators must configure access, logging, and retention appropriately. SQL
inputs are bound parameters, not concatenated into SQL statements.

## Authentication boundaries

Posts are independently signed and verified by clients. The maintainer badge is
**unsigned relay-assigned metadata**, not part of the author's signature. The
relay decides which keys show badges; pointing a client at another relay means
seeing that relay's maintainers. A malicious relay can lie about badges, presence,
room mode, deletion notices, or message availability, but cannot forge posts.

Admin/report ids are consumed only after signature and timestamp validation and
persist through hibernation. Replays inside the complete skew-validity window
return `duplicate`, including replaying a ban after an unban. The timestamped
hello has no server challenge or socket nonce: a captured hello can be replayed
on a different connection within the 120-second skew window. Capturing one
requires breaking TLS, compromising an endpoint, or being the relay. This is an
accepted handshake limitation; posts still need their own signatures.

The client bounds pending relay work to 32 frames and 1 MiB, caps single frames
at 262144 bytes, and reconnects with backoff on overflow. It checks live-message
freshness (150 seconds), backlog retention/order, and keeps 4096 recently seen
ids including deletion notices independently of view scrollback. Oldest ids are
evicted first; replay protection is bounded and is not durable across client
restarts. A lost connection after handing an action to the socket returns
`delivery_unknown`, not an assertion that nothing was sent.

## Deployment and operator kill switch

Deployment is a separate operator action, not part of local verification.
Configure a Cloudflare Worker with the `ROOM` binding and SQLite class migration
in `wrangler.toml`, set `IP_SALT` as a secret, and set the optional public vars.
Use an account and plan that support SQLite Durable Objects. Check
[current Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and limits; SQLite Durable Objects are available on Free and Paid plans, with
different daily/monthly allowances. The old claim that Paid is required is
incorrect. WebSocket upgrade requests, incoming messages and alarms can incur
usage; hibernation avoids idle duration charges when eligible.

The hosted endpoint is `wss://<worker-host>/v1/room/global`; set
`AFK_GLOBAL_CHAT_URL` to it in the AFK environment. Setting `ROOM_MODE=closed`
in the Worker's configuration overrides stored admin mode; changing that
binding requires a configuration update/deployment, not merely editing a local
file. Clear the override to restore the persisted admin-selected mode.

Before production, verify hosted hibernation/wake, alarm scheduling/retries,
compatibility-date behavior, address-header authenticity, platform logging,
and load limits. Local workerd tests cannot establish those hosted properties.
