# Web Command Layer — Architecture

> Stage 0 of the Web↔CLI Parity Command Layer (PATH_B: surface-agnostic command layer, staged).

## Overview

The web surface (`afk web`) exposes slash commands through a structured HTTP API rather than
running the CLI's interactive loop. This document describes the architecture, data flow, and
intentional limitations of Stage 0.

## Request Flow

```
Browser composer
  └─ POST /api/sessions/:id/commands   { input: "/help" }
       └─ routes.commands.ts
            ├─ validateId
            ├─ requireOwned
            ├─ isBusy? → 409
            ├─ reserveTurn()          ← synchronous
            └─ try {
                 ensureSlashRegistry()
                 waitForSessionReady() ← polls owner.getSession() up to 2s
                 registry.parse(input)
                 registry.lookup(name)
                 isGated(name)?        ← command-gate.ts (single source of truth)
                 BufferingWriter       ← captures all handler output
                 createWebSlashContext()
                 cmd.handler(ctx, args)
                 writer.toOutputBlock()
                 normalizeSlashResult()
                 → 200 { blocks, control }
               } finally { releaseTurn() }
```

## Key Modules

| Module | Role |
|---|---|
| `src/web-server/slash-registry.ts` | Shared `ensureSlashRegistry()` memo — one registry init for both `routes.ts` and `slash-dispatch.ts` |
| `src/web-server/command-gate.ts` | Canonical gate list; `isGated(name)` + `gateReason(name)`; **single source of truth** for Stage 0 |
| `src/web-server/writer.buffer.ts` | `BufferingWriter` — captures handler output; `toOutputBlock()` strips VT control chars |
| `src/web-server/session-owner.slash.ts` | Per-session `SessionStats` side-car; `buildSessionRef()` |
| `src/web-server/slash-context.web.ts` | `createWebSlashContext()` — `SlashContext` adapter for web |
| `src/web-server/routes.commands.ts` | `POST /api/sessions/:id/commands` handler |
| `src/web-server/shared/command-wire.ts` | Server-side wire types (`CommandOutputBlock`, `CommandResponse`, `CommandControl`) |

## Wire Types

### Request

```json
POST /api/sessions/:id/commands
{ "input": "/help" }
```

### Response (200)

```json
{
  "blocks": [
    {
      "ansi": "\u001b[1mAvailable commands\u001b[0m\n...",
      "text": "Available commands\n..."
    }
  ],
  "control": { "kind": "continue" }
}
```

### Control variants

| `control.kind` | Dashboard action |
|---|---|
| `continue` | no-op |
| `exit` | show inline notice (no effect on web in Stage 0) |
| `forward` | re-POST original input to `/prompt` |
| `rerun` | re-POST `control.input` to `/commands` |
| `submit` | submit `control.message` as a new prompt |
| `prefill` | set composer text to `control.message` without submitting |

## Gate List (Stage 0)

Commands in `command-gate.ts` return HTTP 409 `command_gated` with a human-readable reason.
The gate covers all commands that require terminal machinery, session-lifecycle operations, or
capabilities absent on the web surface (compositor, ledger, TTY, etc.).

> **Invariant:** Stage 1 replaces the flat gate list with `requires: SurfaceCapability[]`
> per command, enabling fine-grained capability negotiation.

## Command Output — Client-Local Items

`command-output` transcript items are **client-local**: they are never persisted to the
session journal or SSE stream. Each item lives only in the React component tree for the
duration of the browser session. On page reload, only server-persisted transcript items
(tool cards, assistant messages, etc.) reappear.

This is intentional for Stage 0: command output is ephemeral diagnostic/utility output.
Stage 2 will introduce structured output blocks (keyValue, table, list, diff) that may be
selectively persisted via the journal.

## Session Stats

`session-owner.slash.ts` maintains a process-global `Map<sessionId, SessionStats>` as a
side-car to `session-owner.ts`. Stats are initialized when a session is created and updated
after each turn drains in `session-owner.autosave.ts`. This allows slash handlers that read
`ctx.stats` (e.g. `/cost`, `/tokens`) to return accurate data without coupling the route to
the autosave internals.

## POST /prompt — 422 responses for slash commands

`POST /api/sessions/:id/prompt` returns **422** when the submitted text is a slash command
that cannot be handled as a skill prompt:

| `error` code | Condition | Recommended action |
|---|---|---|
| `native_command` | The command is a native CLI command — use `POST /api/sessions/:id/commands` instead | Redirect to `/commands` endpoint |
| `repl_only_command` | The command requires REPL terminal machinery not available on the web surface | Show error to user |
| `unknown_command` | The slash token is not recognised by the registry | Show "unknown command" error |

The dashboard composer handles these 422s by inspecting the `error` field and routing
native commands to the `/commands` endpoint automatically (via `dispatchSlashForWeb`).

## Known Limitations (Stage 0)

- **No cancel route**: background job cancel requires a cross-process signal channel.
  The cancel button in the bg-jobs view is disabled with a tooltip directing the operator to
  use `/bgsub:cancel <id>` from the owning session.
- **Command output is client-local**: not persisted; lost on reload.
- **Session readiness poll**: `waitForSessionReady` polls `owner.getSession(id)` every 50ms
  up to 2s. If the session is not ready, it returns 503 `session_not_ready`. Stage 1 will
  replace this with a readiness event from `SessionOwner`.
- **Dynamic imports on hot path**: `ensureSlashRegistry` and registry imports are dynamic to
  keep the `cli/slash` tree off the server's startup path. These will be hoisted to
  module-top once the route is opt-in (server.ts already routes lazily).
