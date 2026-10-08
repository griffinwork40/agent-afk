## Bug: Node 26 REPL freezes at 100% CPU in nghttp2 DATA-frame spin loop on HTTP/2 connection to api.anthropic.com

### Symptoms

On Node 26 with agent-afk v5.306.3+, a REPL session can freeze at 100% CPU with the main thread stuck in a native nghttp2 loop. No JS runs while the loop is active — the UI becomes completely unresponsive. Memory grows without bound; macOS jetsam killed one affected process after it reached 232 GB compressed. A second affected session reached 78 GB before being killed. The freeze is intermittent (~2 of ~17 concurrent sessions were affected over the observation window) and was observed in two patterns:

- A session froze within seconds of init, before any user turn completed.
- A session froze while idle at the prompt, approximately 11 minutes after its last turn ended.

The process never recovers once the freeze starts and must be killed.

### Native stack (representative frame)

```
uv__run_check
  Http2Session::SendPendingData
    nghttp2_session_pack_data
      Http2Stream::Provider::Stream::OnRead   ← spins forever
```

### Root cause chain

1. **undici 8 changed `allowH2` to default `true`** (nodejs/undici PR #4828). In undici 7 and earlier, all connections were HTTP/1.1; in undici 8 the `Agent` will negotiate HTTP/2 when the server supports it.

2. **PR #3238** (merged 2026-10-07 22:50 UTC) bumped the npm `undici` dependency from `7.30.0` to `8.11.2` (required by jsdom 30, see #2525 / #2528).

3. **Importing npm undici — or jsdom, which imports it — writes an `Agent` with `allowH2: true` into the process-wide global-dispatcher slot** `globalThis[Symbol.for('undici.globalDispatcher.2')]` with `configurable: false`. Because the property is non-configurable, the slot cannot be restored after import.

4. **Node 26's built-in `fetch` reads the same global undici slot** for every request. So after jsdom is imported, ALL `fetch()` calls — including those made by the Anthropic SDK and OpenAI SDK clients — are dispatched through the h2-enabled `Agent` and can negotiate HTTP/2 with `api.anthropic.com`.

5. **Negotiating HTTP/2 with `api.anthropic.com` exposes the process to a spinning DATA-frame freeze on Node >= 26**, where a server-side or nghttp2 state causes `Http2Stream::Provider::Stream::OnRead` to be called in an infinite loop. The loop never yields to JS, so the event loop stalls permanently.

### Why the freeze is intermittent

The freeze appears to require a specific server-side or connection state to trigger. Not all HTTP/2 connections to api.anthropic.com freeze. Sessions that happen to land on an affected connection hang; others do not. The idle-prompt freeze suggests that a background HTTP/2 keep-alive or a background usage-polling call can also trigger it, not only the main streaming query path.

### Trigger

PR #3238 (undici 7->8 bump). Agent-afk ran without this freeze on Node 26 with undici 7 because HTTP/1.1 was always negotiated.

### Fix

Force HTTP/1.1 for all model API calls by using npm undici's own `fetch` with a dedicated `Agent({ allowH2: false })` passed as the `dispatcher` on every request. Because the dispatcher is set explicitly on each request, it bypasses the global-dispatcher slot entirely regardless of what jsdom has written there.

A shared `h1ModelFetch` helper (`src/agent/providers/shared/h1-fetch.ts`) is the single authoritative source of this forced-HTTP/1.1 fetch. It is wired into:

- `anthropic-direct` main query path via `buildClientOptions` -> SDK `fetch` option
- `anthropic-direct` one-shot path via `buildClientOptions` default
- `openai-compatible` main query path via `buildOpenAITracingFetch`
- `openai-compatible` one-shot paths (`oneshot.ts`, `complete-wire.ts`, `one-shot-router.ts`)
- OAuth token refresh (`auth/keychain.ts`)
- Usage polling (`subscription-usage.ts`, `usage/codex-usage.ts`) via injectable `fetchImpl`

### Residual risks

- **jsdom's global-dispatcher slot remains poisoned** for any code path that calls bare `fetch()` and is NOT one of the above model/auth paths (e.g. `web_scrape`, `http-client/scrape.ts`). Those paths are already using their own egress-guard dispatcher and are not affected by this bug, but a future caller that naively calls `fetch()` for a new model endpoint would be exposed.
- **npm undici fetch vs. built-in fetch interop** (see #2525, #2528): `h1ModelFetch` uses npm undici's `fetch`, not Node's built-in `fetch`. Body, `FormData`, and `AbortSignal` types from the two implementations are not interchangeable at the type level. This is safe for the SDK paths (they pass plain strings and JSON), but callers that stream large bodies or pass `FormData` should use `h1ModelFetch` with care.
- **OAuth token refresh on `platform.claude.com`**: The keychain `postTokenRefresh` now uses `h1ModelFetch`. This forces HTTP/1.1 on `platform.claude.com` as well. That server supports HTTP/1.1 (ALPN fallback) so this is safe, but it does widen the scope of `h1ModelFetch` beyond model API hosts.

Relates-to: #2525, #2528, #3238
