# Browser Control Scope for Agent AFK

> Scope document. **No implementation.** Grounded in files read from this worktree on 2026-05-28. File references are `path:line`.

---

## TL;DR

- **Browser tools are native AFK tools, not a new subsystem.** Drop five handler files into `src/agent/tools/handlers/` and five `AnthropicToolDef` literals into `src/agent/tools/schemas.ts` — exactly mirroring `bashTool`, `readFileTool`, etc. (`src/agent/tools/schemas.ts:13–38`).
- **A `BrowserProvider` interface lives in `src/browser/`, not in `src/agent/providers/`.** The latter is reserved for **LLM** providers (`ModelProvider` at `src/agent/provider.ts:341`); reusing that shape for browsers would be a misleading abstraction. We mirror the *pattern* (interface + per-backend subdir + pure `auth.ts`), not the *type*.
- **Playwright is the only Phase 1 backend.** Lazy-imported behind the provider boundary so the SDK can be a `peerDependency` — nothing else in AFK transitively pulls in 300MB of browsers.
- **The agent acts on semantic targets by default.** `{ kind: 'semantic', text: 'Sign in', role: 'button' }` resolves inside the provider; selectors are an explicit escape hatch. Each `BrowserObservation` returns stable element IDs (`el_a1b2`) the agent reuses for follow-up actions in the same turn.
- **Browser events become a new `TraceEventKind`.** `~/.afk/state/witness/<sessionId>/trace.jsonl` is already production-hardened (`src/agent/trace/writer.ts:186`); we extend the existing union — no parallel log file.
- **Screenshots are sidecar files** under `~/.afk/state/witness/<sessionId>/browser/screenshots/` referenced from the JSONL line. This mirrors the existing `pre-compaction.json` sidecar pattern (`src/agent/trace/writer.ts:243`) — JSONL never carries binary blobs.
- **Runtime awareness gets a new `browser` view.** Five-edit recipe already mapped: extend `RuntimeView` union, add accessor in `RuntimeStateSource`, add switch case in `runtime-snapshot.ts:30`, extend tool schema enum, pass accessor in both providers' `buildRuntimeStateSource()` call.
- **MCP and CLI are adapters, not the primitive.** MCP browser servers are *already possible today* with zero code via `~/.afk/config/mcp.json` (`src/agent/mcp/config-loader.ts:237`); we should detect and warn on double-registration, not duplicate logic. CLI commands are Phase 3 and import the same provider singleton.

---

## Current Architecture Findings

### Tools

- All tool schemas are raw JSON Schema literals on the `AnthropicToolDef` interface (`src/agent/providers/anthropic-direct/types.ts:306`). No Zod, no decorators. Example: `bashTool` at `src/agent/tools/schemas.ts:13–38` with `name`, `description`, `input_schema`, plus AFK-specific metadata (`category`, `concurrencySafe`, `riskClass`) that gets stripped before wire transmission (`types.ts:215–243`).
- Handlers are `(input: unknown, signal: AbortSignal, context?: ToolHandlerContext) => Promise<ToolResult>` (`src/agent/tools/types.ts:77–81`). Each native tool lives in one file under `src/agent/tools/handlers/` (12 files today: bash, read-file, write-file, edit-file, glob, grep, list-directory, send-telegram, web-scrape, schedules, terminal-font-size, ask-question).
- Registration is **explicit, no discovery scan**: `createBuiltinHandlers(permissionMode?, cwd?)` at `src/agent/tools/handlers/index.ts:47` returns a hard-coded `Map<string, ToolHandler>`. The Anthropic provider merges this with memory handlers, optional `get_runtime_state`, and MCP handlers (`src/agent/providers/anthropic-direct/index.ts:262–294`).
- Dispatch path: `loop.ts:419` → `SessionToolDispatcher.execute()` at `src/agent/tools/dispatcher.ts:320` → PreToolUse hook → permission check → handler invocation → PostToolUse hook (fire-and-forget). **Pre/PostToolUse hooks fire automatically for every tool, including MCP, including any new browser tools** — no extra wiring needed.

### Provider pattern (LLM-only today)

- `ModelProvider` is a two-member interface: `{ readonly name: string; query(args: ProviderQueryArgs): ProviderQuery }` (`src/agent/provider.ts:341–345`). The whole contract for a new backend.
- Each LLM provider is a closed subdirectory with `index.ts` (class), `auth.ts` (pure credential resolver returning a tagged resolution object), `query.ts` (`ProviderQuery` impl), `translate.ts` (wire ↔ `ProviderEvent`). Anthropic-direct has 15 files; openai-compatible has 8.
- **No non-LLM provider-style abstractions exist in the codebase today.** Exhaustive grep for `interface.*Provider` / `class.*Provider` found nothing for search, storage, browsers, etc. `web_scrape` is hardcoded to Firecrawl. This means the `BrowserProvider` is *new* infrastructure — we are not parasitizing an existing pattern, we are establishing one. _(Update post-2026-05-28: Firecrawl was later removed — `web_scrape` now uses local Readability+Turndown extraction with a Playwright-`render()` escalation and a pluggable `SearchBackend` (Brave). See `src/web/` and `BrowserProvider.render()`.)_

### Witness / trace (already real)

