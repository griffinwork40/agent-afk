You are installing an AFK background process (telegram bot or daemon) as an OS-supervised service so it auto-starts on login and relaunches on crash. The backend is chosen per platform: macOS uses a launchd LaunchAgent (`~/Library/LaunchAgents/`), Linux uses a systemd `--user` unit (`~/.config/systemd/user/`). The user-facing surface is the `afk service` command group; you orchestrate its lifecycle and refuse to install in states that would produce a crash loop (launchd `KeepAlive` / systemd `Restart=always`).

## Hard rules

1. **macOS or Linux only.** Before doing anything, run `uname` and confirm output is `Darwin` (macOS → launchd) or `Linux` (→ systemd `--user`). On anything else (e.g. Windows), tell the user `afk service` supports only macOS and Linux and stop. Do not attempt a workaround.
2. **Use only the sanctioned subcommands.** Never invoke `launchctl`/`systemctl` directly, never write to `~/Library/LaunchAgents/` or `~/.config/systemd/user/` yourself, never read `~/.afk/config/afk.env`. The sanctioned surface:
   - `afk service install <telegram|daemon> [--no-watch] [--dry-run]`
   - `afk service uninstall <name>`
   - `afk service status [name]`
   - `afk service restart <name>`
   - `afk service list`
   - `afk telegram check-token` — JSON `{set, valid, username?, botId?, reason?}` (only used during pre-flight for the telegram service)
3. **Never install the telegram service if the token isn't valid.** `KeepAlive=true` + invalid token = infinite crash loop with the log file growing unbounded. If `check-token` doesn't return `valid: true`, route the user to `/telegram-setup` and stop.
4. **`afk service status` and `afk service list` emit human-formatted text, not JSON.** Parse by looking for substrings: `Not installed`, `Running  (PID <n>)`, `Installed but not running`. Do not invent fields.

## The flow

### Step 1 — Identify the target service

If the user named a service in the invocation args (`telegram` or `daemon`), use that. Otherwise ask:

> Which AFK service do you want to install as always-on?
>
> - `telegram` — the bot that lets you drive AFK from your phone
> - `daemon` — the cron-based headless runner for scheduled tasks
>
> (Reply `telegram` or `daemon`.)

Wait for their answer. Anything outside the two values: re-ask once, then bail with a clear message if still ambiguous.

### Step 2 — Platform check

Run `uname`. If the trimmed stdout is `Darwin` (macOS → launchd) or `Linux` (→ systemd `--user`), continue. Otherwise tell the user:

> `afk service` supports only macOS (launchd) and Linux (systemd `--user`). Detected platform: `<output>`.

Then stop.

On **Linux**, also note once (systemd `--user` services stop at logout without lingering):

> Heads up — on Linux, a systemd `--user` service only survives logout/reboot if user lingering is enabled. After install I'll remind you to run `loginctl enable-linger` (the install output includes the exact command).

### Step 3 — Check current install state

Run `afk service status <name>`. Three branches based on the human-formatted output:

- Contains `Not installed` → not installed yet. Continue to Step 4.
- Contains `Running  (PID <n>)` → already installed and running. Tell the user:

  > ✓ `<name>` is already installed and running (PID <n>). Manage it with:
  > - `afk service status <name>` — running state + log path
  > - `afk service restart <name>` — bounce the process
  > - `afk service uninstall <name>` — stop + remove plist
  > - Log file is shown in the status output above.

  Then stop. Do not reinstall.

- Contains `Installed but not running` → installed but the process exited. Ask:

  > `<name>` is installed but not running (last exit may indicate why — see status output above). Want to restart it (`afk service restart <name>`) or uninstall and reinstall fresh?

  Honor the user's choice. If they pick restart, run `afk service restart <name>` and skip to Step 6. If reinstall, run `afk service uninstall <name>` and continue to Step 4.

### Step 4 — Pre-flight prerequisites

Per service:

**For `telegram`:** run `afk telegram check-token` and parse the JSON.

- `{set: true, valid: true, username: "FooBot"}` → proceed.
- `{set: false}` or `{valid: false}` → tell the user:

  > Before I install the telegram bot as a LaunchAgent, the bot token needs to be set and valid — otherwise `KeepAlive` will crash-loop the service. Run `/telegram-setup` first to configure the token, then come back and run `/service-setup telegram`.

  Then stop. Do not attempt the install.

**For `daemon`:** no automated pre-flight is run here (the daemon reads schedules from `~/.afk/config/schedules.json` at boot and gracefully handles an empty list). Just warn the user once:

> Note: the daemon reads schedules from `~/.afk/config/schedules.json`. If you haven't created any with `afk schedule add` yet, the service will run idle until you do — that's fine.

Then continue.

### Step 5 — Install

Run `afk service install <name>`. Read the human-formatted output:

- `✓ Installed <label>` → success (label is `com.afk.<name>` on launchd, `afk-<name>.service` on systemd). Note the `Auto-restart on rebuild` line (telegram dev-tree only) and any post-install notes (on Linux this includes the `loginctl enable-linger` command — surface it to the user). Continue to Step 6.
- `⚠ ... already installed` → race with Step 3 (or the user installed manually between steps). Re-run status; do not force-reinstall.
- `✗ Install failed: <reason>` → surface the exact reason verbatim. Common causes worth naming when you see them:
  - "Telegram entrypoint resolved to a `.ts` file" → user is running from source without building. Tell them to run `pnpm build` first; the supervisor runs the compiled `.mjs` entrypoint directly (no tsx/loader).
  - "Already bootstrapped" (launchd) / "unit already exists" (systemd) → orphan config from a prior install. Run `afk service uninstall <name>` and retry once.

  Then stop. Don't loop indefinitely.

### Step 6 — Verify

Run `afk service status <name>` again. If the output shows `Running  (PID <n>)`:

> ✓ `<name>` is now running as an OS service (PID <n>). It will auto-start on login and relaunch if it crashes.

If it still shows `Installed but not running` after install:

> Plist is installed but the process didn't start. Check the log:
> ```
> tail -50 ~/.afk/logs/service-<name>.log
> ```
> If you can share the tail, I can help diagnose. Otherwise try `afk service restart <name>` once.

Don't loop — let the user inspect and come back.

### Step 7 — Hand off the cheatsheet

End with the management commands the user will need later:

> Management:
> - `afk service status <name>` — check running state, PID, last exit
> - `afk service restart <name>` — bounce after config changes
> - `afk service uninstall <name>` — stop and remove the service config
> - Logs: `~/.afk/logs/service-<name>.log`
> - **Linux only:** for always-on across logout/reboot, run `loginctl enable-linger` once.
>
> Note: `afk telegram status` reports "stopped" when the OS supervisor (launchd/systemd) runs the bot — that's expected, because the PID file isn't written in that mode. Use `afk service status telegram` to introspect the supervised instance.

Then stop.

## Tone

Terse and operational. One line per step confirmation. Use `✓` / `✗` markers. Code-fence any command the user should run. Don't narrate the launchd/systemd internals unless asked — the user wants the service running, not a tutorial.

## Surface awareness

If the user is reaching you over Telegram (mentioned phone, or session metadata indicates so), note once at Step 1:

> Heads up — `afk service` installs a per-user OS service (launchd LaunchAgent on macOS, systemd `--user` unit on Linux) on the machine where AFK is installed. You'll need to be on that machine (SSH or local terminal) for the commands I'm about to run. I can still walk through them, but the install happens there.
