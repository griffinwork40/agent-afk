# xAI / Grok provider

First-class Grok support via the `xai` provider (`src/agent/providers/xai/`).
It composes the OpenAI-compatible Chat Completions wire path and owns
SuperGrok / SuperGrok Heavy / X Premium+ OAuth plus dual inference endpoints.

## Quick start

### Metered API key

```bash
export XAI_API_KEY=xai-...
afk chat -m grok-4.5 "hello"
# or force mode:
afk chat --provider xai -m grok-4.5 "hello"
```

Default endpoint: `https://api.x.ai/v1`  
Override: `AFK_XAI_BASE_URL`

### SuperGrok / SuperGrok Heavy / X Premium+ (subscription OAuth)

One login covers SuperGrok, SuperGrok Heavy, and X Premium+ when the X account
is linked. There is no separate “Heavy OAuth” mode — the account tier decides
which models and quota apply.

```bash
# Device-code (default) — works over SSH / daemon / Telegram
afk provider auth xai login

# Browser PKCE loopback on http://127.0.0.1:56121/callback
afk provider auth xai login --browser

afk chat -m grok-4.5 "hello"
# or force OAuth mode when an API key is also present:
afk chat --provider xai-oauth -m grok-4.5 "hello"

afk provider auth xai logout   # clear tokens
```

Default OAuth inference endpoint: `https://cli-chat-proxy.grok.com/v1`  
Override: `AFK_XAI_OAUTH_BASE_URL`

Tokens live at `~/.afk/state/xai/auth.json` (mode `0600`). AFK owns refresh
and **must** overwrite both `access_token` and `refresh_token` on every
refresh (xAI rotates refresh tokens).

## Auth modes

| Mode | How selected | Credentials | Default base URL |
|------|----------------|-------------|------------------|
| API key | `--provider xai`, slot `provider: 'xai'`, or auto when only `XAI_API_KEY` is set | `config.apiKey` → `XAI_API_KEY` | `https://api.x.ai/v1` |
| OAuth | `--provider xai-oauth`, slot `provider: 'xai-oauth'`, or auto when only OAuth tokens exist | SuperGrok OAuth store | `https://cli-chat-proxy.grok.com/v1` |

**When both an API key and OAuth tokens exist**, AFK does **not** pick silently.
Choose explicitly with `--provider xai` or `--provider xai-oauth` (or the
matching slot `provider` field).

`OPENAI_API_KEY` is never used for Grok (anti-leak).

### Diagnose / doctor

```bash
afk provider auth diagnose   # OpenAI + xAI sections; last4 only, never raw tokens
afk doctor                   # includes “xAI / Grok auth” check
```

## Why OAuth defaults to the CLI chat proxy

Live accounts often get **402** (`personal-team-blocked:spending-limit`) or
**403** on `api.x.ai` with subscription OAuth tokens. The Grok CLI chat proxy
is the path that commonly accepts SuperGrok quota. Some accounts still work on
`api.x.ai` with OAuth — set:

```bash
export AFK_XAI_OAUTH_BASE_URL=https://api.x.ai/v1
```

When the resolved OAuth base URL is the CLI proxy host, AFK attaches Grok-CLI
identity headers (`X-XAI-Token-Auth`, `x-grok-client-*`, `User-Agent`).

### 402 / 403 after login

- **403** — may mean missing OAuth API entitlement, a model that needs
  **SuperGrok Heavy**, or the wrong endpoint. Try the proxy URL (default) or
  fall back to `XAI_API_KEY` + `--provider xai`.
- **402** — subscription / spend gate, not a missing login. Check SuperGrok /
  SuperGrok Heavy / X Premium+ status, try the other endpoint, or use a
  metered key.

## Models

Any `grok-*` id is routed to the xAI family and **passed through unchanged** —
including future or unlisted wire ids. Context windows and metered list prices
are registered only for models still active on the public docs.x.ai catalog
(2026-08):

| Wire id | Context (approx.) | Notes |
|---------|-------------------|--------|
| `grok-4.5` | 500k | Flagship coding / agentic |
| `grok-4.3` | 1M | General long-context |
| `grok-4.20-0309-reasoning` | 1M | |
| `grok-4.20-0309-non-reasoning` | 1M | |
| `grok-4.20-multi-agent-0309` | 1M | Multi-agent / Heavy-oriented SKU |
| `grok-build-0.1` | 256k | Build / coding specialist |

Retired families (`grok-2*`, `grok-3*`, bare `grok-4`, fast variants from the
2026-05 retirement wave, etc.) are **not** listed here and are not in the
pricing table. If you still pass one of those ids (or any other `grok-*`),
AFK will send it to the API as-is; context uses the OpenAI-compatible default
and cost is `undefined` (never silent `$0`).

**Cost reporting under OAuth** may not match metered list prices (subscription
quota). Prefer treating OAuth spend as unknown in UX.

## Model slots

```json
{
  "models": {
    "large": { "id": "grok-4.5", "provider": "xai-oauth" },
    "medium": { "id": "grok-4.3", "provider": "xai" }
  }
}
```

`provider: 'xai'` forces API-key mode for that tier; `xai-oauth` forces
SuperGrok OAuth. Per-tier `baseUrl` maps to **`xaiBaseUrl`** (consumed only by
`XaiProvider` / `resolveXaiEndpoint`). It does **not** write `openaiBaseUrl` or
honor global `AFK_OPENAI_BASE_URL` for Grok traffic.

## Env vars

| Variable | Purpose |
|----------|---------|
| `XAI_API_KEY` | Metered API key |
| `AFK_XAI_BASE_URL` | API-key endpoint override (default `https://api.x.ai/v1`) |
| `AFK_XAI_OAUTH_BASE_URL` | OAuth inference endpoint override (default CLI chat proxy) |
| `AFK_PROVIDER` | Force `xai` or `xai-oauth` (same as `--provider`) |

## Implementation map

| Concern | Location |
|---------|----------|
| Provider shell | `src/agent/providers/xai/index.ts` |
| Auth resolution | `src/agent/providers/xai/auth.ts` |
| Token store | `src/agent/providers/xai/auth-store.ts` |
| OAuth (device-code, PKCE, refresh) | `src/agent/providers/xai/oauth*.ts` |
| Dual endpoints + headers | `src/agent/providers/xai/endpoints.ts`, `headers.ts` |
| Pricing | `src/agent/providers/xai/pricing.ts` |
| Routing | `src/agent/providers/index.ts` (`grok-*` → `xai`) |
| CLI | `afk provider auth xai login\|logout`, `diagnose` |

## Surfaces / known gaps

| Surface | Status |
|---------|--------|
| CLI `afk chat` / interactive REPL / daemon | Supported (`XaiProvider`) |
| **Telegram bot** | **Out of scope for this PR.** Telegram still classifies non-`openai-compatible` models as Anthropic-routed and does not construct `XaiProvider`. TODO: add an xAI branch (or generalize the OpenAI session builder) so `grok-*` uses SuperGrok OAuth / `XAI_API_KEY` + dual endpoints. Until then, use CLI/daemon for Grok. |

Related: [OpenAI Responses & ChatGPT OAuth](openai-responses-and-chatgpt-oauth.md),
[model slots](model-slots.md), [architecture](architecture.md).
