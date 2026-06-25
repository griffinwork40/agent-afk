---
name: automate
description: "Set up a scheduled headless afk run that pushes a summary to Telegram. Use when the user wants to automate a recurring task via the afk daemon scheduler (cron) with push-notified results."
disable-model-invocation: true
---

Set up a recurring headless task using afk's **native** scheduler. Do NOT hand-roll launchd plists or shell scripts — afk has first-class scheduling: the `create_schedule` tool writes `~/.afk/config/schedules.json` entries that `afk daemon` runs on cron.

Dispatch two sub-agents in parallel:
1. **Scout** — call `list_schedules` and inspect `~/.afk/config/schedules.json` for existing or overlapping jobs, run `afk service status` to see whether the daemon is installed as a launchd service and running, confirm Telegram is configured (`TELEGRAM_BOT_TOKEN` + `AFK_TELEGRAM_ALLOWED_CHAT_IDS`), and scan the target project folder for conventions. Report conflicts, daemon/service state, and any missing prerequisite.
2. **Prompt designer** — draft the recurring task's `command` string: a self-contained prompt (or `/skill --flags` invocation) sent verbatim into a freshly spawned session each run. The daemon session starts cold, so encode all input context explicitly, and require the run to END by calling the `send_telegram` tool with a concise, push-ready summary.

When both return:
- If Telegram is unconfigured, stop and tell the user to run `/telegram-setup` first — `send_telegram` fails closed without `TELEGRAM_BOT_TOKEN` and `AFK_TELEGRAM_ALLOWED_CHAT_IDS`.
- Create the job with the `create_schedule` tool: `name`, the designed `command`, the requested 5-field `cron`, `trigger: "cron"`, and `notifyOn: "failure"` as a crash safety-net (the per-run summary comes from the agent's own `send_telegram` call, not from `notifyOn`).
- Schedules only fire while the daemon is running, so make it survive reboot/crash: if `afk service status` shows the daemon isn't installed, run `afk service install daemon` (launchd `RunAtLoad` + `KeepAlive` on macOS).

Dispatch a **verification** sub-agent to confirm the job registered (`list_schedules`), the daemon is running (`afk service status`), and — by running the task's `command` once as a one-shot (`afk chat "<command>"`) — that the Telegram summary actually arrives. On failure, diagnose (Telegram config, daemon not running, cron syntax, prompt shape) and fix before exiting. Report the schedule id, cron, `notifyOn`, daemon/service status, and the next scheduled run.
