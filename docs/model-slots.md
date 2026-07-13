# Model slots

User-configurable model bindings. Four fixed **capability tiers** — `local`,
`small`, `medium`, `large` — each bound to a concrete model the user chooses. The
tier *positions* are the stable anchor the `agent` / `compose` / `skill` tools
select among (cheapest → most capable); the *bindings* are what you configure.

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
| `AFK_MODEL_{LOCAL,SMALL,MEDIUM,LARGE}` | the tier's model id |
| `AFK_MODEL_{LOCAL,SMALL,MEDIUM,LARGE}_BASE_URL` | the tier's endpoint base URL |
| `AFK_MODEL_{LOCAL,SMALL,MEDIUM,LARGE}_API_KEY` | the tier's API key (secret) |

```bash
# Point the local tier at Ollama. The per-slot BASE_URL routes the tier to the
# OpenAI-compatible path even though `llama3.2:3b` matches no provider prefix;
# the API key is a throwaway many shims merely require to be non-empty.
AFK_MODEL_LOCAL='llama3.2:3b' \
AFK_MODEL_LOCAL_BASE_URL='http://localhost:11434/v1' \
AFK_MODEL_LOCAL_API_KEY='ollama' afk i

# An MLX shim on the small tier (an `org/model` id routes to openai-compatible
# on its own), keys/endpoint out of any file:
AFK_MODEL_SMALL='mlx-community/Qwen3-32B-4bit' \
AFK_MODEL_SMALL_BASE_URL='http://localhost:8080/v1' \
AFK_MODEL_SMALL_API_KEY='mlx' afk i
```

A per-slot `BASE_URL` routes the tier to the OpenAI-compatible path even for a
bare id that matches no provider prefix (Ollama / LM Studio tags like
`llama3.2:3b`). `provider` itself is config-only — set it in afk.config.json to
force an **Anthropic**-compatible shim on a bare id, or use a `local-*` id, which
routes to anthropic-direct. (Note: `AFK_MODEL_LOCAL_BASE_URL` is the per-slot
endpoint for the `local` **tier**; the separate `AFK_LOCAL_BASE_URL` is the
global endpoint for `local-*` **ids** on the Anthropic-shim path — different
knobs.)

### Default bindings

An unconfigured install behaves exactly as before this feature:

| Tier     | Default id                      | Identity alias (fixed)    |
| -------- | ------------------------------- | ------------------------- |
| `local`  | `` (empty — user-configured)    | —                         |
| `small`  | `claude-haiku-4-5-20251001`     | `haiku`                   |
| `medium` | `claude-sonnet-5`             | `sonnet`, `sonnet_1m`     |
| `large`  | `claude-opus-4-8`               | `opus`, `opus_1m`         |

## Identity aliases vs. capability tiers

The built-in Claude handles (`haiku`/`sonnet`/`opus`/`fable`/`*_1m`) are
**fixed-identity aliases**, not tier aliases: they resolve to their concrete
model **regardless of how the tiers are bound**. Rebinding `medium` to (say) an
OpenAI model therefore does NOT change what `sonnet` means — only the neutral
tier names (`local`/`small`/`medium`/`large`) and your custom names follow the
bindings. (Before this split, `sonnet` was a mere alias for the `medium` tier,
so rebinding `medium` silently hijacked the `sonnet` handle — and flipped the
default session model with it, since the default is the `medium` tier.)

## Selecting a model

Anywhere a model is named — `AFK_MODEL` / `afk -m <…>`, the REPL/Telegram
`/model` command, and the `agent`/`compose`/`skill` tools' `model` parameter —
you may pass a **tier name** (`local`/`small`/`medium`/`large`), your **custom
name**, an **identity alias** (`haiku`/`sonnet`/`opus`/`fable`/`*_1m` — always
the fixed model), a **raw model id** (including a full `claude-…` wire id or an
`org/model` id), or the `auto` sentinel.

## Resolution precedence

For any model input string (`slotForInput` / `resolveBinding` in
`src/agent/session/model-slots.ts`):

1. **custom name** — a user-assigned `name` on a binding (case-insensitive) → tier
2. **neutral name** — `local` | `small` | `medium` | `large` → tier
3. **identity alias** — `haiku`/`sonnet`/`opus`/`fable`/`*_1m` → their fixed wire id (never a tier)
4. otherwise — a raw concrete id or the `auto` sentinel (passthrough, unchanged)

A resolved TIER expands to `bindings[slot].id`; an identity alias expands to its
fixed wire id. The concrete id is what reaches the provider SDK **and** what
`providerForModel` routes on — so a tier rebound to a non-Anthropic id (e.g.
`small → gpt-4o-mini`) routes to `openai-compatible`, while an identity alias
always routes to its own model's provider.

## How it works

**Routing (Stage 1).** `providerForModel()` resolves the slot alias to its full
binding **before** pattern matching, honoring an explicit per-slot `provider`,
then id inference, then a per-slot `baseUrl` (a custom endpoint on a
non-Anthropic id infers `openai-compatible`). This single resolution-before-routing step
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
- `docs/env-registry.md` — `AFK_MODEL_{LOCAL,SMALL,MEDIUM,LARGE}{,_BASE_URL,_API_KEY}`.
