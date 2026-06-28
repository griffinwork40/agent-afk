/**
 * Public I/O types for native browser-control tools.
 *
 * This module is the contract between the tool handlers
 * (`src/agent/tools/handlers/browser-*.ts`) and the pluggable backend
 * (`src/browser/playwright/`, future `src/browser/cdp/`, etc). The handlers
 * see only these types; the witness layer (`src/agent/trace/types.ts`)
 * sees only `BrowserEventPayload`. Nothing in this module imports from
 * Playwright or any other backend SDK — that boundary lives behind the
 * `BrowserProvider` interface in `./provider.ts`.
 *
 * Invariant: a `BrowserObservation` is the model-facing snapshot. It is
 * what every tool returns (stringified) for the agent to reason over. The
 * *full* observation also lives transiently in process memory inside the
 * provider; we don't persist it (would balloon the trace). The trace gets
 * a compressed `observationSummary` instead.
 *
 * @module browser/types
 */

/**
 * The model-facing snapshot of the current browser tab.
 *
 * Returned by `browser_open`, `browser_observe`, and `browser_act`. The
 * handler stringifies this to JSON before returning it as `ToolResult.content`.
 */
export interface BrowserObservation {
  /**
   * Monotonically increasing within a single BrowserProvider session.
   * Lets the agent refer to "the form I just saw in obs #4" if we ever
   * expose history. Format: `obs_<base36-counter>`.
   */
  observationId: string;

  /** Current page URL after any redirects. */
  url: string;
  title: string;

  /**
   * Compressed visible-text summary, ≤4000 chars. Strips script/style
   * tags and elements hidden via CSS. Always populated.
   */
  textSummary: string;

  /**
   * Actionable elements on the page, sorted in reading order
   * (top-to-bottom, left-to-right). Capped by `maxElements` (default 80).
   * Element `id`s are stable within ONE observation only — never across.
   */
  interactive: InteractiveElement[];

  /** Page-level signals the agent should react to. */
  status: BrowserPageStatus;

  /**
   * Soft warnings the agent should consider. Examples:
   *   - "page has 200+ interactive elements; consider scoping"
   *   - "page is still loading — observation may be incomplete"
   *   - "redirected from <oldUrl>"
   */
  warnings: string[];

  /**
   * Absolute path to the screenshot sidecar under
   * `~/.afk/state/witness/<sid>/browser/screenshots/`.
   * Present iff `screenshot: true` was requested or on error.
   * `null` otherwise.
   */
  screenshotPath: string | null;

  /** ISO timestamp when this observation was captured. */
  capturedAt: string;
}

/**
 * Page-level state the agent should know about.
 *
 * Invariant: `hasDialog` triggers in the agent's read of the observation.
 * If true, no `browser_act` call will work until the dialog is dismissed
 * — the provider must surface this as a top-priority warning.
 */
export interface BrowserPageStatus {
  /** HTTP status of the most recent navigation. `null` for in-page changes. */
  httpStatus: number | null;

  /** Coarse-grained loading state. The provider chooses the wait policy
   *  (load / domcontentloaded / networkidle) — this is the *observed* state. */
  loadingState: 'idle' | 'loading' | 'navigating';

  /** True when an alert / confirm / beforeunload dialog is open. */
  hasDialog: boolean;

  /** Count of `console.error` calls since the page opened. Useful for
   *  spotting client-side errors that may have left the page in a bad state. */
  consoleErrors: number;
}

/**
 * One actionable element in an observation.
 *
 * Compression target: the agent should be able to reason over a 80-element
 * list without scrolling. Each element is one line in the stringified form.
 */
export interface InteractiveElement {
  /**
   * Short hash-derived identifier stable within ONE observation only.
   * Format: `el_<6-char-hex>`. Agents pass this back in
   * `browser_act.target.element_id` for unambiguous reuse.
   */
  id: string;

  /** ARIA role or one of: button | link | input | textbox | select | … */
  role: string;

  /**
   * Best human-readable label, resolved in priority order:
   *   aria-label > associated <label> > placeholder > visible text > title.
   * Capped at 200 chars. Multi-line labels are flattened to single-line.
   */
  label: string;

