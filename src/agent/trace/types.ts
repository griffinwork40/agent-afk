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
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop';

export interface HookDecisionPayload {
  hookEvent: HookEventName;
  /** `undefined` when no hook emitted a decision (all handlers passed). */
  decision: 'block' | 'approve' | undefined;
  reason?: string;
  /** Set only when `hookEvent === 'PreToolUse'` and `decision === 'block'`. */
  blockedTool?: string;
  /** Set only when the hook returned `injectContext`. */
  injectedContextBytes?: number;
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
}

export interface SubagentSucceededPayload {
  transition: 'succeeded';
  subagentId: string;
  durationMs: number;
  turnCount: number;
  totalCostUsd?: number;
  outputBytes: number;
}

export interface SubagentFailedPayload {
  transition: 'failed';
  subagentId: string;
  errorClass: string;
  errorMessage: string;
  /** 0 when no partial output was captured before the failure. */
  partialOutputBytes: number;
}

export interface SubagentCancelledPayload {
  transition: 'cancelled';
  subagentId: string;
  /**
   * - `'cascade'` — cancelled because an ancestor's abort cascaded down.
   * - `'explicit'` — `cancel()` was called directly on this handle.
   */
  source: 'cascade' | 'explicit';
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

export type BackgroundAgentPayload =
  | BackgroundAgentStartedPayload
  | BackgroundAgentCompletedPayload
  | BackgroundAgentFailedPayload
  | BackgroundAgentCancelledPayload
  | BackgroundAgentJoinedPayload;

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
// session_phase — per-session latency waterfall markers.
//
// Most phases emit a `*_start`/`*_done` pair bracketing the phase; together
// they form a latency waterfall without changing operational behavior.
// `model_ttfb` is the exception: a single event per model API call carrying
// time-to-first-byte in `durationMs`.
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
  | 'model_ttfb';

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