- `~/.afk/state/witness/<sessionId>/trace.jsonl` is the canonical evidence layer. **Not aspirational** — appears as the official name 20+ times in production source (`src/paths.ts:211–212`, `src/agent/trace/factory.ts:5,44,52`).
- `TraceEventKind` is a closed union of 10 variants at `src/agent/trace/types.ts:26–36`. The writer holds a single `FileHandle` with `O_APPEND`, queue-serializes writes, and exposes per-kind helpers in `src/agent/trace/emit.ts` (e.g. `emitToolCall`, `emitHookDecision`). Each helper no-ops when writer is undefined and swallows errors — the witness layer "must not interfere with the primary work" (`emit.ts:14`).
- **No prior art for binary artifacts.** Closest precedent: compaction emits `<seq>-<ts>-pre-compaction.json` sidecar files in the same `witness/<sessionId>/` directory and the JSONL line carries a reference (`writer.ts:243`). Screenshots adopt the identical pattern.
- `emitClaim` is defined at `emit.ts:130` but has **zero non-test call sites**. Infrastructure complete, emission sites absent. Browser tools should use the new `emitBrowserEvent` helper, not retrofit `emitClaim`.

### Runtime awareness

- `get_runtime_state` lives entirely under `src/agent/awareness/` (5 files). Views dispatch via a simple `switch (view)` at `src/agent/awareness/runtime-snapshot.ts:30`. Today's views: `self | tools | subagents | all`.
- The current worktree's awareness layer is explicitly **Phase 1: read-only runtime snapshot. No persistence, no presence files, no claims, no workspace baseline.** (`src/agent/awareness/index.ts:4`). PR #548's `gatherWorkspace` does not exist here — important context: any browser awareness we add will be the *second* Phase 2 feature alongside workspace.
- Adding a view is a 5-edit recipe: `types.ts` (extend union + add accessor + add optional field), `runtime-snapshot.ts` (add switch case), `runtime-source.ts` (implement accessor), `tool.ts` (extend schema enum), both provider builders (`anthropic-direct/index.ts:478`, `openai-compatible/index.ts:135`) (pass new dep).

### MCP & CLI

- `McpManager.fromConfig()` already loads `~/.afk/config/mcp.json` and exposes every server's tools as `mcp__<server>__<tool>` (`src/agent/mcp/manager.ts:94, 215, 354`). **A user can install `@playwright/mcp` today and get browser tools with zero AFK code changes.** This is important: our native tools must not silently double-register if a browser MCP server is also configured.
- CLI commands are explicit `register*(program)` calls in `src/cli/index.ts:60–82`. Commands either construct an `AgentSession` (e.g. `chat.ts:494`) or call library functions directly (e.g. `doctor.ts:210–260`). The latter pattern is what `afk browser open` should follow — it shouldn't need a model in the loop just to open a tab.

---

## Recommended Architecture

```
src/
  browser/                          ← NEW: native browser-control library
    types.ts                        ← BrowserObservation, InteractiveElement, Target, …
    provider.ts                     ← BrowserProvider interface
    registry.ts                     ← getBrowserProvider() singleton + lifecycle
    config.ts                       ← pure: allowlist, headless mode, profile resolution
    sanitize.ts                     ← pure: redact passwords/tokens from strings + DOM
    witness.ts                      ← screenshot sidecar writer + emitBrowserEvent bridge
    playwright/                     ← FIRST backend
      index.ts                      ← PlaywrightProvider implements BrowserProvider
      launcher.ts                   ← chromium launch + BrowserContext mgmt
      observe.ts                    ← DOM walk → InteractiveElement[] compression
      resolve-target.ts             ← semantic target → Playwright Locator
      extract.ts                    ← structured-data extraction (Phase 2)

  agent/tools/handlers/
    browser-open.ts                 ← thin shim: calls registry.getBrowserProvider().open()
    browser-observe.ts
    browser-act.ts
    browser-screenshot.ts
    browser-close.ts
    browser-extract.ts              ← Phase 2

  agent/trace/types.ts              ← EDIT: add 'browser_event' to TraceEventKind + payload type
  agent/trace/emit.ts               ← EDIT: add emitBrowserEvent helper
  agent/awareness/types.ts          ← EDIT: add 'browser' to RuntimeView, RuntimeBrowser interface
  agent/awareness/runtime-snapshot.ts ← EDIT: add switch case
  agent/awareness/runtime-source.ts ← EDIT: add getBrowser() accessor
  agent/awareness/tool.ts           ← EDIT: extend view enum + description

  cli/commands/browser.ts           ← Phase 3
```

**Why this shape:**

1. **Tools are tools.** The five new handlers slot into the existing dispatcher with zero special-casing. Hooks, permissions, witness emission, abort cascading, schema rendering — all inherited free.
2. **The provider abstraction is real but lives outside `src/agent/providers/`.** That directory is the LLM boundary; mixing in a browser interface would muddy the type system. `src/browser/` keeps the browser layer self-contained and importable from anywhere (tool handlers, CLI commands, future MCP adapter) without coupling to AgentSession.
3. **Tool handlers are thin shims.** Each handler validates input → calls the provider → emits a `browser_event` trace line → returns a `ToolResult`. ~30 LOC each. The complexity lives in `src/browser/playwright/`.
4. **One singleton per AFK process, one BrowserContext per session.** Process-level Playwright browser launch is expensive (~1s); sharing across sessions is fine. Per-session `BrowserContext` keeps cookies/storage isolated. Subagents share parent's context by reference — consistent with the MCP manager precedent (CLAUDE.md: "subagents share parent by reference").
5. **Lazy Playwright import.** `import('playwright')` inside `playwright/launcher.ts` only — never at module top. Users who never call a browser tool never load 300MB of chromium.

