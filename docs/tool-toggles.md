# Operator tool visibility

## In the REPL: `/config` → Tools

Run `/config` and choose **Tools** to get a checklist: ◉ on, ◯ off. Space toggles a row, Enter saves, Esc cancels. The rows are the groups below, every non-core built-in tool, one `mcp__<server>__*` row per configured MCP server, and any other entry already present in a config file, so nothing you wrote by hand is hidden or dropped on save.

The menu writes only your user config (the user-tier `afk.config.json` under `$AFK_HOME`). A tool disabled by a project or legacy config file shows as `← off in <file>` and cannot be turned on from the menu; the save tells you which file to edit. Changes apply to the next session (restart the REPL). Telegram and other non-TTY surfaces show the current list read-only in `/config`.

## By hand

Edit `afk.config.json`:

```json
{
  "tools": {
    "disabled": ["browser", "image", "clipboard", "peer", "schedules", "bash", "mcp__github__*", "mcp__slack__send"]
  }
}
```

Settings are snapshotted when a provider is constructed. Start a new session after editing. Every provider, including forked children, enforces the settings. Disabled tools are omitted from advertised schemas and rejected if called, even when an MCP refresh or custom tool registration adds them to an allowlist.

All config tiers are additive: project `afk.config.json`, user config (`$AFK_HOME/config/afk.config.json`), and legacy config (`~/.afk.config.json`) are unioned. A project cannot remove a user deny. Invalid JSON in one tier does not erase another tier's entries. Invalid values and unknown names produce a one-time stderr warning; valid string entries beside invalid array items still apply.

Entries can be exact built-in or registered custom/plugin tool names, or these fixed groups:

| Group | Tools |
| --- | --- |
| `browser` | `browser_open`, `browser_observe`, `browser_act`, `browser_screenshot`, `browser_close` |
| `image` | `image_generate`, `image_edit` |
| `clipboard` | `clipboard_read`, `clipboard_write` |
| `peer` | `list_sessions`, `send_to_session` |
| `schedules` | `create_schedule`, `update_schedule`, `list_schedules`, `get_schedule_history`, `cancel_schedule` |

The image group covers image generation/editing, not `view_image` or `extract_document`.

MCP entries accept exact wire names (`mcp__<server>__<tool>`) or a server wildcard (`mcp__<server>__*`). They are accepted before servers connect and match tools discovered later. General globbing is not supported.

Locked core entries are ignored with a warning: `agent`, `skill`, `compose`, `exit_plan_mode`, `get_runtime_state`, `read_file`, `write_file`, `edit_file`, `grep`, `glob`, `list_directory`. This does not override existing read-only fork allowlists.

The agent's `config_set` cannot change this setting, and neither can `/config set` or `afk config set`. Humans use the `/config` → Tools checklist or edit the JSON file.

This is prompt/token hygiene, **not a security boundary while `bash` is enabled**. Shell commands can access equivalent capabilities directly. File writing and other enabled tools can also bypass visibility settings. Use independent sandboxing and permission controls for security.
