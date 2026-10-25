# Driving your real Chrome (`afk browser connect`)

agent-afk can drive your **real, logged-in Chrome profile** — the one with your
existing sessions and cookies — so the agent can act on sites you're already
signed into. It does this by wiring Google's
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
into agent-afk's MCP client.

## Quick start

```bash
afk browser connect          # writes the MCP server entry + prints setup steps
```

Then, one time, in Chrome:

1. Open `chrome://inspect/#remote-debugging` and **enable** remote debugging.
2. **macOS 27+:** System Settings > Privacy & Security > Files & Folders > your
   terminal app > enable **Google Chrome** (see [Troubleshooting](#troubleshooting)).
3. The first time the agent drives Chrome, click **Allow** on the prompt.
4. Chrome shows a *"being controlled by automated test software"* banner while a
   session is active. That's expected.

The agent now has `mcp__chrome-devtools__*` tools (`navigate_page`, `click`,
`fill`, `take_snapshot`, `take_screenshot`, …) operating on your real profile.
Run `/mcp` in the REPL to confirm the server connected.

Undo with:

```bash
afk browser disconnect
```

## Why an MCP server instead of a native provider

agent-afk's native `browser_*` tools use Playwright, which **cannot** attach to
your real default profile:

- **Chrome 136+** refuses `--remote-debugging-port` on the default user-data-dir
  (an anti-cookie-theft change), so Playwright's `connectOverCDP` has nothing to
  attach to there.
- **Chrome M144's** sanctioned `--autoConnect` consent flow needs Puppeteer's
  `handleDevToolsAsPage` connection option, which Playwright lacks
  ([microsoft/playwright#40027](https://github.com/microsoft/playwright/issues/40027)).

`chrome-devtools-mcp` vendors Puppeteer and implements the `--autoConnect` flow,
so wiring it in is the supported path. agent-afk's native `browser_*` tools
remain for throwaway/headless automation that doesn't need your real logins.

## Requirements & security

- **Chrome ≥ 144** (the `connect` command warns if it detects an older version).
- The consent flow is **intentionally human-gated** and cannot be bypassed: you
  enable it once at `chrome://inspect`, then approve each session. This is a
  Chrome security boundary, not an agent-afk limitation.
- While connected, the agent can read and act on **anything in your logged-in
  profile** — only connect when you want it acting as you.

## What `connect` writes

It adds (idempotently, preserving any existing servers) a `chrome-devtools`
entry to `~/.afk/config/mcp.json`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@1.11.0", "--autoConnect"]
    }
  }
}
```

The version is **pinned**: `connect` resolves the current release once
(`npm view chrome-devtools-mcp version`, falling back to a known-good version
offline) instead of writing `@latest`, because the server gets full control of
your logged-in browser and an upgrade should be deliberate. Re-run
`afk browser connect` to upgrade. Entries written by older versions of afk
(`@latest`) keep working until you re-run it.

Pass `--channel beta|canary|dev` to target a non-stable Chrome channel's
profile. After writing the entry, `connect` runs a one-shot readiness check
(see Troubleshooting) and, on macOS, opens the page that fixes whatever is
missing; pass `--no-open` to only print the steps.

## Troubleshooting

`chrome-devtools-mcp --autoConnect` reports **"Could not find
DevToolsActivePort"** for two different problems. `afk browser connect` and the
agent (on a failed `mcp__chrome-devtools__*` call) tell them apart by trying to
open that one file, without reading it or anything else in the profile:

- **Not enabled** (file absent): open `chrome://inspect/#remote-debugging`,
  tick "Allow remote debugging for this browser instance", and keep Chrome
  running. The page then shows "Server running at 127.0.0.1:9222".
- **Blocked by macOS 27+** (`EPERM`): macOS denies other apps access to
  Chrome's profile folder, silently, and the server misreports it as missing
  ([ChromeDevTools/chrome-devtools-mcp#3089](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/3089)).
  Fix: System Settings > Privacy & Security > Files & Folders > the terminal app
  that launched afk > enable "Google Chrome". It applies immediately. Full Disk
  Access for that app also works but is much broader.

Notes:

- `curl http://127.0.0.1:9222/json/version` returning **404 is normal** in this
  mode; `--autoConnect` uses the WebSocket path from `DevToolsActivePort`, not
  the HTTP endpoint.
- Under **tmux or screen**, macOS attributes access to the app that started the
  multiplexer *server*, which may be an older copy of your terminal (even one in
  the Trash after an update). If granting your terminal does not help, restart
  the tmux server from the current app.
- `lsof -iTCP:9222 -sTCP:LISTEN` shows Chrome's process as `Google`, so
  grepping lsof output for "chrome" misses it.

## Known limitation

`chrome-devtools-mcp`'s `take_screenshot` returns an image, but agent-afk's MCP
bridge currently text-stubs image results, so those screenshots aren't yet
visible to the model. Its `take_snapshot` (a text accessibility tree) is the
primary automation surface and works today. Making MCP-returned screenshots
model-visible (reusing the `browser_screenshot` image plumbing) is a planned
follow-up.