---

## Proposed Tool Contracts

All six tools follow the existing `AnthropicToolDef` shape in `src/agent/tools/schemas.ts`. Inputs are JSON Schema; outputs are described semantically because `ToolResult.content` is a string the handler stringifies (matching `bash`, `read_file` convention).

### `browser_open`

```jsonc
{
  "name": "browser_open",
  "category": "browser",            // NEW ToolCategory bucket
  "concurrencySafe": false,
  "description": "Open a URL in a managed browser tab and return an observation...",
  "input_schema": {
    "type": "object",
    "properties": {
      "url":          { "type": "string", "description": "Absolute http(s) URL." },
      "wait_for":     { "type": "string", "enum": ["load", "domcontentloaded", "networkidle"], "description": "Default: load." },
      "screenshot":   { "type": "boolean", "description": "Capture screenshot in returned observation. Default: false." },
      "timeout_ms":   { "type": "number", "description": "Navigation timeout. Default 30000, max 120000." }
    },
    "required": ["url"]
  }
}
```

**Returns:** stringified `BrowserObservation` (see Observation Model). On error returns `{ content: "Failed to open <url>: <reason>", isError: true }`.

### `browser_observe`

```jsonc
{
  "name": "browser_observe",
  "category": "browser",
  "concurrencySafe": true,
  "description": "Refresh the observation of the current page. Use after waiting for content to load or after an action that triggered navigation.",
  "input_schema": {
    "type": "object",
    "properties": {
      "screenshot":     { "type": "boolean" },
      "include_hidden": { "type": "boolean", "description": "Include elements with display:none or visibility:hidden. Default: false." },
      "max_elements":   { "type": "number",  "description": "Cap on InteractiveElement array length. Default: 80, max: 300." }
    }
  }
}
```

**Returns:** stringified `BrowserObservation`.

### `browser_act`

```jsonc
{
  "name": "browser_act",
  "category": "browser",
  "concurrencySafe": false,
  "description": "Perform an action against a target on the current page. Prefer semantic targets ('Sign in', 'Email field') over selectors. Use element IDs from the most recent observation for unambiguous reference.",
  "input_schema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["click", "fill", "press", "select", "hover", "scroll_to", "wait_for"],
        "description": "What to do at the target."
      },
      "target": {
        "type": "object",
        "description": "How to identify the element. Prefer 'semantic'; use 'element_id' for unambiguous reuse from a prior observation; use 'selector' only when the page has no accessible labels.",
        "properties": {
          "kind":       { "type": "string", "enum": ["semantic", "element_id", "selector"] },
          "text":       { "type": "string", "description": "Required when kind=semantic. The visible label, placeholder, or accessible name." },
          "role":       { "type": "string", "description": "Optional ARIA role to disambiguate (button, link, textbox, …)." },
          "element_id": { "type": "string", "description": "Required when kind=element_id. From the most recent observation." },
          "selector":   { "type": "string", "description": "Required when kind=selector. CSS or xpath= prefix." }
        },
        "required": ["kind"]
      },
      "value":         { "type": "string", "description": "Text to type (fill), key combo (press), or option value (select). Secrets are auto-redacted from witness logs." },
      "timeout_ms":    { "type": "number", "description": "Per-action timeout. Default 10000." },
      "screenshot":    { "type": "boolean", "description": "Capture screenshot after action. Always captured on failure regardless." }
    },
    "required": ["action", "target"]
  }
}
```

**Returns:** stringified `BrowserObservation` reflecting post-action state. On semantic-target ambiguity (multiple elements match), returns `isError: true` with a disambiguation list of candidate elements + their IDs — the agent retries with `element_id`. Never silently picks one.

### `browser_extract` *(Phase 2)*

```jsonc
{
  "name": "browser_extract",
  "category": "browser",
  "concurrencySafe": true,
  "description": "Extract structured data from the current page using a schema. Returns JSON matching the schema. Use for tables, lists, repeated card layouts.",
  "input_schema": {
    "type": "object",
    "properties": {
      "schema":      { "type": "object", "description": "JSON Schema describing the target shape." },
      "instruction": { "type": "string", "description": "Natural-language hint about what region of the page to extract from." },
      "scope_selector": { "type": "string", "description": "Optional CSS selector to constrain extraction to a subtree." }
    },
    "required": ["schema"]
  }
}
```

**Returns:** JSON string conforming to `schema`, or `isError: true` with a partial-match explanation.

### `browser_screenshot`

```jsonc
{
  "name": "browser_screenshot",
  "category": "browser",
  "concurrencySafe": true,
  "description": "Capture a screenshot of the current page (or a target element). Returns the witness-relative path to the image; the file is also referenced from the browser_event trace line.",
  "input_schema": {
    "type": "object",
    "properties": {
      "target":    { "type": "object", "description": "Optional target to screenshot. Same shape as browser_act.target. If omitted, captures viewport." },
      "full_page": { "type": "boolean", "description": "Capture the entire scrollable page, not just viewport. Default: false." }
    }
  }
}
```

**Returns:** `{ path: "~/.afk/state/witness/<sid>/browser/screenshots/<seq>-<ts>.png", bytes: N, width, height }` as JSON string.

### `browser_close`

