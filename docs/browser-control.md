# Browser Control

`agent-afk` ships five native tools for driving a real Chromium browser from
the agent. They share one Playwright backend per AFK process, with one
isolated `BrowserContext` per `AgentSession`. Subagents inherit the parent's
context by reference — same convention as MCP and trace writers.

The Playwright runtime ships as a regular dependency. The Node-side package
is always installed; the ~300 MB Chromium binaries are not — run
`pnpm exec playwright install chromium` once before using a browser tool.

For the architectural rationale and full type definitions, see
[`docs/browser-control-scope.md`](./browser-control-scope.md).

---

## Quick start

```bash
# 1. Make sure the Playwright dep is installed (skip if you already ran
#    `pnpm install`).
pnpm install

# 2. Install the Chromium binaries Playwright needs.
pnpm exec playwright install chromium

# 3. In the REPL, ask the agent to drive the browser.
afk
> Open github.com and tell me what's on the homepage.
```

The agent will issue `browser_open` → `browser_observe` → … under the hood.
A real Chromium window opens (headed by default in REPL — the operator
watches the work).

---

## The five tools

| Tool                  | Purpose                                             | concurrency-safe |
| --------------------- | --------------------------------------------------- | ---------------- |
| `browser_open`        | Navigate to a URL and observe                       | no               |
| `browser_observe`     | Re-snapshot the current page                        | yes              |
| `browser_act`         | Click / fill / press / select / hover / scroll / wait | no             |
| `browser_screenshot`  | Capture a PNG (viewport or specific element)        | yes              |
| `browser_close`       | Tear down the current session's context             | no               |

All five appear in `afk --help` once the package is built, and in the
agent's tool-use stream alongside `bash`, `read_file`, etc.

### Semantic targets — the default contract

`browser_act` accepts three target shapes:

```jsonc
// PREFERRED — by label + role.
{ "kind": "semantic", "text": "Sign in", "role": "button" }

// For follow-up actions on an element from a recent observation.
{ "kind": "element_id", "element_id": "el_a1b2c3" }

// Escape hatch when the page has no accessible labels.
{ "kind": "selector", "selector": "button.primary[type=submit]" }
```

When a semantic target matches **2+ elements**, the tool returns
`isError: true` with a disambiguation list — three to five candidate
elements with their IDs. The agent retries with `element_id`. Nothing
ever silently picks. (This was Open Question #2 in the scope doc; the
default is locked in.)

---

## Configuration

Environment variables override the defaults. All are optional.

| Variable                       | Default          | What it does                                                |
| ------------------------------ | ---------------- | ----------------------------------------------------------- |
| `AFK_BROWSER_HEADLESS`         | surface-aware\*  | `1`/`0` to force headless / headed                          |
| `AFK_BROWSER_ALLOWED_DOMAINS`  | (empty)          | Comma-separated host globs; non-matching nav blocked        |
| `AFK_BROWSER_BLOCKED_DOMAINS`  | (empty)          | Comma-separated host globs; matching nav blocked            |
| `AFK_BROWSER_DOM_SNAPSHOTS`    | off              | `1` writes a gzipped DOM snapshot per `browser_act`         |
| `AFK_BROWSER_BACKEND`          | `playwright`     | Reserved; only `playwright` supported in Phase 1            |
| `AFK_BROWSER_CONFIG`           | (none)           | Absolute path to a JSON file overriding env-derived config  |
| `AFK_SESSION_ID`               | `default`        | Override the per-session BrowserContext key                 |

\* Headless `on` for daemon / subagent / telegram surfaces;
headed for repl / interactive / cli (so an operator can watch the agent).

### Domain policy

```bash
export AFK_BROWSER_ALLOWED_DOMAINS="github.com,*.atlassian.net"
export AFK_BROWSER_BLOCKED_DOMAINS="*.ads.example.com"
```

Block beats allow. The match is a simple `*` glob against the URL host —
not a regex, not a path matcher. When the allowlist is non-empty, anything
not on the list is refused. When the allowlist is empty (the default), only
the blocklist applies.

A refused navigation surfaces as `isError: true` with a `blocked_by_policy`
reason in the tool result — the agent can adapt.

### JSON config file

For per-project overrides, drop a `browser.json` next to `~/.afk/config/`
(or anywhere and point `AFK_BROWSER_CONFIG` at it):

```json
{
  "headless": true,
  "allowedDomains": ["my-internal-tool.example.com"],
  "blockedDomains": [],
  "domSnapshots": false,
  "backend": "playwright"
}
```

File values override env-derived values. Arrays replace, not append.

---

## Witness layer

Every browser tool emits two kinds of trace records to
`~/.afk/state/witness/<sessionId>/trace.jsonl`:

- **`tool_call`** — the generic dispatcher record (every tool emits these).
- **`browser_event`** — browser-domain semantics: URL transitions, action
  outcomes, screenshot paths, ambiguity verdicts, policy refusals.

