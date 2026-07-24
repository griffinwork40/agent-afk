/**
 * Witness-layer trace event types.
 *
 * This module defines the typed payload shapes for every trace event the
 * runtime emits. The shapes are the committed taxonomy referenced by
 * `docs/philosophy/afk-contract.md` — each `kind` and each payload field
 * is part of the contract, not free-form metadata.
 *
 * Two forms exist for the `compaction` event:
 *
 *   - **Input form** ({@link CompactionPayloadInput}) — what emission
 *     sites construct. Includes the full pre-compaction message slice
 *     inline. May be large (KB–MB).
 *
 *   - **Persisted form** ({@link CompactionPayloadPersisted}) — what
 *     the writer serializes to the JSONL line. Replaces the inline
 *     messages with a sidecar reference. Always small.
 *
 * The writer is responsible for the transform; emission sites only ever
 * see the Input form.
 *
 * @module agent/trace/types
 */

/** All trace event kinds — must match the contract doc. */
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
  | 'browser_event'
  | 'session_phase'
  | 'session_sealed';

// ---------------------------------------------------------------------------
// tool_call — emitted twice per tool dispatch (started, completed)
// ---------------------------------------------------------------------------

export interface ToolCallStartedPayload {
  phase: 'started';
  toolUseId: string;
  name: string;
  inputBytes: number;
  /** Present when the call originates inside a fork. */
  subagentId?: string;
}

// Invariant: this is the canonical source of truth for the failure-class
// vocabulary. `src/agent/trace/events.ts` imports this exact tuple to build
// the Zod `z.enum`, so the runtime validator and the TS type can never drift.
// Order is not load-bearing. Every value is set at a specific dispatcher or
// handler site (see ToolFailureClass JSDoc) and consumed by
// `src/improve/scan/detectors/tool-failure-density.ts`.
export const TOOL_FAILURE_CLASSES = [
  'policy-refusal',
  'timeout',
  'permission-denied',
  'hook-block',
  'abort',
  'elicitation-declined',
  'denial-breaker',
] as const;

/**
 * Coarse classification of WHY a tool returned `isError: true`. Optional and
 * additive: a result with no `failureClass` is an unclassified failure (the
 * pre-classification default — a handler bug, malformed input, etc.).
 *
 * Set at the site that produced the error:
 *   - `policy-refusal`       — browser handler refused nav (domain allowlist). NOT a bug.
 *   - `timeout`              — a bounded operation exceeded its deadline: a browser
 *                              navigation/action past its per-action timeout, OR a
 *                              forked sub-agent whose own wall-clock budget
 *                              (SUBAGENT_DEFAULT_TIMEOUT_MS / config.timeoutMs) expired
 *                              and `withTimeout` aborted its controller. Annotated on the
 *                              subagent_lifecycle `failed` payload (own-budget expiry)
 *                              and, for a cascaded ancestor-timeout, via the `cancelled`
 *                              payload's `timeout` flag.
 *   - `permission-denied`    — permission gate or read-only-skill bash gate denied the call.
 *   - `hook-block`           — a PreToolUse hook returned `decision: 'block'`.
 *   - `abort`                — the call's AbortSignal was already fired.
 *   - `elicitation-declined` — `ask_question` returned `decline` (no handler / surface
 *                              cannot reach a human) or `cancel` (operator dismissed the
 *                              prompt). An unanswered question is an expected outcome on a
 *                              non-interactive or AFK surface, NOT a tool fault.
 *   - `denial-breaker`       — a forked sub-agent tripped the denial circuit breaker
 *                              (`denial-circuit-breaker.ts`): N consecutive path-approval
 *                              read denials with no progress, so it was aborted fast rather
 *                              than at its wall-clock budget. Deliberately NOT exempt below
 *                              — a fork torn down for spinning is a review-worthy event the
 *                              parent should act on (re-dispatch with a wider read scope).
 *
 * The `tool-failure-density` detector treats `policy-refusal`, `permission-denied`,
 * `hook-block`, `abort`, and `elicitation-declined` as "the system correctly said no" —
 * excluded from failure stats entirely — while `timeout`, `denial-breaker`, and
 * unclassified failures still count.
 */