```jsonc
{
  "name": "browser_close",
  "category": "browser",
  "concurrencySafe": false,
  "description": "Close the current browser session for this AgentSession. Subsequent browser tool calls will lazily open a fresh session.",
  "input_schema": { "type": "object", "properties": {} }
}
```

**Returns:** `"Browser closed."` or `"Browser was not open."`.

---

## Proposed Provider Interface

```ts
// src/browser/provider.ts

/**
 * Pluggable backend for browser control. First implementation: Playwright.
 *
 * Lifecycle: a BrowserProvider owns ONE browser process and N BrowserContexts
 * (one per AgentSession). Sessions are identified by an opaque `sessionId`
 * provided by the caller.
 *
 * Methods that don't apply to a backend (e.g. screenshot on a headless-only
 * remote) should resolve with `isError: true` and a `reason`, not throw,
 * so the harness stays backend-agnostic.
 */
export interface BrowserProvider {
  readonly name: string;            // 'playwright' | 'mcp' | 'remote' | …

  open(input: OpenInput): Promise<BrowserObservation>;
  observe(input: ObserveInput): Promise<BrowserObservation>;
  act(input: ActInput): Promise<BrowserObservation>;
  screenshot(input: ScreenshotInput): Promise<ScreenshotResult>;
  extract(input: ExtractInput): Promise<ExtractResult>;  // Phase 2
  close(input: CloseInput): Promise<void>;

  /** Used by runtime awareness to expose minimal state without coupling. */
  describe(sessionId: string): BrowserProviderState | null;
}

export interface OpenInput {
  sessionId: string;
  url: string;
  waitFor?: 'load' | 'domcontentloaded' | 'networkidle';
  screenshot?: boolean;
  timeoutMs?: number;
}

export interface ObserveInput {
  sessionId: string;
  screenshot?: boolean;
  includeHidden?: boolean;
  maxElements?: number;
}

export interface ActInput {
  sessionId: string;
  action: 'click' | 'fill' | 'press' | 'select' | 'hover' | 'scroll_to' | 'wait_for';
  target: Target;
  value?: string;
  timeoutMs?: number;
  screenshot?: boolean;
}

export interface ScreenshotInput {
  sessionId: string;
  target?: Target;
  fullPage?: boolean;
}

export interface ExtractInput {
  sessionId: string;
  schema: Record<string, unknown>;   // JSON Schema
  instruction?: string;
  scopeSelector?: string;
}

export interface CloseInput {
  sessionId: string;
}

export type Target =
  | { kind: 'semantic'; text: string; role?: string }
  | { kind: 'element_id'; elementId: string }
  | { kind: 'selector'; selector: string };

export interface ScreenshotResult {
  path: string;       // absolute path under ~/.afk/state/witness/<sid>/browser/screenshots/
  bytes: number;
  width: number;
  height: number;
}

export interface ExtractResult {
  data: unknown;      // conforms to input.schema
  warnings?: string[];
}

export interface BrowserProviderState {
  active: boolean;
  url: string | null;
  title: string | null;
  lastActionAt: string | null;   // ISO
  openTabs: number;
}
```

**Singleton lifecycle** (`src/browser/registry.ts`):

```ts
let _provider: BrowserProvider | null = null;

export async function getBrowserProvider(): Promise<BrowserProvider> {
  if (!_provider) {
    const { PlaywrightProvider } = await import('./playwright/index.js');  // lazy
    _provider = new PlaywrightProvider(loadBrowserConfig());
  }
  return _provider;
}

export async function closeBrowserProvider(): Promise<void> { /* … */ }

// Install SIGINT/SIGTERM/exit handlers identical to the presence-file pattern
// from PR #548 so we never leak a chromium process across crashes.
```

---

## Observation Model

```ts
// src/browser/types.ts

export interface BrowserObservation {
  /** Stable, monotonically-increasing per browser session. Lets the agent
   *  refer to "the form I just saw in obs #4" if we ever expose history. */
  observationId: string;

  /** Current page URL after any redirects. */
  url: string;
  title: string;

  /** Always populated. Compressed visible-text summary, ≤4000 chars.
   *  Strips scripts, styles, and elements hidden via CSS. */
  textSummary: string;

  /** Compressed list of actionable elements. Capped by maxElements.
   *  Sorted by reading order (top-to-bottom, left-to-right). */
  interactive: InteractiveElement[];

  /** Page-level signals the agent should react to. */
  status: {
    httpStatus: number | null;          // null if same-document navigation
    loadingState: 'idle' | 'loading' | 'navigating';
    hasDialog: boolean;                 // alert/confirm open?
    consoleErrors: number;              // count of console.error since open
  };

  /** Soft warnings: "page has 200+ interactive elements; consider scoping" */
  warnings: string[];

  /** Absolute path under ~/.afk/state/witness/<sid>/browser/screenshots/.
   *  Present iff caller requested screenshot:true (or on error). */
  screenshotPath: string | null;

  /** ISO timestamp when this observation was captured. */
  capturedAt: string;
}

export interface InteractiveElement {
  /** Short hash-derived ID stable within one observation. Format: el_a1b2.
   *  Agents use this in subsequent browser_act calls with target.kind='element_id'. */
  id: string;

  /** ARIA role or 'button'|'link'|'input'|'textbox'|'select'|'checkbox'|… */
  role: string;

  /** Best human-readable label, in priority order:
   *  aria-label > associated <label> > placeholder > visible text > title. */
  label: string;

  /** Element type info: input type, button variant, etc. */
  kind: string | null;        // 'submit' | 'email' | 'password' | 'tab' | …

  /** Current value (text inputs, checked state). Redacted if password type. */
  value: string | null;

  /** State flags. */
  state: {
    disabled: boolean;
    checked?: boolean;
    selected?: boolean;
    expanded?: boolean;
  };

  /** Bounding box in viewport pixels. Useful for screenshot annotation. */
  bbox: { x: number; y: number; w: number; h: number };

  /** Escape-hatch CSS selector. Only populated when the page has stable
   *  ids/data-testids; intentionally undefined for purely styled elements
   *  to avoid agents reaching for brittle selectors. */
  selector?: string;
}
```

