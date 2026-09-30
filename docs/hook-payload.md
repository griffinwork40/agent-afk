# Shell Hook Stdin Payload

Shell hooks registered in `afk.config.json` (or contributed by plugins) receive
a JSON object on stdin every time a matching event fires. This document describes
every field in that object, which events carry which fields, and the contract for
`transcript_path` introduced in #2372.

**Implementation:** `src/agent/hooks/command-executor.ts` → `buildStdinPayload()`

---

## Always-present fields

| Field | Type | Description |
|---|---|---|
| `session_id` | `string \| null` | The AFK session identifier. `null` when the session has no ID (rare in practice). |
| `hook_event_name` | `string` | The event that triggered the hook: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PreCompact`, `SessionStart`, `SessionEnd`, etc. |
| `cwd` | `string` | The agent's working directory at hook-dispatch time. |
| `transcript_path` | `string \| null` | Absolute path to the session's autosaved markdown transcript. See [below](#transcript_path). |

---

## Event-specific fields

### `UserPromptSubmit`

| Field | Type | Description |
|---|---|---|
| `prompt` | `string` | The raw text the user submitted before the model processes it. |

### `PreToolUse`

| Field | Type | Description |
|---|---|---|
| `tool_name` | `string` | Name of the tool about to be called (e.g. `bash`, `edit_file`). |
| `tool_input` | `object` | The full tool-input JSON the model passed. |

### `PostToolUse`

| Field | Type | Description |
|---|---|---|
| `tool_name` | `string` | Name of the tool that completed. |
| `tool_input` | `object` | The tool-input JSON (same as `PreToolUse` saw). |
| `tool_output` | `string \| undefined` | Serialized tool output; omitted when the tool returned no output. |

### `PostToolUseFailure`

| Field | Type | Description |
|---|---|---|
| `tool_name` | `string` | Name of the tool that threw. |
| `tool_input` | `object` | The tool-input JSON. |
| `error` | `string` | The error message from the thrown exception. |

### `PreCompact`

| Field | Type | Description |
|---|---|---|
| `trigger` | `string \| null` | What caused the compaction: `"manual"` (`/compact` slash command) or `"auto"` (context-limit auto-compact). `null` when the trigger was not recorded. |

### `Stop`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`

No event-specific fields beyond the always-present set.

---

## `transcript_path`

**Introduced in:** #2372

### What it is

`transcript_path` is the absolute path to the current session's autosaved
markdown transcript file under `~/.afk/state/transcripts/<isoStamp>.md`. The
file is written incrementally as turns complete, so it always contains the turns
that preceded the hook event.

### Format

The file is plain markdown:

```markdown
# Session — 2026-09-30T11:00:00.000Z

- model: claude-opus-4-5

---

_2026-09-30T11:00:05.123Z · model: claude-opus-4-5_

## User

What is the weather today?

## Assistant

I don't have access to real-time weather data…

---

_2026-09-30T11:02:10.456Z · model: claude-opus-4-5_

## User

…
```

Turns are separated by `---` dividers. Each turn block opens with a timestamp
and model line, a `## User` heading, and a `## Assistant` heading. A `/clear`
rotation appends `_cleared_` to the old file and starts a new one; after
rotation, `transcript_path` points to the new file.

### When it is `null`

`transcript_path` is `null` (never `undefined` — the key is always present) in
these cases:

| Surface | Reason |
|---|---|
| `afk chat` (one-shot) | No REPL transcript is initialised for single-turn runs. |
| `afk daemon` | Daemon ticks run headlessly with no transcript. |
| Telegram | The Telegram session manager does not initialise a file-backed transcript. |
| Web / SDK embedding | `AgentSession` callers that do not wire a transcript getter. |
| REPL — before the first turn | The transcript is initialised after `bootstrapSession()` returns; the very first `UserPromptSubmit` hook fires before it is set. |

### Hook script usage

```sh
#!/bin/sh
# Example: reject prompts that ask to delete prod data.
payload=$(cat)
transcript=$(printf '%s' "$payload" | jq -r '.transcript_path // empty')

if [ -n "$transcript" ]; then
  # Check whether the conversation mentioned production systems.
  if grep -qi "production\|prod-db" "$transcript"; then
    echo '{"decision":"block","reason":"conversation mentions prod — manual review required"}' >&2
    exit 2
  fi
fi
```

The key is always present, so shell scripts can use `jq -r '.transcript_path // empty'`
to obtain an empty string when the path is null, and skip the file read.

### Follow-up work

A Claude-Code-compatible JSONL export (one JSON object per turn) was deliberately
excluded from this PR to keep the change minimal. See issue #2372 for the
follow-up tracking item.

---

## Hook stdout — response fields

A hook command may write a JSON object to stdout. Recognised fields:

| Field | Effect |
|---|---|
| `decision: "block"` | Block the operation. `reason` is shown to the user. |
| `decision: "approve"` | Explicitly approve (skips remaining handlers in the chain). |
| `continue: false` | Alias for `decision: "block"`. |
| `reason: "…"` | Human-readable explanation emitted when blocking. |
| `hookSpecificOutput.additionalContext` | For `Stop` hooks: a string prepended to the next turn's prompt. |

Exit code semantics:

| Exit code | Meaning |
|---|---|
| `0` | Success; parse stdout for optional decision fields. |
| `2` | Block; stderr (first 500 chars) becomes the `reason`. |
| other | Non-blocking error; a `console.warn` is emitted and the hook is treated as a no-op. |
