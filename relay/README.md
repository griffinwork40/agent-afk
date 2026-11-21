# afk-global-chat-relay

Cloudflare Worker and Durable Object adapter for the AFK global chat relay.
Routes WebSocket connections to a single room Durable Object backed by SQLite.

## What it stores and for how long

All state lives in one Durable Object per room (SQLite):

| Data | Retention |
|------|-----------|
| Messages (text, pubkey, name, sig, badge, deleted flag) | 7 days, pruned opportunistically on hello |
| Key registry (pubkey, name, first-seen timestamp, name-changed timestamp) | Indefinite (small, O(users)) |
| Bans (pubkey + ip hash of live connection at ban time) | Until explicitly unbanned |
| Reports (message id + reporter key pairs) | Until message is pruned |
| Room mode (open / readonly / closed) | Until changed |

IP hashes are stored as SHA-256(IP_SALT + CF-Connecting-IP). The raw IP address is never stored or logged. Message text is never logged.

## Running locally

Install dependencies inside `relay/`:

```
cd relay
pnpm install
```

Set required bindings. Create a `.dev.vars` file (never commit it):

```
IP_SALT=some-random-secret-string
ADMIN_PUBKEYS=
ROOM_NOTICE=
ROOM_MODE=
```

Start the local dev server:

```
pnpm dev
```

Wrangler starts a local Worker at `http://localhost:8787`. Connect via WebSocket at `ws://localhost:8787/v1/room/global`.

## Deploying

1. Create a Cloudflare account at https://dash.cloudflare.com if you do not have one.
2. Install Wrangler globally or use `npx wrangler`.
3. Authenticate: `wrangler login` (or set `CLOUDFLARE_API_TOKEN` for CI).
4. Set the IP salt secret (required -- never use a plain var for this):
   ```
   wrangler secret put IP_SALT
   ```
5. Set maintainer public keys (comma-separated 64-hex strings). This is non-secret so a plain var is fine:
   ```
   wrangler deploy --var ADMIN_PUBKEYS=<key1>,<key2>
   ```
   Or set it in `wrangler.toml` under `[vars]`.
6. Optionally set a room notice:
   ```
   wrangler deploy --var ROOM_NOTICE="Welcome to AFK global chat"
   ```
7. Deploy:
   ```
   wrangler deploy
   ```

The WebSocket endpoint will be at `wss://<your-worker>.workers.dev/v1/room/global`.

Set `AFK_GLOBAL_CHAT_URL=wss://<your-worker>.workers.dev/v1/room/global` in your AFK environment.

## Kill switch (forced room mode)

To lock the room without a code deploy, set the `ROOM_MODE` var to `open`, `readonly`, or `closed`:

```
wrangler deploy --var ROOM_MODE=closed
```

This overrides the stored mode from admin commands. To remove the override and restore normal operation:

```
wrangler deploy --var ROOM_MODE=
```

## Cloudflare Free plan limits that apply

- **Durable Objects:** 1 GB storage, 400,000 GB-s compute, 1,000,000 requests per day on the paid Workers plan. The Free plan does NOT include Durable Objects -- you need at minimum the Workers Paid plan ($5/month as of 2026).
- **SQLite in Durable Objects:** available on Workers Paid and above. The `new_sqlite_classes` migration used here requires it.
- **WebSocket connections:** counted as requests; each upgrade counts as one request.
- **Egress:** outbound data is metered at $0.045/GB beyond the free allowance on paid plans.

There is no built-in rate limiting from Cloudflare on WebSocket message volume; the relay enforces its own limits in the Room logic (60 posts/min per IP, burst-5 per key, 20/hr for new keys).