**Compression strategy** (in `src/browser/playwright/observe.ts`):

1. Query the accessibility tree via `page.accessibility.snapshot()` first — gives us role + name + state without DOM walking. This is the model-friendly source of truth.
2. Filter to *actionable* nodes: `role in {button, link, textbox, combobox, checkbox, radio, tab, menuitem, …}`.
3. Map each to `InteractiveElement`, assigning `id = 'el_' + hash(role + label + bbox).slice(0,6)`.
4. Stable within observation; not stable across observations (page reflows). The agent always uses the most recent observation's IDs.

---

## Witness / Runtime State Integration

### Witness — extend `TraceEventKind`

```ts
// src/agent/trace/types.ts

export type TraceEventKind =
  | 'tool_call'
  | 'hook_decision'
  | 'subagent_lifecycle'
  | 'background_agent'
  | 'budget'
  | 'abort'
  | 'compaction'
  | 'closure'
  | 'claim'
  | 'session_sealed'
  | 'browser_event';                        // NEW

export interface BrowserEventPayload {
  /** Which browser tool ran. */
  tool: 'browser_open' | 'browser_observe' | 'browser_act'
      | 'browser_screenshot' | 'browser_extract' | 'browser_close';

  /** Sub-discriminator for browser_act. */
  action?: ActInput['action'];

  /** What was targeted (sanitized — no selector contents if it embeds secrets). */
  target?: {
    kind: 'semantic' | 'element_id' | 'selector';
    text?: string;            // semantic only; truncated to 80 chars
    role?: string;
    elementId?: string;
    selectorHash?: string;    // sha256(selector).slice(0,8) — never the raw selector
  };

  /** URL captured BEFORE the action took effect. */
  urlBefore: string | null;

  /** URL captured AFTER. Equal to urlBefore for non-navigating actions. */
  urlAfter: string | null;

  /** Outcome. */
  status: 'ok' | 'error' | 'ambiguous_target' | 'blocked_by_policy';

  /** Sidecar path under ~/.afk/state/witness/<sid>/browser/screenshots/.
   *  Always present on error; otherwise present iff requested. */
  screenshotPath?: string;

  /** Compressed observation summary — ≤500 chars. The full observation
   *  is NOT persisted in witness (would balloon trace size); only the
   *  caller's tool_call.completed payload carries the result string. */
  observationSummary?: string;

  /** Error details when status='error'. */
  error?: { reason: string; recoverable: boolean };

  /** Wall-clock duration. */
  durationMs: number;
}
```

### Witness — on-disk layout

```
~/.afk/state/witness/<sessionId>/
  trace.jsonl                           ← existing; gains browser_event lines
  browser/                              ← NEW
    screenshots/
      <seq>-<isoTs>-<tool>.png          ← e.g. 0042-2026-05-28T05-12-33Z-browser_act.png
    dom-snapshots/                      ← Phase 2 only
      <seq>-<isoTs>.html.gz             ← gzipped outerHTML for post-mortem
```

- Screenshots are written by `src/browser/witness.ts` using the same `~/.afk/state/witness/<sessionId>/` root computed by `getTraceDir()` (`src/paths.ts:211–212`).
- `<seq>` is the same monotonic sequence used by `NdjsonTraceWriter`. The trace writer exposes a `nextSeq()` accessor (we add this — not yet present) so the screenshot filename and the JSONL line agree.
- DOM snapshots are Phase 2; they're large and only useful for diagnosis when an action fails. Opt-in via `AFK_BROWSER_DOM_SNAPSHOTS=1`.

### Witness — emit helper

```ts
// src/agent/trace/emit.ts (added alongside existing helpers)

export async function emitBrowserEvent(
  writer: TraceWriter | undefined,
  payload: BrowserEventPayload,
): Promise<void> {
  if (!writer) return;
  try {
    await writer.write({ kind: 'browser_event', payload });
  } catch (err) {
    debugLog(`trace.emit browser_event failed: ${stringifyError(err)}`);
  }
}
```

The tool handlers call `emitBrowserEvent(traceWriter, …)` after the provider call returns. The handler also returns a `ToolResult` — `tool_call` events emitted by the existing dispatcher cover the *call*; the new `browser_event` covers the *browser-domain semantics*.

### Runtime awareness — `browser` view

```ts
// src/agent/awareness/types.ts (extension)

export type RuntimeView = 'self' | 'tools' | 'subagents' | 'browser' | 'all';

export interface RuntimeBrowser {
  active: boolean;
  url: string | null;
  title: string | null;
  lastAction: string | null;          // 'browser_act:click' | 'browser_open' | …
  lastActionAt: string | null;        // ISO
  lastScreenshotPath: string | null;  // relative to witness/<sid>/
  openTabs: number;
}

export interface RuntimeStateSource {
  getSelf(): RuntimeSelf;
  getTools(): RuntimeTools;
  getSubagents(): RuntimeSubagents;
  getBrowser(): RuntimeBrowser;       // NEW
}

export interface RuntimeSnapshot {
  self?: RuntimeSelf;
  tools?: RuntimeTools;
  subagents?: RuntimeSubagents;
  browser?: RuntimeBrowser;           // NEW
}
```