export type ToolFailureClass = (typeof TOOL_FAILURE_CLASSES)[number];

export interface ToolCallCompletedPayload {
  phase: 'completed';
  toolUseId: string;
  name: string;
  resultBytes: number;
  isError: boolean;
  /** True when the result hit the dispatcher's truncation sentinel. */
  truncated: boolean;
  /** Wall-clock duration from `started` → `completed`, in milliseconds. */
  durationMs: number;
  /** True when this completed event was produced by the repeat-loop circuit breaker,
   *  not by a real tool dispatch — lets detectors exclude it from failure stats. */
  circuitBreaker?: boolean;
  /** Coarse failure classification when `isError` is true. Absent on success
   *  and on unclassified failures. See {@link ToolFailureClass}. */
  failureClass?: ToolFailureClass;
  /**
   * Concurrency-batch membership: 1-based position (`batchIndex`) and total
   * size (`batchSize`) of the batch this call was dispatched in, set by the
   * dispatcher's `executeBatch`. `batchSize > 1` means the call ran in a
   * parallel wave; `batchSize === 1` means it ran alone in its own sequential
   * batch (always the case for concurrency-unsafe tools like bash). Lets
   * `afk trace show` and failure-analysis distinguish real parallelism from
   * back-to-back sequential dispatch. Absent on the single-tool `execute()`
   * path and on blocked/short-circuited calls.
   */
  batchIndex?: number;
  batchSize?: number;
  subagentId?: string;
}

export type ToolCallPayload = ToolCallStartedPayload | ToolCallCompletedPayload;

// ---------------------------------------------------------------------------
// hook_decision — emitted from inside the hook registry's dispatch loop
// ---------------------------------------------------------------------------

/** Subset of hook event names the writer cares about. Extend as new
 *  events become traceable. */
export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop';

/**
 * Fine-grained outcome of the AFK high-risk approval gate. Set only by that
 * gate; absent on all other hook_decision events.
 *
 * `hard-block` is the no-prompt refusal: the op was blocked WITHOUT soliciting
 * an operator approval at all — either a forked sub-agent (which must never
 * prompt, for lack of attribution) or the always-on Telegram host
 * (`afkPromptForApproval:false`). It is distinct from `denied` (operator saw the
 * prompt and rejected) so async review can tell a deliberate human deny from an
 * automatic ceiling refusal.
 */
export type AfkApprovalOutcome =
  | 'approved'
  | 'denied'
  | 'unrecognised'
  | 'timeout'
  | 'decline'
  | 'cancel'
  | 'hard-block';

export interface HookDecisionPayload {
  hookEvent: HookEventName;
  /**
   * `undefined` when no hook emitted a decision (all handlers passed). This is
   * the common pass-through case. Optional (not `: 'block' | 'approve' | undefined`)
   * because JSON.stringify drops undefined-valued keys: a persisted line has no
   * `decision` key, and the reader's schema must validate that absent-key form.
   */
  decision?: 'block' | 'approve';
  reason?: string;
  /** Set only when `hookEvent === 'PreToolUse'` and `decision === 'block'`. */
  blockedTool?: string;
  /** Set only when the hook returned `injectContext`. */
  injectedContextBytes?: number;
  /** Set only by the AFK high-risk approval gate. Wall-clock ms from gate entry to decision. */
  durationMs?: number;
  /** Set only by the AFK high-risk approval gate. Fine-grained approval outcome. */
  approvalOutcome?: AfkApprovalOutcome;
}

// ---------------------------------------------------------------------------
// subagent_lifecycle — one transition per event, four variants
// ---------------------------------------------------------------------------

