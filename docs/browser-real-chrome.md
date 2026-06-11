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
2. The first time the agent drives Chrome, click **Allow** on the prompt.
3. Chrome shows a *"being controlled by automated test software"* banner while a
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
      "args": ["chrome-devtools-mcp@latest", "--autoConnect"]
    }
  }
}
```

Pass `--channel beta|canary|dev` to target a non-stable Chrome channel's
profile.

## Known limitation

`chrome-devtools-mcp`'s `take_screenshot` returns an image, but agent-afk's MCP
bridge currently text-stubs image results, so those screenshots aren't yet
visible to the model. Its `take_snapshot` (a text accessibility tree) is the
primary automation surface and works today. Making MCP-returned screenshots
model-visible (reusing the `browser_screenshot` image plumbing) is a planned
follow-up.
