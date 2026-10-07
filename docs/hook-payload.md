# Shell Hook Stdin Payload

Shell hooks registered in `afk.config.json` (or contributed by plugins) receive
a JSON object on stdin every time a matching event fires. This document describes
every field in that object, which events carry which fields, and the contract for
`transcript_path` introduced in #2372.

**Implementation:** `src/agent/hooks/command-executor.ts` → `buildStdinPayload()`

---

## Per-surface event support

Not every event fires on every AFK surface. The table below is the authoritative
reference (#2817):

| Event | REPL | Telegram | `afk chat` | Daemon |
|---|---|---|---|---|
| `SessionStart` | ✓ | ✓ | ✓ | ✓ |
| `SessionEnd` | ✓ | ✓ | ✓ | ✓ |
| `SubagentStart` | ✓ | ✓ | ✓ | ✓ |
| `SubagentStop` | ✓ | ✓ | ✓ | ✓ |
| `PreToolUse` | ✓ | ✓ | ✓ | ✓ |
| `PostToolUse` | ✓ | ✓ | ✓ | ✓ |
| `PostToolUseFailure` | ✓ | ✓ | ✓ | ✓ |
| `PreCompact` | ✓ | ✓ | – | – |
| `Stop` | ✓ | ✓ | ✓¹ | ✓² |
| `UserPromptSubmit` | ✓ | ✓ | – | – |

¹ `Stop` fires on `afk chat`, but `injectContext` is dropped — one-shot surfaces
  have no next turn to prepend it to.

² `Stop` fires in the daemon, but `injectContext` is dropped for the same reason.

**`UserPromptSubmit` on `afk chat` / daemon**: these surfaces are headless or
one-shot (no interactive human on the other end per turn), so there is no natural
"prompt submission" event — the content is a scheduled task body or a CLI argument.
Wiring `UserPromptSubmit` there would require surfacing a block as an error exit,
with no recourse for the operator. Kept scoped to human-facing interactive surfaces
for now; file a feature request if your use case needs it.

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

### `Stop`

| Field | Type | Description |
|---|---|---|
| `stop_hook_active` | `true \| false` | `true` when a previous Stop hook in this turn already triggered a same-turn continuation (i.e. `continuation > 0`); `false` on the first Stop dispatch of a turn. Use this to distinguish a re-entry Stop from the original one. |
| `continuation` | `number` | 0-based index of this Stop dispatch within the current turn. `0` on the first dispatch, `1` on the first continuation, etc. Always present. |

#### Blocking Stop hooks and same-turn continuation (issue #2714)

When a `Stop` hook exits with `decision: "block"`, AFK appends the hook's
`reason` as a user message and re-enters the model loop **in the same turn**
(CC-compatible behaviour). This is called a *continuation*. The model responds,
then Stop is dispatched again — with `continuation` incremented and
`stopHookActive: true`.

Continuations are capped by `AFK_STOP_HOOK_MAX_CONTINUATIONS` (default `2`).
The cap is global across all hooks for that turn — two blocking hooks together
consume from the same counter. When the cap is reached the block is treated as
non-blocking and the turn ends normally. Two trace phase events mark this:

| Phase | When |
|---|---|
| `stop_hook_continuation` | A Stop hook blocked; the continuation round begins. Metadata: `{ continuation: N, reasonHead: "…" }`. |
| `stop_hook_cap_reached` | The cap was hit and the turn ended normally. Metadata: `{ cap: N }`. |

Setting `AFK_STOP_HOOK_MAX_CONTINUATIONS=0` disables continuation entirely:
blocks are logged only, matching pre-#2714 behaviour.

**Why the session-layer Stop cannot double-fire:** the provider-side seam runs
*before* `turn.completed` is emitted. The session-layer Stop dispatch in
`turn-stream-runner.stop.ts` fires on the `done` event, which IS the surface
boundary. Moving the seam to the provider layer ensures the surface never sees
the completed turn until after all continuations have been resolved.

### `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`

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

## Plugin-hook environment variables  (#2373)

Hook subprocesses for **user-scope installed plugins** receive three additional
categories of env vars beyond the standard AFK set.

### `CLAUDE_PLUGIN_OPTION_<KEY>`

For every key declared in the plugin's `userConfig` block in `plugin.json`:

```json
{
  "userConfig": {
    "provider": { "type": "string", "default": "anthropic", "description": "LLM provider" },
    "apiKey":   { "type": "string", "sensitive": true }
  }
}
```

AFK exports `CLAUDE_PLUGIN_OPTION_PROVIDER` (uppercased; non-`[A-Z0-9_]` chars
replaced with `_`, matching Claude Code).  The value resolution order is:

1. The value the user stored via `afk plugin config <name> provider <value>`.
2. The `default` from the manifest when no stored value exists.
3. Nothing — the var is not set when neither applies.

**Sensitive fields (`"sensitive": true`) are NEVER exported**, even if a value
is stored.  They must flow through the explicit `pluginHookEnv` allowlist
instead (see issue #2459).

**Stale keys** (removed from the manifest after an update) are silently skipped
at export time; they remain in the index until explicitly unset.

**Collision detection**: if two manifest keys normalise to the same env-var name
(e.g. `provider` and `PROVIDER`) AFK refuses to load the manifest and warns
instead of letting one silently win.

#### Managing options

```sh
afk plugin config <name>                     # list all declared options
afk plugin config <name> provider            # show one option (and its default)
afk plugin config <name> provider openai     # set a value
afk plugin config <name> provider --unset    # remove the stored value
```

Values are stored in `~/.afk/plugins/.index.json` under the plugin's entry.
Reinstalling or updating a plugin preserves stored option values.

**Scope**: user-scope installs only.  Project-scope (`<cwd>/.afk/plugins`) and
bundled plugins have no index entry and receive no `CLAUDE_PLUGIN_OPTION_*` vars.
`CLAUDE_PLUGIN_DATA` (below) is always exported for plugin-sourced hooks.

### `CLAUDE_PLUGIN_DATA`

`CLAUDE_PLUGIN_DATA` is the absolute path to a plugin-private writable directory:

```
~/.afk/plugins/data/<sanitised-plugin-key>/
```

The directory is created lazily (mode `0700`) the first time a hook fires.
Plugin hook scripts can use it to store logs, caches, or any persistent state
without hard-coding paths.

Index keys like `marketplace:my-plugin` are sanitised (`:` → `__`) to produce
a filesystem-safe directory name.

The path is resolved via `getPluginDataDir()` in `src/paths.ts`.  Never
hand-join paths under `~/.afk` — call that helper.

**`CLAUDE_CONFIG_DIR` is NOT exported** — it would point plugin scripts at
Claude Code's own config directory, which is outside AFK's scope.

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
| `hookSpecificOutput.updatedInput` | **`PreToolUse` only.** A plain JSON object that replaces the tool's input before execution. The rewritten input still goes through the same permission gates and tool-schema validation. Multiple hooks chain in registration order; the last non-blocking hook's value wins. Arrays, primitives, and `null` are ignored. |

Exit code semantics:

| Exit code | Meaning |
|---|---|
| `0` | Success; parse stdout for optional decision fields. |
| `2` | Block; stderr (first 500 chars) becomes the `reason`. |
| other | Non-blocking error; a `console.warn` is emitted and the hook is treated as a no-op. |

---

## Built-in Stop hooks

The harness registers several built-in `Stop` handlers in
`src/agent/default-hook-registry.ts`. These run as programmatic hook handlers
(not shell commands) and inject context into the next turn rather than blocking.

### `AFK_UNPROVEN_DIAGNOSIS_GATE` — unproven-diagnosis gate (#2987)

**Opt-in.** Set `AFK_UNPROVEN_DIAGNOSIS_GATE=1` to enable.

When enabled, this Stop hook fires when the completed turn:

1. Contains a cause-unknown phrase in the assistant text — e.g. *"root cause
   is unknown"*, *"the cause is something else in …"*, *"likely upstream"*, or
   *"I couldn't determine the root cause"*.
2. Has **no** successful instrumentation tool calls this turn — none of
   `bash`, `grep`, `read_file`, `glob`, `list_directory`, `web_scrape`,
   or `web_request`.

When both conditions hold, the hook injects the **elimination ladder** into the
next turn, asking the agent to:

- Hash-check installed packages against published manifests.
- Bypass the wrapper and rerun the failing path.
- Reproduce in a clean environment.
- Review upstream config flags.
- Instrument the suspected path with a call counter or log.

The agent must cite the step that confirms or contradicts the external
hypothesis before closing.

**Does not fire when:**
- The flag is off (default).
- The turn is a subagent turn (`parentSessionId` is set).
- The turn is already a continuation round (`stopHookActive` is true).
- Any instrumentation tool executed successfully this turn.
- The text contains no cause-unknown phrase.

**Design notes:**
- Uses pure regex matching + tool-name list. Deterministic, no network call.
  A Jev-based LLM check is a possible future upgrade.
- Injects context (`injectContext`), not a hard block — the agent gets one
  continuation round to run the ladder.
- Fires at most once per turn.
- Source: `src/agent/unproven-diagnosis-detect.ts`.
