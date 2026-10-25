# Web API Changelog

Wire-format additions and semantic changes to the web server HTTP API.
Breaking changes are called out explicitly; additive changes are backwards-compatible
(new fields, new response shapes) and existing clients can ignore them.

## 2026-10-23 — `afk/web-chat-fanin` (PR #4334)

### `GET /api/sessions` — title semantics change (additive)

- `title` is now a **humanized slug** (e.g. `"Web Chat Fanin"` instead of
  `"web-chat-fanin"`). Clients that displayed the raw value need no change;
  clients that parsed the slug format should use the new `titleExplicit` field
  to distinguish explicit `/name` titles from auto-derived ones.
- **New field**: `titleExplicit?: boolean` — `true` when the title was set via
  an explicit `/name` command. When absent or `false`, the title is
  auto-derived from the session label slug and may change across versions.

### `POST /api/sessions/:id/commands` — `CommandResponse.session` (additive)

- **New field**: `session.nameExplicit?: boolean` — mirrors `titleExplicit`
  from the sessions list. `true` when the session name was set explicitly via
  `/name`; absent or `false` when auto-derived.

### `GET /api/models` — structured catalogue (additive)

- **New field**: `groups: ModelGroup[]` — models organised into labelled groups
  (e.g. `"Claude"`, `"OpenAI"`, `"Local"`) for picker UI rendering. Each group
  carries `{ label, models: Model[] }`.
- **New field**: `default?: string` — the model id the server launched with.
  Clients can pre-select this in the model picker without a separate config
  endpoint.
- `POST /api/sessions` and `POST /api/sessions/:id/prompt`: the `model` field
  is now **optional** (was required). When omitted, the server uses its launch
  default. Existing clients that always send `model` are unaffected.