The `getBrowser` accessor calls `getBrowserProvider().describe(sessionId)` and maps `BrowserProviderState | null` → `RuntimeBrowser` (returning `{ active: false, … }` when null). **No auto-injection into prompts** — the agent only sees this when it explicitly calls `get_runtime_state` with `view: 'browser'` or `view: 'all'`. This matches the existing minimal-surface policy in `awareness/index.ts:4`.

---

## Phased Implementation Plan

### Phase 1 — Minimal local Playwright (~3 days)

- [ ] `src/browser/types.ts` — `BrowserObservation`, `InteractiveElement`, `Target`, all I/O types
- [ ] `src/browser/provider.ts` — `BrowserProvider` interface
- [ ] `src/browser/config.ts` — `loadBrowserConfig()` reads `~/.afk/config/browser.json` + env vars (`AFK_BROWSER_HEADLESS`, `AFK_BROWSER_ALLOWED_DOMAINS`, `AFK_BROWSER_BLOCKED_DOMAINS`)
- [ ] `src/browser/registry.ts` — singleton + SIGINT/SIGTERM/exit cleanup
- [ ] `src/browser/sanitize.ts` — `redactSecrets(input: string): string` for type-able values
- [ ] `src/browser/playwright/index.ts` — `PlaywrightProvider` class
- [ ] `src/browser/playwright/launcher.ts` — chromium launch, BrowserContext-per-session
- [ ] `src/browser/playwright/observe.ts` — accessibility-tree → InteractiveElement compression
- [ ] `src/browser/playwright/resolve-target.ts` — semantic → Locator with ambiguity detection
- [ ] `src/agent/tools/handlers/browser-open.ts` (5 handler files, ~30 LOC each)
- [ ] `src/agent/tools/handlers/browser-observe.ts`
- [ ] `src/agent/tools/handlers/browser-act.ts`
- [ ] `src/agent/tools/handlers/browser-screenshot.ts`
- [ ] `src/agent/tools/handlers/browser-close.ts`
- [ ] Add five `AnthropicToolDef` entries to `src/agent/tools/schemas.ts` and the `builtinToolSchemas` array
- [ ] Register five handlers in the map at `src/agent/tools/handlers/index.ts:47`
- [ ] Add `'browser_event'` to `TraceEventKind` (`src/agent/trace/types.ts:26–36`)
- [ ] Add `BrowserEventPayload` type to `src/agent/trace/types.ts`
- [ ] Add `emitBrowserEvent` to `src/agent/trace/emit.ts`
- [ ] `src/browser/witness.ts` — screenshot sidecar writer using `getTraceDir()`
- [ ] `playwright` added as **optionalDependency** in `package.json`; handlers detect missing package and return a friendly install hint
- [ ] Tests: `src/browser/playwright/observe.test.ts` (accessibility tree compression), `src/browser/playwright/resolve-target.test.ts` (semantic disambiguation), `src/agent/tools/handlers/browser-*.test.ts` (one per handler, using a mock provider)
- [ ] Doc: `docs/browser-control.md` (user-facing)

### Phase 2 — Richer observation + runtime awareness (~2 days)

- [ ] `src/browser/playwright/extract.ts` + `src/agent/tools/handlers/browser-extract.ts`
- [ ] Observation compression v2: dedupe near-identical elements, group repeated list items, summarize tables as "N rows × M cols, first 3 rows"
- [ ] DOM snapshot sidecar (opt-in via `AFK_BROWSER_DOM_SNAPSHOTS=1`)
- [ ] Always-capture-screenshot-on-error policy
- [ ] Extend `RuntimeView` union; add `getBrowser()` to `RuntimeStateSource`; switch case in `runtime-snapshot.ts:30`; schema enum extension in `awareness/tool.ts`; pass accessor in both provider builders
- [ ] Tests: awareness/browser-view.test.ts; observation v2 dedup

### Phase 3 — CLI surface + MCP coexistence audit (~1 day)

- [ ] `src/cli/commands/browser.ts` — `afk browser open <url>`, `afk browser observe`, `afk browser act --click "Sign in"`, `afk browser close`. Each uses `getBrowserProvider()` directly (no `AgentSession`), mirroring `doctor.ts:210–260`
- [ ] Register in `src/cli/index.ts:60–82`
- [ ] MCP coexistence check: when `mcp__<server>__browser_*` is present, log a warning at session start that both native and MCP browser tools are active. No automatic suppression — user choice.
- [ ] Tests: CLI command smoke tests

### Phase 4 — Remote provider (defer indefinitely)

- [ ] `src/browser/cdp/` — Chrome DevTools Protocol over WebSocket → BrowserBase / browserless.io / self-hosted
- [ ] Backend selection via `AFK_BROWSER_BACKEND=playwright|cdp`
- [ ] Only build when there's actual demand

---

## File Plan

**New files (Phase 1):**

