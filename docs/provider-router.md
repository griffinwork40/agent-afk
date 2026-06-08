# Per-model provider routing (ProviderRouter)

## What it does

You can pick **any model from any provider you have configured**, and each turn
routes to the right provider automatically — no global `AFK_PROVIDER` needed.

In an interactive session you can switch across provider families mid-conversation:

```
afk                      # starts on the default (e.g. a Claude model → anthropic-direct)
> /model gpt-5.5         # next turn routes to openai-compatible
> /model sonnet          # next turn routes back to anthropic-direct
```

Subagents already routed per-model at dispatch; this brings the same behavior to
the interactive main session.

## How it works

`AgentSession` installs a `ProviderRouter` (`src/agent/providers/router/provider-router.ts`)
as its single `ProviderQuery` whenever no provider is explicitly injected via
`config.provider`. The router:

- Owns one **active inner provider** at a time and pumps its event stream straight
  through to the session.
- On a `/model` switch to a **different provider family**, at the next **turn
  boundary** it tears down the inner, constructs the target inner, swallows that
  inner's `session.init` (the session never sees a re-init), and keeps going.
- Resolves credentials for the target model's **own** family on every swap
  (`resolveCredentialForModel`), so an Anthropic key/OAuth token is never handed
  to the OpenAI provider and vice-versa.

### Why the swap is safe

The swap happens **below** `AgentSession`. The session's cost/token/turn
accumulators and its `SessionStart`/`SessionEnd` hooks are owned by the session,
not the provider, so a model switch does **not** reset budgets or re-fire
lifecycle hooks. (An earlier design that switched via a session-level reset was
rejected for exactly this reason.)

## History across a switch (the one caveat)

Conversation history does **not** round-trip across provider families at full
fidelity: Anthropic `thinking` blocks carry cryptographic signatures with no
OpenAI equivalent, and tool-call ID schemas differ. So when you cross families,
the router carries a **text-only** shadow history forward — the new model sees
prior turns as plain prose, **not** structured tool calls or thinking/reasoning.

- Same-family model switches keep full native fidelity (the live inner is reused).
- Cross-family switches carry text only. This is an intentional, documented
  degradation — deliberately switching models mid-chat is the common case and
  prose history is sufficient for it.

## AFK_PROVIDER is now optional

`AFK_PROVIDER` (and `--provider`) still work and still force a single provider
for the whole session — but they are now an **escape hatch**, not a requirement.
With `AFK_PROVIDER` set, the router resolves every model to that one family and
never swaps (preserving the old, explicit behavior). With it unset (recommended),
routing is per-model.

> Note: a ChatGPT subscription only supports `gpt-5.x` models, so if you route a
> Claude-family model to a ChatGPT-OAuth-backed openai-compatible provider it will
> be rejected — pick a `gpt-5.x` model (or use model slots to bind tiers to it).
> See `docs/model-slots.md` and the OpenAI Responses/OAuth docs.

## Injected providers are unchanged

When a caller injects `config.provider` (e.g. the Telegram bridge or daemon
constructing a configured provider), the session uses it directly and the router
is never installed — behavior is byte-for-byte unchanged for that path.
