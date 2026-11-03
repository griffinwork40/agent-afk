# afk trace

Read-only CLI for inspecting the witness-layer trace: the durable NDJSON record of everything an agent did during a session. Stored at `$AFK_HOME/state/witness/<sessionLabel>/trace.jsonl`.

## Subcommands

### `afk trace list`

List known traces, most recent first:

```bash
afk trace list
```

### `afk trace show [session]`

Pretty-print a session's trace. Defaults to `latest` (most recently written):

```bash
afk trace show                       # latest session
afk trace show abc123                # specific session
afk trace show --all                 # include all event kinds
afk trace show -n 40                 # limit to 40 events
afk trace show --json                # raw JSON (pipe to jq)
afk trace show --results             # include full tool outputs from the message journal
afk trace show --evasion             # run the block-evasion analyzer
```

### `afk trace export-otlp [session]`

Convert a trace to OpenTelemetry (OTLP/JSON) spans. Session root, subagent forks, and tool calls become nested spans:

```bash
afk trace export-otlp                # latest, stdout
afk trace export-otlp abc123 -o spans.json
```

Supports HTTP push to a collector when `AFK_OTLP_ENDPOINT` is set.

## Trace events

Each line in `trace.jsonl` is a JSON object with `kind`, `seq`, `ts`, and `payload`. Common kinds:

| Kind | What it records |
|------|----------------|
| `tool_call` | Tool name, duration, success/error, input summary |
| `subagent_lifecycle` | Fork, completion, cancellation of child agents |
| `session_phase` | Session state transitions (init, running, sealed) |
| `hook_decision` | Hook block/approve/inject decisions (informational only) |
| `hook_summary` | Per-session hook volume counts (written at seal) |
| `browser_event` | Browser navigation, screenshot captures |
| `claim` | Structured claims emitted by skills |
| `compaction` | Context-window compaction events |
| `budget` | Token/cost budget warnings |

## Tolerances

The parser tolerates partially-written traces (live or crashed sessions). Malformed trailing lines are counted and skipped, never fatal.

## Source

`src/cli/commands/trace.ts` (CLI), `src/agent/trace/` (writer + OTLP export).