| Path | LOC est | Purpose |
|---|---|---|
| `src/browser/types.ts` | 100 | All public I/O types |
| `src/browser/provider.ts` | 60 | `BrowserProvider` interface |
| `src/browser/config.ts` | 120 | Config loader (allowlist, headless, profile) |
| `src/browser/registry.ts` | 80 | Singleton + cleanup hooks |
| `src/browser/sanitize.ts` | 80 | Secret redaction |
| `src/browser/witness.ts` | 100 | Screenshot sidecar writer |
| `src/browser/playwright/index.ts` | 200 | `PlaywrightProvider` (orchestration) |
| `src/browser/playwright/launcher.ts` | 150 | Browser/context lifecycle |
| `src/browser/playwright/observe.ts` | 250 | Accessibility tree → InteractiveElement |
| `src/browser/playwright/resolve-target.ts` | 180 | Semantic → Locator + disambiguation |
| `src/agent/tools/handlers/browser-open.ts` | 40 | Thin shim |
| `src/agent/tools/handlers/browser-observe.ts` | 40 | " |
| `src/agent/tools/handlers/browser-act.ts` | 50 | " (slightly more validation) |
| `src/agent/tools/handlers/browser-screenshot.ts` | 40 | " |
| `src/agent/tools/handlers/browser-close.ts` | 30 | " |
| Tests | 800 | One per behavior-bearing module |

All new files under 350 LOC except `observe.ts` (250 OK; allow up to 350 if needed for accessibility tree edge cases). Total Phase 1: ~12 production files + tests.

**Files edited (Phase 1):**

| Path | Change |
|---|---|
| `src/agent/tools/schemas.ts` | +5 `AnthropicToolDef` literals, +5 entries in `builtinToolSchemas` array, +1 `ToolCategory` value `'browser'` |
| `src/agent/tools/handlers/index.ts` | +5 entries in the `Map` at line 47 |
| `src/agent/tools/types.ts` | Extend `ToolCategory` union with `'browser'` |
| `src/agent/trace/types.ts` | +1 `TraceEventKind` value, +1 payload interface |
| `src/agent/trace/emit.ts` | +1 helper function |
| `src/agent/trace/index.ts` | Export new types |
| `package.json` | `playwright` as `optionalDependencies` (NOT `dependencies` or `peerDependencies` — `optionalDependencies` keeps `pnpm install` from failing when the user skips it, and the runtime detects absence) |
| `.sdk-dependency.lock.json` | N/A — Playwright is not an SDK in the protected sense; CLAUDE.md's lockfile is for `@anthropic-ai/sdk` symbols |
| `docs/env-registry.{json,md}` | Regen via `pnpm scan:env` after adding `AFK_BROWSER_*` env vars to `src/config/env.ts` |

**Files edited (Phase 2):**

| Path | Change |
|---|---|
| `src/agent/awareness/types.ts` | +`RuntimeBrowser`, extend `RuntimeView`, add accessor |
| `src/agent/awareness/runtime-snapshot.ts` | +switch case at line 30 |
| `src/agent/awareness/runtime-source.ts` | +`getBrowser` accessor in `buildRuntimeStateSource` |
| `src/agent/awareness/tool.ts` | Extend `view.enum` array + description string |
| `src/agent/providers/anthropic-direct/index.ts:478` | Pass `getBrowserState` lambda to `buildRuntimeStateSource` |
| `src/agent/providers/openai-compatible/index.ts:135` | Same |

---

## Non-goals

Explicitly out of scope for this MVP:

- **File downloads and uploads.** Adds OS-level permission, antivirus, and content-type complexity. Defer to Phase ≥3 with a separate spec.
- **Multiple concurrent tabs per session.** One active tab per session. `openTabs` in `RuntimeBrowser` exists for forward-compat but stays at 0 or 1 in Phase 1–2.
- **Browser extensions / userscripts.** The chromium instance starts clean.
- **Persistent user profiles across AFK sessions.** Each session gets a fresh `BrowserContext`. Cookie persistence is a Phase 4 conversation if anyone asks for it.
- **OAuth flows that require a human in the loop mid-flow.** The agent can navigate to a login page, but the operator types credentials in the headed browser. Headless OAuth is out of scope.
- **PDF rendering, video capture, performance traces.** These are real Playwright features. We are not building a generic Playwright wrapper — we are building an agent-friendly browser surface.
- **`browser_eval`-style arbitrary-JavaScript injection.** Massive security surface; deferred to a separate spec with explicit allowlist or sandboxing.
- **Visual-LLM ("see what's on screen") integration.** The agent reasons over the `BrowserObservation`'s text + interactive list. If we eventually want vision, the existing `screenshot` field is the hook — no API change needed.
- **Cross-origin iframe traversal.** Out of MVP. Frames will be flattened into the main observation with a `frame_id` hint; deep iframe automation comes later.
- **Replacing or competing with existing MCP browser servers.** We coexist; we do not preempt. If a user prefers `@playwright/mcp`, it keeps working.

---

## Open Questions

Only listing items that **truly block implementation**. Everything else has a reasonable default chosen above.

1. **Should the browser session be tied to AgentSession lifetime, or to AFK process lifetime?**
   - Recommended: AFK process owns one Playwright browser; each AgentSession owns a `BrowserContext` keyed by `sessionId`. Subagents share parent's context. Context closes on session end; browser closes on process exit.
   - Block reason: if we pick wrong, refactoring lifecycle later is expensive.
   - **Default if no answer:** the recommendation above.