export interface SubagentStartedPayload {
  transition: 'started';
  subagentId: string;
  parentId: string;
  model: string;
  allowedTools?: readonly string[];
  /** SHA-256 hex digest of the child's system prompt, for audit. */
  systemPromptHash?: string;
  /**
   * First 80 chars of the dispatch prompt, for at-a-glance forensics — lets a
   * trace reader see WHAT a child was asked to do without opening the child's
   * own transcript. Absent when the fork site had no prompt in scope (e.g. a
   * skill/compose fork whose prompt is threaded later). Truncated at the
   * emit site.
   */
  promptHead?: string;
  /**
   * The effective agent type / render label for this fork (e.g. a named
   * `research-agent`, a compose node label, or a prompt-derived slice). Present
   * so a reader can attribute a lifecycle event to a role without cross-refing
   * the routing telemetry. Absent when no label was resolved.
   */
  agentType?: string;
}

export interface SubagentSucceededPayload {
  transition: 'succeeded';
  subagentId: string;
  durationMs: number;
  turnCount: number;
  totalCostUsd?: number;
  outputBytes: number;
  /**
   * Terminal stop reason for the subagent's final turn, when known. Present so
   * a trace reader can distinguish a clean completion from a capped/truncated
   * partial (`tool_use_loop_capped` / `stream_incomplete`) that was surfaced
   * with `succeeded` status. Absent when the provider reported no stop reason.
   */
  stopReason?: string;
}

export interface SubagentFailedPayload {
  transition: 'failed';
  subagentId: string;
  errorClass: string;
  errorMessage: string;
  /** 0 when no partial output was captured before the failure. */
  partialOutputBytes: number;
  /**
   * Coarse failure classification, mirroring {@link ToolFailureClass}. Set to
   * `'timeout'` when this failure is the handle's OWN wall-clock budget expiry
   * (a `TimeoutError` abort on its controller that is NOT a cascade) — lets a
   * trace reader tell a guillotined-by-budget child apart from a genuine error.
   * Absent for unclassified failures (the pre-classification default).
   */
  failureClass?: ToolFailureClass;
}

export interface SubagentCancelledPayload {
  transition: 'cancelled';
  subagentId: string;
  /**
   * - `'cascade'` — cancelled because an ancestor's abort cascaded down.
   * - `'explicit'` — `cancel()` was called directly on this handle.
   */
  source: 'cascade' | 'explicit';
  /**
   * `true` when the cascade that cancelled this handle originated from a
   * `TimeoutError` (an ANCESTOR's wall-clock budget expired and the abort
   * cascaded down to this descendant). Distinguishes a timeout-driven cascade
   * cancel from an ordinary explicit/parent cancel. Only ever set on
   * `source: 'cascade'`; absent otherwise.
   */
  timeout?: boolean;
}

export type SubagentLifecyclePayload =
  | SubagentStartedPayload
  | SubagentSucceededPayload
  | SubagentFailedPayload
  | SubagentCancelledPayload;

// ---------------------------------------------------------------------------
// background_agent — durable witness for fire-and-forget subagent jobs
// dispatched via `agent` tool with `mode: 'background'`. Distinct from
// `subagent_lifecycle`, which covers the foreground (awaited) path. The
// rationale for a separate kind: an agent operator scanning the trace
// should be able to grep for `background_agent` and see every unattended
// job's full lifecycle without filtering against join/cancel timing.
// ---------------------------------------------------------------------------

export interface BackgroundAgentStartedPayload {
  transition: 'started';
  /** Stable id assigned by `BackgroundAgentRegistry.register()`. */
  jobId: string;
  /** Underlying `SubagentHandle.id` for cross-correlation with subagent_lifecycle. */
  subagentId: string;
  /** Truncated first 80 chars of the prompt for at-a-glance audit. */
  label: string;
  model: string;
}

export interface BackgroundAgentCompletedPayload {
  transition: 'completed';
  jobId: string;
  subagentId: string;
  durationMs: number;
  outputBytes: number;
}

export interface BackgroundAgentFailedPayload {
  transition: 'failed';
  jobId: string;
  subagentId: string;
  durationMs: number;
  errorClass: string;
  errorMessage: string;
}

export interface BackgroundAgentCancelledPayload {
  transition: 'cancelled';
  jobId: string;
  subagentId: string;
  /** `'explicit'` — `/bgsub:cancel` or `registry.cancelJob()`. `'cascade'` — parent abort. */
  source: 'explicit' | 'cascade';
}

