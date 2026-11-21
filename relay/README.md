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
persistent Durable Object alarm is armed for the earliest pending deadline,
closes expired sockets with code 1008, then re-arms for the next deadline.
Attachments and alarms survive hibernation without a memory-resident timer.
A late hello is rejected even if alarm delivery was delayed. Alarms have
at-least-once execution and can be delayed by platform maintenance; 10 seconds
is a handshake deadline, not a hard real-time TCP teardown guarantee. See
[Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

Post limits are burst 5 with one token replenished per 3 seconds per key,
20/hour for keys first seen less than 24 hours ago, and 60/minute per address
hash. In-memory post counters reset on hibernation; these are abuse friction,
not durable quotas. Accepted signed actions receive an ack, rejected actions
an error carrying their request id. Ban errors go only to the banned sockets.
A live ban captures an address hash and rejects other keys from that address;
a ban of an offline key has no address hash. Unbanning removes that key's ban
row; an address shared by another ban remains blocked.

## Name rule

A brand-new key's first successful hello registers its name and `firstSeenAt`.
An unchanged name is accepted without moving the clock. A different name is
refused until 24 hours after first successful hello (before any prior rename),
or 24 hours after the last accepted rename. A successful rename updates
`nameChangedAt` but preserves `firstSeenAt`. Maintainer keys bypass the rename
interval. This server clock begins at first hello, not local identity creation.

## Storage and privacy

| Data | Retention |
|------|-----------|
| Messages: id, signed timestamp, public key, name, text, signature, badge, deletion flag | Eligible for physical pruning after 7 days; up to 100 expired rows cleaned on each hello |
| Backlog | Newest 50 non-deleted, non-expired messages in timestamp order; equal timestamps use insertion order |
| Reports: message id and distinct reporter public key | Removed when the associated message is physically pruned |
| Key registry: public key, name, first seen, last name change | Indefinite |
| Bans: public key and captured salted address hash | Until explicitly unbanned |
| Room mode and monotonic retention cutoff | Until changed |

The retention cutoff hides *all* expired rows immediately on a hello, even
when more than 100 rows await physical cleanup. Without future hellos, old
physical rows can remain stored. Deleted messages remain available for duplicate
checks but never appear in backlog. Three distinct non-author reporters delete
a message and notify connected clients; repeating one reporter does not count.

The adapter hashes `SHA-256(IP_SALT + CF-Connecting-IP)`; only the hash enters
attachments/storage. Raw addresses are never persisted by application code.
The relay emits no logs containing message text, names, keys, addresses, or
frames. Its only explicit log is the structural invalid-salt error above.
Cloudflare infrastructure/request logs are outside this application policy;
operators must configure access, logging, and retention appropriately. SQL
inputs are bound parameters, not concatenated into SQL statements.

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