  /**
   * Element subtype. For `<input>` this is the `type` attribute; for
   * buttons it is the variant (`submit`, `reset`). `null` when not
   * applicable to the role.
   */
  kind: string | null;

  /**
   * Current value (text inputs, checked-state for checkboxes, selected
   * option for selects). Redacted to the literal string `[redacted]` for
   * `<input type="password">` inputs.
   */
  value: string | null;

  /** State flags. Optional fields are omitted when not applicable. */
  state: InteractiveElementState;

  /** Bounding box in viewport pixels. Useful for screenshot annotation
   *  and for "scroll this into view" actions. */
  bbox: BoundingBox;

  /**
   * Escape-hatch CSS selector. Intentionally undefined when the page has
   * no stable id/data-testid — forcing the agent to use `element_id`
   * rather than reach for a brittle styled-class selector. When present,
   * the selector is a single stable attribute (e.g. `[data-testid="foo"]`),
   * NEVER a long descendant chain.
   */
  selector?: string;
}

export interface InteractiveElementState {
  disabled: boolean;
  checked?: boolean;
  selected?: boolean;
  /** `aria-expanded` value for menus, combos, accordions. */
  expanded?: boolean;
}

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * How `browser_act` identifies its target element.
 *
 * Default — and the one we encourage the agent to reach for — is
 * `semantic`. The provider's resolver maps `{ text, role? }` to an
 * accessibility-tree node, and only one match is allowed; multi-match
 * returns `ambiguous_target` rather than silently picking.
 *
 * `element_id` is for follow-up actions in the same turn where the agent
 * already saw the element in a prior observation.
 *
 * `selector` is the escape hatch for pages with no accessible labels.
 * Inputs are passed verbatim to Playwright's `page.locator()`; supports
 * CSS and the `xpath=` prefix.
 */
export type Target =
  | { kind: 'semantic'; text: string; role?: string }
  | { kind: 'element_id'; elementId: string }
  | { kind: 'selector'; selector: string };

// ---------------------------------------------------------------------------
// Provider inputs
//
// Each `*Input` is the per-call payload the handler hands to the provider.
// `sessionId` threads through every call so a single provider singleton can
// fan out to per-session BrowserContexts.
// ---------------------------------------------------------------------------

export type WaitForOption = 'load' | 'domcontentloaded' | 'networkidle';

export type ActAction =
  | 'click'
  | 'fill'
  | 'press'
  | 'select'
  | 'hover'
  | 'scroll_to'
  | 'wait_for';

export interface OpenInput {
  sessionId: string;
  url: string;
  waitFor?: WaitForOption;
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
  action: ActAction;
  target: Target;
  /** Text to type (fill), key combo (press), or option value (select). */
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
  /** JSON Schema describing the target shape. */
  schema: Record<string, unknown>;
  /** Natural-language hint about what region of the page to extract from. */
  instruction?: string;
  /** Optional CSS selector to constrain extraction to a subtree. */
  scopeSelector?: string;
}

export interface CloseInput {
  sessionId: string;
}

/**
 * Input for `BrowserProvider.render()` — a one-shot, stateless content fetch.
 *
 * Invariant: unlike `OpenInput`, there is NO `sessionId`. A render runs in an
 * ephemeral BrowserContext that is created and torn down within the call, so
 * it never collides with — or disturbs — an interactive `browser_open` tab.
 */