export interface BackgroundAgentJoinedPayload {
  transition: 'joined';
  jobId: string;
  subagentId: string;
  /** Terminal status at the moment of join. */
  jobStatus: 'completed' | 'failed' | 'cancelled';
}

export interface BackgroundAgentDeliveredPayload {
  /** Result auto-delivered into the parent conversation by a surface notifier
   *  (BgResultNotifier) — distinct from an explicit `joined`. */
  transition: 'delivered';
  jobId: string;
  subagentId: string;
  /** Terminal status at the moment of delivery. */
  jobStatus: 'completed' | 'failed' | 'cancelled';
}

export type BackgroundAgentPayload =
  | BackgroundAgentStartedPayload
  | BackgroundAgentCompletedPayload
  | BackgroundAgentFailedPayload
  | BackgroundAgentCancelledPayload
  | BackgroundAgentJoinedPayload
  | BackgroundAgentDeliveredPayload;

// ---------------------------------------------------------------------------
// budget — threshold record. Closure handles termination separately.
// ---------------------------------------------------------------------------

export interface BudgetPayload {
  /** Today only `'monetary'`. Reserved for future structural-limit kinds. */
  kind: 'monetary';
  runningCostUsd: number;
  maxBudgetUsd: number;
  /** Cost of the turn that triggered the breach. */
  lastTurnCostUsd: number;
}

// ---------------------------------------------------------------------------
// abort — emitted once per cascade origin
// ---------------------------------------------------------------------------

/**
 * Discriminated abort cause. See {@link AbortPayload.origin}.
 *
 * - `user_signal`  — explicit caller cancellation (handle.cancel, manager
 *                    abortAll without a richer origin, user-typed SIGINT).
 * - `cascade`      — this node was aborted because an ancestor's abort
 *                    cascaded down. The cascadedTo field on the originating
 *                    abort lists every node the cascade reached.
 * - `timeout`      — a `withTimeout` wrapper fired the controller.
 * - `budget`       — the session-cost ceiling crossed and `abortBudget`
 *                    fired the controller.
 * - `hook_block`   — a hook returned `decision: 'block'` and the harness
 *                    routed the block through the abort path.
 */
export type AbortOrigin =
  | 'user_signal'
  | 'cascade'
  | 'timeout'
  | 'budget'
  | 'hook_block';

export interface AbortPayload {
  /**
   * What triggered the abort. The origin is best-effort — `cascade` means
   * this node was aborted because an ancestor's abort cascaded down, so
   * the `cascadedTo` field will be empty (the cascade origin emits the
   * full list).
   */
  origin: AbortOrigin;
  /** Subagent ids the abort graph attempted to cancel. May differ from
   *  the set that actually reached `cancelled` state — see
   *  `subagent_lifecycle` events for ground truth. */
  cascadedTo: readonly string[];
  reason?: string;
}

// ---------------------------------------------------------------------------
// compaction — two forms (see module JSDoc)
// ---------------------------------------------------------------------------

export type CompactionTrigger = 'manual' | 'token_threshold' | 'turn_count';

/** Input form — what emission sites construct. Carries the full
 *  pre-compaction slice inline. The writer transforms this into the
 *  persisted form by writing the slice to a sidecar. */
export interface CompactionPayloadInput {
  trigger: CompactionTrigger;
  /** Full-fidelity message slice that compaction is about to discard
   *  from working memory. Typed `unknown[]` to keep the trace module
   *  provider-agnostic; emitters serialize whatever shape they hold. */
  preCompactionMessages: unknown[];
  summary: string;
  keptTailCount: number;
  keepLastNConfig: number;
  messagesBefore: number;
  messagesAfter: number;
  tokensSavedEstimate?: number;
  summarizationTokens?: { input: number; output: number };
}

/** Reference to a sidecar file holding the full-fidelity pre-compaction
 *  slice. The path is absolute. */
export interface CompactionSidecarRef {
  /** Absolute path to the sidecar JSON file. */
  path: string;
  sizeBytes: number;
  /** SHA-256 hex digest of the sidecar contents, for integrity. */
  sha256: string;
}

