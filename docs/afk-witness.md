# afk witness

Query-oriented CLI for searching and filtering witness-layer traces across sessions. Wraps the same logic as the agent-side `read_witness` and `search_witness` tools.

## Subcommands

### `afk witness read [session]`

Read and filter events from a single session (default: `latest`):

```bash
afk witness read                                # latest session, all events
afk witness read abc123                         # specific session
afk witness read -k tool_call,hook_decision     # filter by event kind
afk witness read -t bash                        # only bash tool calls
afk witness read -e                             # errors only
afk witness read -n 20                          # limit to 20 events
afk witness read --json                         # raw JSON for piping
```

### `afk witness search <query>`

Text-search across recent sessions' traces:

```bash
afk witness search "rate limit"                 # search default 20 sessions
afk witness search "timeout" -n 50              # scan 50 recent sessions
afk witness search "edit_file" -k tool_call     # narrow to tool calls
afk witness search "hook" --since 2026-10-01    # only sessions after date
afk witness search "error" --json               # raw JSON output
```

## Output format

Default output is human-readable: timestamp, event kind, name/phase, error marker, and duration. Pass `--json` for machine-readable output suitable for piping to `jq`.

## Relationship to `afk trace`

`afk trace` is display-oriented: pretty-print one session's full trace, export to OTLP. `afk witness` is query-oriented: filter events by kind/tool/error, search text across many sessions. Use `afk trace show` to read a session; use `afk witness search` to find which session had a specific event.

## Source

`src/cli/commands/witness.ts` (CLI), `src/agent/tools/handlers/witness.query.ts` (shared query logic).
