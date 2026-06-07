# Model slots

User-configurable model bindings. Three fixed **capability tiers** — `small`,
`medium`, `large` — each bound to a concrete model the user chooses. The tier
*positions* are the stable anchor the `agent` / `compose` / `skill` tools select
among (cheapest → most capable); the *bindings* are what you configure.

> **Status:** Stages 1–2. A tier can be rebound to any model id (Stage 1) and
> carry its own `provider` / `baseUrl` / `apiKey` (Stage 2), so different tiers
> can target different providers + credentials in the same process — e.g.
> Anthropic for one tier, a local OpenAI-compatible shim for another, a hosted
> OpenAI model (with its own key) for a third.

## Configuring the tiers

### afk.config.json

Each slot accepts a bare id string, or an object with an optional custom `name`
and optional per-slot provider credentials (`provider` / `baseUrl` / `apiKey`):

```jsonc
{
  "models": {
    // Stage 1: just rebind the id (provider inferred, global creds).
    "small":  "claude-haiku-4-5-20251001",
    // Stage 2: a local OpenAI-compatible shim with its own endpoint.
    "medium": {
      "id": "mlx-community/Qwen3-32B-4bit",
      "name": "local",
      "provider": "openai",
      "baseUrl": "http://localhost:8080/v1",
      "apiKey": "local"
    },
    // Stage 2: hosted OpenAI with its own key, alongside Anthropic above.
    "large":  { "id": "gpt-4.1", "provider": "openai", "apiKey": "sk-…" }
  }
}
```

`provider` is `anthropic` or `openai` (inferred from the id when omitted). For an
Anthropic-routed tier, `baseUrl` is the Messages-API base; for an OpenAI-routed
tier it is the Chat Completions base. A per-slot value wins over the
corresponding global (`AFK_OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, …) for that
tier only.

### Environment

Per-tier env overrides (env beats the afk.config.json `models` block; a
file-provided `name`/`provider` is preserved when env overrides only the id or
credentials):

| Var | Binds |
| --- | --- |
| `AFK_MODEL_{SMALL,MEDIUM,LARGE}` | the tier's model id |
| `AFK_MODEL_{SMALL,MEDIUM,LARGE}_BASE_URL` | the tier's endpoint base URL |
| `AFK_MODEL_{SMALL,MEDIUM,LARGE}_API_KEY` | the tier's API key (secret) |

```bash
# A local shim on the small tier, keys/endpoint out of any file:
AFK_MODEL_SMALL='mlx-community/Qwen3-32B-4bit' \
AFK_MODEL_SMALL_BASE_URL='http://localhost:8080/v1' \
AFK_MODEL_SMALL_API_KEY='local' afk i
```

(`provider` is config-only — set it in afk.config.json when a bare id needs an
explicit provider; env-bound ids are inferred or paired with a config `provider`.)

### Default bindings

An unconfigured install behaves exactly as before this feature:

| Tier     | Default id                      | Legacy aliases            |
| -------- | ------------------------------- | ------------------------- |
| `small`  | `claude-haiku-4-5-20251001`     | `haiku`                   |
| `medium` | `claude-sonnet-4-6`             | `sonnet`, `sonnet_1m`     |
| `large`  | `claude-opus-4-8`               | `opus`, `opus_1m`         |

## Selecting a tier

Anywhere a model is named — `AFK_MODEL` / `afk -m <…>`, the REPL/Telegram
`/model` command, and the `agent`/`compose`/`skill` tools' `model` parameter —
you may pass a **tier name** (`small`/`medium`/`large`), your **custom name**, a
**legacy alias** (`haiku`/`sonnet`/`opus`), the `auto` sentinel, or a **raw
model id**.

## Resolution precedence

For any model input string (`slotForInput` / `resolveModelInput` in
`src/agent/session/model-slots.ts`):

1. **custom name** — a user-assigned `name` on a binding (case-insensitive)
2. **neutral name** — `small` | `medium` | `large`
3. **legacy alias** — `haiku`→small, `sonnet`/`sonnet_1m`→medium, `opus`/`opus_1m`→large
4. otherwise — a raw concrete id or the `auto` sentinel (passthrough, unchanged)

A resolved slot expands to `bindings[slot].id`. The concrete id is what reaches
the provider SDK **and** what `providerForModel` routes on — so a tier rebound to
a non-Anthropic id (e.g. `small → gpt-4o-mini`) routes to `openai-compatible`.

## How it works

**Routing (Stage 1).** `providerForModel()` resolves the slot alias to its full
binding **before** pattern matching, honoring an explicit per-slot `provider`
then falling back to id inference. This single resolution-before-routing step
means every routing call site — subagent dispatch, the child `providerForModel`
factory, and the CLI/Telegram surfaces — gets correct routing for free, without
per-site changes. Idempotent: full ids and `auto` pass through untouched.

**Credentials (Stage 2).** A session runs exactly one model.
`AgentSession.initSdkLifecycle` calls `applySlotCredentials`, which resolves the
session's model to its slot and, when that slot carries `apiKey`/`baseUrl`,
writes them onto the session config: `apiKey → config.apiKey`, and `baseUrl →
config.baseUrl` (Anthropic) or `config.openaiBaseUrl` (OpenAI). The OpenAI
provider reads `config.openaiBaseUrl` at query time (per-slot wins over the
construction-time global). This one chokepoint covers the main session **and**
every child dispatch path (subagent / compose / skill / dag) uniformly.

Because per-slot credentials are exactly the keys the user bound to each tier,
they are applied directly — never auto-loaded or cross-wired — so the #548
invariant holds (an Anthropic OAuth token can't leak into an OpenAI tier).

Bindings are process-global config (one afk.config.json + env per process).
`loadConfig()` resolves and installs them via `setSlotBindings`; the agent layer
falls back to defaults + env when constructed without the CLI config loader.

## What works

- All tiers on Anthropic (the default; unconfigured behavior is unchanged).
- Each tier on a **different** provider + endpoint + key, simultaneously — e.g.
  Anthropic on one tier, a local OpenAI-compatible shim on another, hosted OpenAI
  (own key) on a third.
- Per-tier credentials via afk.config.json or the `AFK_MODEL_*` env vars.

## See also

- `src/agent/session/model-slots.ts` — bindings, resolver, defaults, config parse.
- `src/agent/session/slot-credentials.ts` — per-slot credential application.
- `src/agent/providers/index.ts` — `providerForModel` resolution-before-routing.
- `docs/env-registry.md` — `AFK_MODEL_{SMALL,MEDIUM,LARGE}{,_BASE_URL,_API_KEY}`.