/** Persisted form — what ends up on the JSONL line. */
export interface CompactionPayloadPersisted {
  trigger: CompactionTrigger;
  preCompactionMessagesRef: CompactionSidecarRef;
  summary: string;
  keptTailCount: number;
  keepLastNConfig: number;
  messagesBefore: number;
  messagesAfter: number;
  tokensSavedEstimate?: number;
  summarizationTokens?: { input: number; output: number };
}

// ---------------------------------------------------------------------------
// closure — terminal record for the session loop
// ---------------------------------------------------------------------------

export type ClosureReason =
  | 'model_end_turn'
  // Model's final turn was cut off by the output-token ceiling
  // (Anthropic `max_tokens` / OpenAI `length`), not a clean completion.
  | 'truncated'
  | 'iteration_cap'
  | 'abort'
  | 'timeout'
  | 'budget_exceeded'
  | 'hook_blocked'
  | 'max_turns_exceeded';

export interface ClosurePayload {
  reason: ClosureReason;
  finalTurnCount: number;
  finalCostUsd: number;
  finalTokens: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
  /** Raw `stop_reason` from the provider, when available. */
  lastStopReason?: string;
  /**
   * Actionable recovery hint for an anomalous closure, attached by
   * `emitClosure` via the `closure-anomaly` guardrail (`closure-guidance.ts`).
   * Absent for benign closes and anomalous reasons not yet covered.
   */
  guidance?: string;
}

// ---------------------------------------------------------------------------
// claim — structured assertion emitted by any agent / skill / verifier
// ---------------------------------------------------------------------------

export interface ClaimPayload {
  /** The asserting agent: parent session, fork id, skill name, etc. */
  source: string;
  /** Free-text assertion. */
  assertion: string;
  /** Evidence references (file:line, urls, fact ids, etc.). */
  evidence: readonly string[];
  /** 0.0–1.0 self-reported confidence. */
  confidence: number;
  /** Optional contrarian view from a verifier or sibling claim. */
  dissent?: string;
}

// ---------------------------------------------------------------------------
// browser_event — domain-specific witness for native browser-control tools.
//
// Invariant: this is the BROWSER-DOMAIN record (URL transitions, action
// outcomes, screenshot paths). The generic `tool_call` events already cover
// every browser tool's call/return at the dispatcher boundary — emitting
// browser_event in ADDITION lets a reader scan only browser-domain semantics
// without filtering tool_call by name. Both kinds reference the same
// `toolUseId` for correlation.
//
// The full BrowserObservation is NOT persisted here (would balloon the trace
// file on long sessions). Screenshots are sidecar files referenced by path —
// mirrors the compaction sidecar pattern.
// ---------------------------------------------------------------------------

/** Which browser tool emitted the event. */
export type BrowserEventTool =
  | 'browser_open'
  | 'browser_observe'
  | 'browser_act'
  | 'browser_screenshot'
  | 'browser_extract'
  | 'browser_close';

/** Sub-discriminator for `browser_act`. Mirrors {@link ActInput.action}
 *  in `src/browser/types.ts` — keep in sync. */
export type BrowserActAction =
  | 'click'
  | 'fill'
  | 'press'
  | 'select'
  | 'hover'
  | 'scroll_to'
  | 'wait_for';

/** Sanitized target reference. The raw selector contents are NEVER persisted
 *  here — only a hash — because a user-supplied selector can embed secrets
 *  (e.g. an attribute selector matching a CSRF token). Semantic text is
 *  truncated to 80 chars. */
export interface BrowserEventTarget {
  kind: 'semantic' | 'element_id' | 'selector';
  /** Set only when `kind === 'semantic'`. Truncated to 80 chars. */
  text?: string;
  /** ARIA role, when supplied by the agent. */
  role?: string;
  /** Set only when `kind === 'element_id'`. */
  elementId?: string;
  /** Set only when `kind === 'selector'`. SHA-256 hex digest, first 8 chars. */
  selectorHash?: string;
}