Screenshots live as **sidecar files** under
`~/.afk/state/witness/<sessionId>/browser/screenshots/` — never in the
JSONL line. The trace record references the path. The convention matches
the existing pre-compaction sidecar pattern.

### Secret redaction

The witness layer redacts known credential formats before persisting:

- AWS access keys (`AKIA...`)
- OpenAI-style bearer tokens (`sk-...`)
- GitHub PATs (`ghp_...`)
- Slack tokens (`xox[abp]-...`)
- JWTs (`eyJ.eyJ.sig`)
- Form-encoded `password=` values

The PAGE receives the real value. Only the trace file is redacted. This
matches the long-standing AFK principle that the witness layer must not
leak credentials even when the agent fills them.

Selector contents are also never persisted — a CSS attribute selector can
encode a secret. The witness stores the 8-char SHA-256 prefix
(`selectorHash`).

---

## Observation shape

A `BrowserObservation` is what every browser tool returns (stringified
JSON in `ToolResult.content`):

```ts
{
  observationId: "obs_3",          // stable counter per session
  url: "https://example.com/",
  title: "Example Domain",
  textSummary: "<≤4000 char text snapshot>",
  interactive: [                    // ≤80 by default (cap is configurable)
    {
      id: "el_a1b2c3",              // stable within THIS observation
      role: "button",
      label: "Sign in",
      kind: null,
      value: null,
      state: { disabled: false },
      bbox: { x: 380, y: 200, w: 100, h: 40 },
      // selector intentionally absent — the page has no stable testid here
    },
    // …
  ],
  status: {
    httpStatus: 200,
    loadingState: "idle",
    hasDialog: false,
    consoleErrors: 0,
  },
  warnings: [],
  screenshotPath: null,             // populated when caller requested screenshot
  capturedAt: "2026-05-28T07:23:48.123Z",
}
```

The `interactive[]` list is built from the accessibility tree
(`page.accessibility.snapshot()`) — the model-friendly source of truth — and
enriched with bounding boxes from a parallel DOM query. Elements are
sorted in reading order (top-to-bottom, left-to-right).

`InteractiveElement.id` is stable **within one observation**, never across.
Re-observe to get fresh IDs after any DOM mutation.

---

## Architecture (one paragraph)

`src/browser/` holds the provider boundary:
[`types.ts`](../src/browser/types.ts) is the shared I/O,
[`provider.ts`](../src/browser/provider.ts) is the `BrowserProvider`
interface, [`registry.ts`](../src/browser/registry.ts) is the lazy-loaded
singleton, [`playwright/`](../src/browser/playwright/) is the Phase 1
backend. Tool handlers in
[`src/agent/tools/handlers/browser-*.ts`](../src/agent/tools/handlers/)
are thin shims that validate input, call the provider, map the outcome
back to `ToolResult`, and emit `browser_event` to the trace writer. The
dispatcher's existing `PreToolUse` / `PostToolUse` hooks fire automatically
for every browser tool — permissions, abort cascade, witness, and risk
classification all work without per-tool wiring.

This is the LLM-provider pattern (`src/agent/provider.ts`) repurposed for
browsers, NOT inheriting its types. The provider directory under
`src/agent/providers/` is reserved for `ModelProvider` implementations
(Anthropic-direct, OpenAI-compatible). Mixing in a browser interface there
would muddy the type system; `src/browser/` keeps the layer self-contained.

---

## Non-goals (Phase 1)

The scope document spells these out — quick recap:

- No file uploads or downloads.
- One active tab per session (`openTabs` always 0 or 1).
- No browser extensions / userscripts.
- No persistent profiles across AFK sessions.
- No headless OAuth flows (operator types credentials when the browser is
  headed; out of scope when headless).
- No `browser_eval` / arbitrary-JavaScript injection.
- No vision-LLM "see what's on the screen" coupling — screenshot path is
  the hook if we ever want it.

These come back in later phases if and when there's actual demand.

---

## Troubleshooting

**`Cannot find module 'playwright'`** — the dep wasn't installed.
Run `pnpm install` and confirm `node_modules/playwright/` exists. A partial
install (e.g. network failure during a previous run) can leave it missing
even when listed in `package.json`.

**`browserType.launch: Executable doesn't exist`** — Playwright is installed
but the Chromium binaries are not. Run `pnpm exec playwright install chromium`.

**`browser_act blocked: not in AFK_BROWSER_ALLOWED_DOMAINS`** — the agent
tried to navigate somewhere outside your allowlist. Adjust
`AFK_BROWSER_ALLOWED_DOMAINS` or remove it for permissive mode.

**Zombie chromium after a crash** — the registry installs SIGINT / SIGTERM /
exit handlers that call `closeBrowserProvider()`. If a process truly dies
ungracefully (OOM, kill -9), use `ps aux | grep chromium | awk '{print $2}' | xargs kill` to clean up. A future phase may add a presence-file based
sweeper.
