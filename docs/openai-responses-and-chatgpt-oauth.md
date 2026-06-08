# OpenAI Responses API & ChatGPT-subscription OAuth

The `openai-compatible` provider speaks **Chat Completions** by default. This
doc covers the two opt-in paths that route over the **OpenAI Responses API**
instead.

Both are off by default and gated behind explicit env flags. Nothing changes
for existing API-key / Chat Completions users.

## 1. Public Responses API (API key)

Use the documented `POST /responses` surface on `api.openai.com` with a normal
API key. Useful for reasoning models and the richer tool/streaming semantics.

```bash
export OPENAI_API_KEY=sk-...
export AFK_OPENAI_USE_RESPONSES=1     # opt into Responses (else Chat Completions)
afk chat -m gpt-5 "hello"
```

- Auth resolution is unchanged (`OPENAI_API_KEY` → `CODEX_API_KEY` →
  `~/.codex/auth.json` API-key mode).
- Base URL is unchanged (`api.openai.com`, or `AFK_OPENAI_BASE_URL`).

## 2. ChatGPT-subscription OAuth (read-only)

Bill model usage against your **ChatGPT Plus/Pro subscription** instead of API
credits, by reusing the OAuth token that `codex login` writes to
`~/.codex/auth.json` (`auth_mode: "chatgpt"`).

```bash
codex login                            # establishes ~/.codex/auth.json (chatgpt mode)
export AFK_OPENAI_CHATGPT_OAUTH=1      # opt in (off by default)
afk chat -m gpt-5 "hello"
```

When enabled and a ChatGPT OAuth bundle is present, AFK:

- reads the `access_token` + decodes the `chatgpt_account_id` / `exp` from its JWT,
- routes requests over the **Responses API** to the private ChatGPT backend
  (`https://chatgpt.com/backend-api/codex/responses`),
- sends `Authorization: Bearer <access_token>`, `chatgpt-account-id`,
  `OpenAI-Beta: responses=experimental`, and `originator: agent-afk`.

### Important caveats

- **Read-only — AFK never refreshes the token.** ChatGPT OAuth refresh tokens
  are single-use, and the `codex` binary owns refresh; two refreshers racing on
  `~/.codex/auth.json` would invalidate each other. When the access token
  expires, AFK surfaces a diagnostic asking you to re-run `codex`. (Owned
  refresh is deferred — see `docs/specs/provider-agnostic-wire-seam.md`,
  Phase 2E.)
- **Undocumented / ToS-gray.** The ChatGPT backend, the `chatgpt-account-id`
  header, and the OAuth client are reverse-engineered and undocumented; they can
  change or be blocked without notice. This path is opt-in precisely because of
  that. If you only have API access, use path 1.
- An explicit `OPENAI_API_KEY` / `CODEX_API_KEY` / config key always wins over
  the OAuth path, even with the flag on.

## Precedence summary

`config.apiKey` → `OPENAI_API_KEY` → `CODEX_API_KEY` →
`~/.codex/auth.json` (API-key mode) → `~/.codex/auth.json` (ChatGPT OAuth, only
when `AFK_OPENAI_CHATGPT_OAUTH` is set) → none.

The wire is Chat Completions unless (a) `auth.source === 'chatgpt-oauth'` or
(b) `AFK_OPENAI_USE_RESPONSES` is truthy — then it is the Responses API.