export interface BrowserEventPayload {
  /** Which browser tool ran. */
  tool: BrowserEventTool;

  /** `browser_act` sub-discriminator. Absent for other tools. */
  action?: BrowserActAction;

  /** Correlates with the surrounding `tool_call` started/completed events. */
  toolUseId: string;

  /** What the action targeted. Absent for tools that don't take a target
   *  (`browser_open`, `browser_observe`, `browser_close`). */
  target?: BrowserEventTarget;

  /** Page URL captured BEFORE the action took effect. `null` if no page is
   *  open yet (e.g. the open() call itself). */
  urlBefore: string | null;

  /** Page URL captured AFTER. Equal to `urlBefore` for non-navigating
   *  actions. `null` if the browser is now closed. */
  urlAfter: string | null;

  /** Outcome bucket.
   *  - `'ok'`                 — call completed without error.
   *  - `'error'`              — provider call rejected; `error` populated.
   *  - `'ambiguous_target'`   — semantic resolver found multiple matches.
   *  - `'blocked_by_policy'`  — domain allowlist / blocklist refused. */
  status: 'ok' | 'error' | 'ambiguous_target' | 'blocked_by_policy';

  /** Absolute path to the screenshot sidecar under
   *  `~/.afk/state/witness/<sid>/browser/screenshots/`.
   *  Always present on `status === 'error'`. Otherwise present iff the
   *  caller passed `screenshot: true`. */
  screenshotPath?: string;

  /** Compressed observation summary — ≤500 chars. The full observation
   *  is NOT persisted in witness; only the tool's stringified result
   *  (in the surrounding `tool_call.completed` payload) carries it. */
  observationSummary?: string;

  /** Error detail populated when `status === 'error'`. */
  error?: { reason: string; recoverable: boolean };