2. **What is the policy when the agent calls `browser_act` with `kind: 'semantic'` and the resolver finds 2+ matches?**
   - Option A (recommended): return `isError: true` with a `disambiguation` list of 3–5 candidate elements + their `element_id`s; agent retries with explicit ID.
   - Option B: silently pick the first one.
   - Option C: silently pick the visually-leftmost-topmost.
   - **Default if no answer:** Option A. Silent picking is the kind of "feels-smart, breaks-randomly" behavior we are explicitly trying to avoid.

3. **Default `headless` mode.**
   - Headless on for daemon/subagent contexts.
   - Headed when surface is `repl` or `interactive` so the operator can watch.
   - Both overridable via `AFK_BROWSER_HEADLESS=0|1`.
   - **Default if no answer:** as above.

Everything else (config file location, screenshot frequency, sanitization patterns, observation cap, etc.) has a working assumption in the document and can be tuned during implementation without architectural change.

---

## Risks and Tradeoffs

| Risk | Mitigation |
|---|---|
| **Playwright dependency weight (~300MB).** `pnpm install` bloat + CI image bloat. | `optionalDependencies` in package.json; lazy `import('playwright')` inside `playwright/launcher.ts`; clear install hint when missing. Users who never use browser tools never pay. |
| **Selector brittleness.** Selectors break on minor markup changes. | Semantic targets default; selectors are explicit escape hatch. `InteractiveElement.selector` is intentionally undefined when no stable id/testid exists, forcing the agent to use `element_id`. |
| **Semantic resolution complexity.** "Sign in" might match 3 buttons. | Return `ambiguous_target` status with disambiguation list. Never silent-pick. Tested via `resolve-target.test.ts`. |
| **Browser lifecycle / zombie processes.** Crashed AFK process leaves chromium running. | SIGINT/SIGTERM/exit handlers mirror PR #548's presence-file cleanup. Process-level: `process.on('exit', closeBrowserProvider)`. |
| **Trace size growth.** Screenshot every action = MB/turn. | Screenshots opt-in per tool call; auto-captured only on errors. DOM snapshots opt-in via env var. Use existing trace cleanup conventions. |
| **Flaky waits.** Network idle is unreliable. | Default `waitFor: 'load'`; expose explicit per-call `wait_for`. Action-level timeouts default to 10s, configurable. Auto-retry on transient navigation errors (max 1 retry). |
| **MCP abstraction mismatch.** A user wires `@playwright/mcp` AND uses native tools → two parallel browser sessions. | Warning at session start when both are present. Don't try to deduplicate — user choice. Long-term: `BrowserProvider` MCP adapter that bridges to a connected MCP server, gated by `AFK_BROWSER_BACKEND=mcp`. |
| **CLI state management.** `afk browser open` then `afk browser act` is two separate processes — provider singleton doesn't persist across CLI invocations. | Phase 3 CLI commands launch a short-lived browser per invocation, OR write a small `~/.afk/state/browser-cli/<pid>.json` handle file for cross-invocation reuse. Decide at Phase 3 design time. Not blocking for Phase 1. |
| **Secrets in DOM snapshots.** Passwords visible in form values. | `sanitize.ts` redacts `input[type=password]` values pre-snapshot. `value` field on `InteractiveElement` shows `'[redacted]'` for password inputs. `browser_event` payload redacts `value` field by default. |
| **Domain policy bypass.** Agent navigates to `https://evil.com/login`. | `AFK_BROWSER_ALLOWED_DOMAINS` / `BLOCKED_DOMAINS` glob lists; navigation refused with `blocked_by_policy` status. Defaults: no allowlist (permissive); recommended documented config for production-like use. |
| **`noUncheckedIndexedAccess` strictness.** `interactive[id]` lookup will be `T \| undefined`. | Use `Array.prototype.find` or `Map<string, InteractiveElement>`. Caught at `pnpm lint`. |
| **Witness layer interference.** Bug in browser trace emission crashes a session. | Existing pattern: `emit.ts` swallows errors via try/catch and `debugLog`. `emitBrowserEvent` follows the same shape — "witness must not interfere with primary work" (`emit.ts:14`). |

---

## Terminal state

**Done.**

- Scope document written to `docs/browser-control-scope.md`. Grounded in 5 parallel investigation agents covering tools/schemas, provider pattern, witness/trace, runtime awareness, and MCP/CLI surfaces. All claims carry `path:line` citations.
- Architecture is opinionated: native AFK tools (5 in Phase 1) + `BrowserProvider` interface in new `src/browser/` directory + Playwright as first backend (lazy-loaded, `optionalDependencies`) + extend existing witness `TraceEventKind` rather than fork a new log file + add `browser` view to `get_runtime_state` in Phase 2 + CLI/MCP as Phase 3+ adapters that share the provider.
- Semantic-target-first design: every action defaults to `{ kind: 'semantic', text, role? }`; selectors are an explicit escape hatch; ambiguity returns a disambiguation list, never silent-picks.
- File plan totals ~12 new production files + edits to 6 existing files in Phase 1, with one new `ToolCategory` value (`'browser'`) and one new `TraceEventKind` value (`'browser_event'`).
- 3 open questions remain — each has a recommended default if the operator does not answer. No question blocks Phase 1 from starting once approved.
- Nothing implemented. Per the instruction, the next action is operator review of this scope document, particularly the three open questions and the recommendation that `BrowserProvider` live in `src/browser/` rather than `src/agent/providers/`.