export interface RenderInput {
  /** Absolute http(s) URL to navigate to. */
  url: string;
  /** Navigation timeout in ms. Provider defaults to 30000 when unset. */
  timeoutMs?: number;
  /** When navigation is considered complete. Provider defaults to `load`. */
  waitFor?: WaitForOption;
  /** Optional cancellation — aborting tears down the ephemeral context. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Provider results
// ---------------------------------------------------------------------------

/** Output of `BrowserProvider.render()` — the rendered DOM plus nav metadata. */
export interface RenderResult {
  /** Serialized DOM after load (post-JavaScript). */
  html: string;
  /** Final URL after any redirects. */
  finalUrl: string;
  /** HTTP status of the main-frame navigation, or null when none was produced. */
  httpStatus: number | null;
}

export interface ScreenshotResult {
  /** Absolute path under ~/.afk/state/witness/<sid>/browser/screenshots/. */
  path: string;
  bytes: number;
  width: number;
  height: number;
  /**
   * Base64-encoded raw image bytes (no `data:` URI prefix). Carried
   * separately from the witness sidecar so the tool handler can hand the
   * pixels to the model as an image content block.
   *
   * Invariant: NEVER embed this in any text/JSON the model sees — it is
   * megabytes of base64. The `browser_screenshot` handler maps it onto
   * `ToolResult.image` and keeps it out of `content`.
   */
  dataBase64: string;
  /** Media type of `dataBase64`. Playwright captures PNG. */
  mediaType: 'image/png';
}

export interface ExtractResult {
  /** Conforms to the input `schema`. */
  data: unknown;
  /** Soft notices the resolver wants to surface to the agent. */
  warnings?: string[];
}

/**
 * Disambiguation surface for semantic-target resolution.
 *
 * Returned by the provider when `act()` is called with a semantic target
 * that matches 2+ elements. The handler returns this as
 * `ToolResult.isError: true` and the agent retries with `element_id`.
 *
 * Invariant: this is never thrown — providers return it as a structured
 * outcome distinct from `BrowserObservation`, so the dispatcher's error
 * path remains reserved for true exceptions.
 */
export interface AmbiguousTarget {
  /** Sentinel kind so the handler can pattern-match without instanceof. */
  outcome: 'ambiguous_target';
  /** The semantic query the agent tried. */
  query: { text: string; role?: string };
  /** Candidate elements the agent can pick from. Capped at 5. */
  candidates: InteractiveElement[];
}

/**
 * Domain-policy refusal surface.
 *
 * Returned by `open()` (and any action that triggers navigation) when the
 * URL host fails the `AFK_BROWSER_ALLOWED_DOMAINS` / `BLOCKED_DOMAINS`
 * policy. The handler returns this as `ToolResult.isError: true`.
 */
export interface BlockedByPolicy {
  outcome: 'blocked_by_policy';
  url: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Provider introspection
//
// Surfaced to runtime-awareness (`get_runtime_state` Phase-2 `browser` view).
// Intentionally minimal — we don't want awareness coupled to provider impl.
// ---------------------------------------------------------------------------

export interface BrowserProviderState {
  /** True when the session has an open page. */
  active: boolean;
  /** Current page URL. `null` when no page is open. */
  url: string | null;
  /** Current page title. `null` when no page is open. */
  title: string | null;
  /** Last completed action tag (`browser_act:click`, `browser_open`, …). */
  lastAction: string | null;
  /** ISO timestamp of the last completed action. `null` if none yet. */
  lastActionAt: string | null;
  /** Number of open tabs for this session. Phase 1 stays at 0 or 1. */
  openTabs: number;
}

// ---------------------------------------------------------------------------
// Configuration (loaded by ./config.ts; consumed by the provider)
// ---------------------------------------------------------------------------

/**
 * Resolved browser-layer configuration. Constructed by `loadBrowserConfig()`
 * from env vars + optional `~/.afk/config/browser.json`. The provider gets
 * this once at construction; per-call options take precedence per-method.
 */
export interface BrowserConfig {
  /** Default headless setting. Overridden per-call via the provider. */
  headless: boolean;
  /** Allowlist of host globs. Empty means no allowlist (permissive). */
  allowedDomains: readonly string[];
  /** Blocklist of host globs. Empty means no blocklist. */
  blockedDomains: readonly string[];
  /** When true, every `browser_act` writes a gzipped DOM snapshot sidecar. */
  domSnapshots: boolean;
  /** Backend selection. Phase 1 only honors `'playwright'`. */
  backend: 'playwright';
  /** Optional path to a config JSON used to override anything above. */
  configPath: string | null;
  /**
   * Name of the persistent session-vault profile this process reuses. Session
   * contexts restore `storageState` from (and save it back to)
   * `~/.afk/state/browser/<defaultProfile>/storageState.json`, so an agent
   * reuses a human-authorized login across unattended runs. `'default'` when
   * unset (a fresh, empty profile — identical to pre-vault behavior).
   *
   * Resolved from `AFK_BROWSER_DEFAULT_PROFILE`. Operator-controlled, NOT a
   * per-call model choice: the human runs `afk browser login --profile <name>`
   * once, then points the agent at that profile via the env var.
   */
  defaultProfile: string;
}
