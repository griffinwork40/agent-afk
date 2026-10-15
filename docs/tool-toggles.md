# Operator tool visibility

## In the REPL: `/config` → Tools

Run `/config` and choose **Tools** to get a checklist: ◉ on, ◯ off. Space toggles a row, Enter saves, Esc cancels. The rows are the groups below, every non-core built-in tool, one `mcp__<server>__*` row per configured MCP server, and any other entry already present in a config file, so nothing you wrote by hand is hidden or dropped on save.

The menu writes only your user config (the user-tier `afk.config.json` under `$AFK_HOME`). A tool disabled by a project or legacy config file shows as `← off in <file>` and cannot be turned on from the menu; the save tells you which file to edit. Changes apply to the next session (restart the REPL). Telegram and other non-TTY surfaces show the current list read-only in `/config`.

## Per model slot: `tools.disabledBySlot`

`tools.disabled` applies to every session. To run one model slot with a lean tool set while the others keep every tool, list the denies under that slot's name:

```json
{
  "tools": {
    "disabledBySlot": {
      "local": ["browser", "image", "clipboard", "peer", "schedules", "telegram"]
    }
  }
}
```

- Keys are the slot names `local`, `small`, `medium`, `large`. Entries use the same vocabulary and validation as `tools.disabled`: tool names, the fixed groups below, and `mcp__<server>__*`. Locked core tools are ignored with the same warning. Unknown names are warned about and dropped.
- The list applies when the active model resolves to that slot: by slot name (`/model local`), the slot's custom `name`, or a raw id equal to the slot's bound `id`. Fixed aliases such as `sonnet` and `opus`, and raw ids not bound to a slot, are not slots, so no slot list applies to them.
- It adds to `tools.disabled`. It cannot re-enable a globally disabled tool. Tiers are unioned the same way.
- Enforcement is identical to `tools.disabled`: the tools are removed from the advertised schemas and refused if called, on both providers, including consumer-supplied dispatchers.
- `/model` switch: the list follows the new model at the next turn. Switching onto a slot whose list differs rebuilds the provider session, the same way a switch onto a different endpoint does. Prior turns are replayed from the session journal.
- Subagents: a child resolves the list from its own model, not the parent's. A `local` parent dispatching a `large` child gives the child `large`'s list (none, if unset), and the reverse.
- Unlike `tools.disabled`, the file is re-read when each query's dispatcher is built, so an edit is picked up by the next session or `/model` switch rather than requiring a restart.
- Operator-only, like `tools.disabled`: the agent's `config_set`, `/config set` and `afk config set` refuse it. There is no `/config` → Tools checklist row for it yet; edit the JSON.

The text of the base system prompt is not changed by this setting, so it can still mention tools a slot has hidden (for example the peer-messaging guidance). The model is told the tool is disabled if it tries one.

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