  /** Wall-clock duration of the underlying provider call. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Invariant: session_phase — per-session latency waterfall markers AND the
// root session's model-provenance anchor.
//
// Most phases emit a `*_start`/`*_done` pair bracketing the phase; together
// they form a latency waterfall without changing operational behavior.
// `model_ttfb` is the exception: a single event per model API call carrying
// time-to-first-byte in `durationMs`.
//
// Model provenance: `session_init_start` carries the session's `model` (the
// operator-typed alias) and `resolvedModel` (the wire id). It is emitted in
// the AgentSession constructor — provider-agnostic and the earliest event —
// so EVERY trace is self-identifying about its root model even with no
// subagents and no completed API call. `model_ttfb` additionally carries the
// `resolvedModel` for THAT call, capturing mid-session overrides/switches.
// (Child forks already record their model on `subagent_lifecycle.started`.)
//
// Chronological: bootstrap → session_init → mcp_connect → mcp_server (per
// server) → loop (per turn); model_ttfb fires per model call inside a turn.
//
// Deferred (no trace writer in scope at the call site — see PR notes):
// worktree_setup, boot_prune, plugin_scan, skill_manifest.
// ---------------------------------------------------------------------------

/** Instrumented lifecycle phases. Most appear twice — once as `*_start`,
 *  once as `*_done`. `model_ttfb` is a singleton (no paired start). */
export type SessionPhaseName =
  | 'bootstrap_start'
  | 'bootstrap_done'
  | 'session_init_start'
  | 'session_init_done'
  | 'mcp_connect_start'
  | 'mcp_connect_done'
  | 'mcp_server_start'
  | 'mcp_server_done'
  | 'loop_start'
  | 'loop_end'
  | 'model_ttfb'
  // Interrupt→halt latency. A SINGLE event (no paired start) emitted on the
  // turn's abort path when an ESC soft-stop (`interrupt()`) is what ended the
  // stream, carrying in `durationMs` the wall-clock from the abort signal firing
  // to the terminal `turn.completed` being emitted. This is the field-visible
  // proof of the ESC-lag fix: `abortableStream` races each stream pull against
  // the interrupt so the halt lands within an event-loop turn instead of lagging
  // seconds behind the keypress. Emitted fire-and-forget by both the
  // anthropic-direct and openai-compatible loops; absent on non-interrupted
  // turns and on a session `close()` (only a user/turn interrupt qualifies).
  | 'interrupt_halt'
  | 'rate_limit'
  // OAuth subscription usage-limit park/unpark. Unlike `rate_limit` (a short,
  // bounded retry-after backoff), these bracket a potentially multi-HOUR pause
  // while the turn waits for the subscription window to reset (or a keychain
  // hot-swap). `usage_limit_resume` carries the parked `durationMs`. Emitted as
  // a pair, but a pause may end without a resume (auto-resume off, abort, or the
  // 2-hour cap surfacing the error) — so a lone `usage_limit_pause` is expected.
  | 'usage_limit_pause'
  | 'usage_limit_resume'
  // Progress-aware idle watchdog fired on a forked sub-agent turn: the child
  // produced no observable OutputEvent for the idle window and its controller
  // was aborted (see subagent/idle-watchdog.ts). A single event (no paired
  // start); carries `idleTimeoutMs`, `elapsedSinceLastProgressMs`, and
  // `lastEventType` in `metadata`. Distinct from `rate_limit`/`usage_limit_*`,
  // which mark LEGITIMATE waits — this marks an unexplained stall that fired.
  | 'idle_watchdog_fired'
  // OBSERVE-ONLY loop telemetry (see tools/suspected-loop-detector.ts): a
  // FORKED sub-agent issued the same (tool, normalized-args) fingerprint
  // >= N times within the last M tool rounds on one dispatcher (per-turn).
  // A single event (no paired start), emitted AT MOST ONCE per detected loop
  // (debounced), carrying `tool`, `count`, and `windowSize` in `metadata`.
  // PURE OBSERVABILITY: unlike the repeat/denial circuit breakers, this NEVER
  // aborts the fork, sets a failureClass, or alters a tool result — it only
  // records that a genuine (tool,args) repetition was observed, so we can
  // measure whether real busy-loops occur before deciding if an enforcing
  // detector is ever warranted. Distinct from `idle_watchdog_fired` (a stall
  // with NO output) — this marks the opposite: a fork actively repeating work.
  | 'suspected_loop';

export interface SessionPhasePayload {
  /** Which lifecycle milestone this record marks. */
  phase: SessionPhaseName;
  /**
   * Wall-clock milliseconds elapsed from the paired `*_start` event.
   * Present on all `*_done` variants; absent on `*_start` variants.
   */
  durationMs?: number;
  /** Phase-specific diagnostic context (e.g. MCP server count on connect). */
  metadata?: Record<string, string | number | boolean>;
  /**
   * Operator-typed model identifier as configured for the session (e.g.
   * `"sonnet"`, `"gpt-4o"`, `"mlx-community/…"`). Set on `session_init_start`
   * — the always-emitted, provider-agnostic attribution anchor — so a trace
   * names its root model even with zero subagents and zero completed calls.
   */
  model?: string;
  /**
   * Resolved wire model id the provider actually calls (e.g.
   * `"claude-sonnet-4-…"`). Set on `session_init_start` (the session default,
   * via `resolveModelId`) and on each `model_ttfb` (the id for THAT call —
   * captures mid-session model overrides/switches). Equals `model` when no
   * alias expansion applies (most non-Claude / raw ids).
   */
  resolvedModel?: string;
  /**
   * User-facing surface that produced this session. Set on `session_init_start`
   * (the always-emitted attribution anchor) so trace-only analysis can answer
   * "which entrypoint produced this work?" without consulting any sidecar.
   * Derived from the session's `surface` (repl collapses to 'cli'); a forked
   * subagent inherits its parent's origin. `'unknown'` when the surface was
   * never set. Orthogonal to the JSONL telemetry `surface: 'afk'|'plugin'`
   * provenance tag — that names the WRITER ecosystem, this names the entrypoint.
   */
  origin?: 'cli' | 'telegram' | 'daemon' | 'unknown';
  /**
   * Actor role that produced this session. Set on `session_init_start`:
   * `'main'` for a top-level session, `'subagent'` for a forked child
   * (derived from `parentSessionId`). Answers "main session or subagent?"
   * orthogonally to `origin` — a subagent forked under a Telegram session is
   * `{ origin: 'telegram', actor: 'subagent' }`.
   */
  actor?: 'main' | 'subagent';
}

// ---------------------------------------------------------------------------
// session_sealed — terminal record. Marks the trace file sealed-clean.
// ---------------------------------------------------------------------------

export interface SessionSealedPayload {
  status: 'succeeded' | 'failed' | 'cancelled';
  finalCostUsd: number;
  finalTurnCount: number;
  /** ISO-8601. When known, mirrors the closure event's wall-clock. */
  closedAt: string;
  /**
   * True when this seal was written by the synchronous process-exit
   * backstop ({@link NdjsonTraceWriter}) rather than by a normal
   * `AgentSession.close()`. Signals that the process exited abnormally —
   * crash, early-EOF before the REPL's close handler attached, or a
   * `process.exit()` that bypassed cleanup — so the session never reached
   * a clean terminal classification. `status` is `'failed'` and the
   * `final*` counters are last-known-from-the-writer (0 when the session
   * had no completed turns), NOT a reconstructed total. Omitted on every
   * normal seal.
   */
  incomplete?: boolean;
  /** Number of subagent forks that reached `succeeded` status this session. */
  subagentCount?: number;
  /**
   * Cumulative token counts across all completed subagents.
   * Omitted when no subagent completed or no usage was reported.
   */
  subagentTokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
  /**
   * Cumulative USD cost rolled up from all completed subagents.
   * Omitted when no cost data was available (e.g. all subagents used the
   * free tier or providers that don't report cost).
   */
  subagentCostUsd?: number;
}

// ---------------------------------------------------------------------------
// Discriminated unions
// ---------------------------------------------------------------------------

/** What emission sites pass to `TraceWriter.write()`. The writer adds
 *  `ts` and `seq`, and for `compaction` events, writes the sidecar and
 *  swaps the payload for the persisted form. */
export type TraceEventInput =
  | { kind: 'tool_call'; payload: ToolCallPayload }
  | { kind: 'hook_decision'; payload: HookDecisionPayload }
  | { kind: 'subagent_lifecycle'; payload: SubagentLifecyclePayload }
  | { kind: 'background_agent'; payload: BackgroundAgentPayload }
  | { kind: 'budget'; payload: BudgetPayload }
  | { kind: 'abort'; payload: AbortPayload }
  | { kind: 'compaction'; payload: CompactionPayloadInput }
  | { kind: 'closure'; payload: ClosurePayload }
  | { kind: 'claim'; payload: ClaimPayload }
  | { kind: 'browser_event'; payload: BrowserEventPayload }
  | { kind: 'session_phase'; payload: SessionPhasePayload };

/** What ends up on disk and in readers. `session_sealed` is terminal
 *  and only the writer constructs it (via `seal()`); it is not part of
 *  the input union. */
export type TraceEvent =
  | { ts: string; seq: number; kind: 'tool_call'; payload: ToolCallPayload }
  | { ts: string; seq: number; kind: 'hook_decision'; payload: HookDecisionPayload }
  | { ts: string; seq: number; kind: 'subagent_lifecycle'; payload: SubagentLifecyclePayload }
  | { ts: string; seq: number; kind: 'background_agent'; payload: BackgroundAgentPayload }
  | { ts: string; seq: number; kind: 'budget'; payload: BudgetPayload }
  | { ts: string; seq: number; kind: 'abort'; payload: AbortPayload }
  | { ts: string; seq: number; kind: 'compaction'; payload: CompactionPayloadPersisted }
  | { ts: string; seq: number; kind: 'closure'; payload: ClosurePayload }
  | { ts: string; seq: number; kind: 'claim'; payload: ClaimPayload }
  | { ts: string; seq: number; kind: 'browser_event'; payload: BrowserEventPayload }
  | { ts: string; seq: number; kind: 'session_phase'; payload: SessionPhasePayload }
  | { ts: string; seq: number; kind: 'session_sealed'; payload: SessionSealedPayload };
