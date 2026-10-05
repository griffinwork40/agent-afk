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
  | 'queued_user_message'
  | 'peer_message'
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
  /**
   * SHA-256 hex digest of `JSON.stringify(input ?? {})` — a deterministic
   * content hash of the raw tool arguments. Enables exact deduplication
   * across sibling subagents (e.g. "did two children read the same file?")
   * without storing the full args blob in the trace.
   *
   * Always present on new traces (the builder always emits it). Optional
   * for backward compat with traces recorded before this field was added.
   *
   * Replaces the proxy fingerprint (`v1-bytes-tuple`) that
   * `repeated-tool-use.ts` derived from `(name, inputBytes, resultBytes,
   * isError, subagentId)` — that scheme false-collided on unrelated calls
   * with identical byte counts.
   */
  argsFingerprint?: string;
  /**
   * SHA-256 hex digest of the **normalized resource identifier** alone,
   * stripping arguments that don't change which resource is accessed (e.g.
   * offset/limit on `read_file`). Enables cross-agent file-overlap measurement
   * without inflating the count when two agents read the same file at different
   * offsets.
   *
   * Present only for tools that access a nameable resource (`read_file` uses
   * the normalized `file_path`). Absent for tools with no single identifiable
   * resource or for traces recorded before this field was added.
   *
   * Privacy: contains a hash, never a raw path -- same boundary as
   * `argsFingerprint`.
   */
  resourceFingerprint?: string;
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
  'budget',
  'permission-denied',
  'hook-block',
  'abort',
  'elicitation-declined',
  'denial-breaker',
  /** A call refused after N consecutive identical failures (#723). */
  'repeat-failure',
  /** The target the tool was asked to operate on does not exist (#75 follow-up). */
  'no-such-target',
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
 *   - `budget`               — the session-wide cost ceiling aborted the call. Like `timeout`,
 *                              this is deliberately non-benign and remains visible in stats.
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
 *   - `no-such-target`       — the tool was asked to operate on a target (a path, most
 *                              commonly) that does not exist, so nothing was actually
 *                              searched/read. Set at the handler that stat'd or spawned
 *                              against the target (e.g. grep's exit-2 ripgrep branch,
 *                              see `_rg-exit2.ts`). The caller supplied a bad reference —
 *                              not a tool fault — so the fix is to correct the target,
 *                              not to retry the same call.
 *
 * The `tool-failure-density` detector treats `policy-refusal`, `permission-denied`,
 * `hook-block`, `abort`, `elicitation-declined`, and `no-such-target` as "the system
 * correctly said no" — excluded from failure stats entirely — while `timeout`, `budget`,
 * `denial-breaker`, and unclassified failures still count. That split is
 * `BENIGN_FAILURE_CLASSES` below.
 */
export type ToolFailureClass = (typeof TOOL_FAILURE_CLASSES)[number];

/**
 * The failure classes that mean "the system correctly said no", as opposed to
 * "the tool broke". Every member returns `isError: true` so the model sees the
 * outcome and can adapt — but none of them is a fault worth alarming a human
 * about.
 *
 * Single source of truth for two consumers that must not drift apart:
 *   - `src/improve/scan/detectors/tool-failure-density.ts` excludes these from
 *     failure-rate stats, so a `browser_open` that refused half its navigations
 *     on domain policy does not look 50% broken.
 *   - `src/cli/commands/interactive/tool-lane-format.ts` renders these with a
 *     neutral `⊘` instead of a red `✗`, so an agent probing a gated tool during
 *     a long run does not read as something going wrong (#75).
 *
 * Members: `policy-refusal`, `permission-denied`, `hook-block`, `abort`,
 * `elicitation-declined`, `no-such-target`.
 *
 * Membership is deliberately narrower than "not the tool's fault". `timeout` is
 * excluded because a high timeout rate is a real problem (too tight a deadline,
 * a systematically slow target), and `denial-breaker` is excluded because a fork
 * torn down for spinning is review-worthy — see the per-class notes above.
 * `no-such-target` IS included: a nonexistent path is a caller-supplied bad
 * reference (a typo, stale memory of a moved file, ordinary exploration), not
 * evidence the tool is broken. An unclassified failure (no `failureClass`) is
 * never benign: pre-classification traces and genuine handler bugs share that
 * shape, so it must stay alarming.
 */
export const BENIGN_FAILURE_CLASSES: ReadonlySet<ToolFailureClass> = new Set([
  'policy-refusal',
  'permission-denied',
  'hook-block',
  'abort',
  'elicitation-declined',
  'no-such-target',
]);

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
  /**
   * True when this result carries a subagent's partial/incomplete answer —
   * the child hit its tool-use iteration cap or its stream was cut off
   * mid-flight. Mirrors `ToolResult.incomplete` (see `providers/anthropic-direct/
   * types.ts`); absent for a clean completion or any non-subagent tool.
   */
  incomplete?: boolean;
  /**
   * The subagent's `stopReason` that produced `incomplete: true` (e.g.
   * `tool_use_loop_capped`, `stream_incomplete`). Present only alongside
   * `incomplete: true`; absent otherwise.
   */
  incompleteReason?: string;
  /** True when this completed event was produced by the repeat-loop circuit breaker,
   *  not by a real tool dispatch — lets detectors exclude it from failure stats. */
  circuitBreaker?: boolean;
  /** Coarse failure classification when `isError` is true. Absent on success
   *  and on unclassified failures. See {@link ToolFailureClass}. */
  failureClass?: ToolFailureClass;
  /**
   * First ≤200 characters of the error text when `isError` is true and the
   * result carried a non-empty content string. Absent on success, absent when
   * the error content is empty. Truncated with `… (truncated)` when the raw
   * text exceeds the cap; newlines collapsed to spaces; passed through
   * {@link import('../redact-secrets.js').redactSecrets} so common token
   * shapes are replaced with `[REDACTED]`.
   *
   * Design tradeoff: traces are local-only files under `~/.afk/state/witness/`
   * so egress is not a concern, but tool output can contain incidental secrets
   * (the model read a file with an embedded token and echoed it in a shell
   * error, for example). The 200-char cap limits exposure; regex redaction
   * catches common patterns but is not exhaustive (connection strings, PEM
   * blocks, and PII are not caught). The field is meant to classify failure
   * *kind* (stale edit, wrong path, etc.) not to reconstruct the full output.
   *
   * Old traces without this field validate fine — the field is `optional`.
   */
  errorHead?: string;
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
  /**
   * Structured test-runner result when the tool result carries one (e.g.
   * `test_run` or a `bash` test invocation that `detectTestResult` parsed).
   * Lets trace consumers react to pass/fail counts without scanning `content`.
   * Absent on non-test tool calls.
   */
  testResult?: import('../tools/handlers/test-runner-detector.js').TestResult;
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
  | 'Stop'
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
  | 'carve-out'
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
  /**
   * Present when the decision was made inside a fork — mirrors
   * {@link ToolCallStartedPayload.subagentId} so a block can be attributed to
   * the child that provoked it. Absent on top-level decisions.
   *
   * History: without this, a denial could only be counted, never attributed. An
   * audit of 12,108 traces (2026-07-26) misattributed 268 child `bash` denials
   * to path containment because the dominant source — the read-only bash gate —
   * emitted no event at all and nothing tied blocks to a child. See
   * docs/decisions/0001-bash-tool-path-containment.md for the containment model.
   */
  subagentId?: string;
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
   *
   * NOTE: this is a *display label*, not a clean type — it is a 3-leg fallback
   * (registered name → id_prefix → prompt slice), so telemetry cannot tell a
   * real `agent_type` dispatch from an id_prefix/prompt-derived one. For that,
   * use {@link resolvedAgentType}.
   */
  agentType?: string;
  /**
   * The resolved *registered* agent type for this fork — set ONLY when the
   * dispatch named an `agent_type` that resolved to an entry in the agent
   * registry (builtin/plugin/user). Absent for bare/unnamed dispatches,
   * compose nodes, and skill-internal id_prefix forks. Unlike {@link agentType}
   * (a render label), this field carries clean, enumerable semantics: grouping
   * lifecycle events by it answers "how often was each named agent type
   * dispatched?" without the render-label noise.
   */
  resolvedAgentType?: string;
  /**
   * The child's effective tool-round budget, read from the FINAL assembled
   * child config (after call-site, named-agent frontmatter, compose node, and
   * the `SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS` fallback have all resolved).
   * `0` means unbounded. Present so a trace reader can compute cap rates per
   * budget value and join a `tool_use_loop_capped` stop reason to the ceiling
   * that produced it, instead of inferring the budget from source constants.
   * Absent on traces written before this field existed.
   */
  maxToolUseIterations?: number;
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

export type {
  BackgroundAgentStartedPayload,
  BackgroundAgentCompletedPayload,
  BackgroundAgentFailedPayload,
  BackgroundAgentCancelledPayload,
  BackgroundAgentJoinedPayload,
  BackgroundAgentDeliveredPayload,
  BackgroundAgentPayload,
} from './background-agent-payloads.js';
import type { BackgroundAgentPayload } from './background-agent-payloads.js';

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

export interface QueuedUserMessagePayload {
  jobId: string;
  subagentId: string;
  /** UTF-8 bytes delivered; raw user text is deliberately never persisted. */
  byteLength: number;
}

/**
 * Payload for the `peer_message` trace event.
 *
 * Invariant: body text is NEVER recorded. Only byte counts and identifiers
 * are persisted so the trace can never be used to exfiltrate message content.
 */
export interface PeerMessagePayload {
  /**
   * What happened to this message.
   *
   * Note: the `'delivered'` member is the pre-#2810 receiver action. Traces
   * from older builds show `sent → delivered` instead of `sent → claimed →
   * injected`. New code never emits `'delivered'`; it is retained only for
   * backward-compatible deserialization of historical trace files (see #2901).
   */
  action: 'sent' | 'claimed' | 'injected' | /** @deprecated pre-#2810, never emitted by new code */ 'delivered' | 'held' | 'refused' | 'dropped' | 'reclaimed';
  /** The stable message id (uuid). Absent when action is 'dropped' by a sweep. */
  messageId?: string;
  /** The OTHER session's id (sender when action is delivered/held/dropped; target when sent/refused). */
  peer: string;
  /** UTF-8 byte length of the body. Never 0 for sent/delivered; may be 0 for refused. */
  bytes: number;
  /** Why the message was refused or dropped. Absent for other actions. */
  reason?: string;
}

export interface BrowserEventPayload {
  /** Which browser tool ran. */
  tool: BrowserEventTool;

  /** `browser_act` sub-discriminator. Absent for other tools. */
  action?: BrowserActAction;

  /** Correlates with the surrounding `tool_call` started/completed events. */
  toolUseId: string;

  /** Which backend handled this call. Absent on older traces. */
  backend?: 'playwright' | 'agent-browser';

  /** Why this backend was selected. Absent on older traces. */
  backendReason?: string;

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
// session_phase — lifecycle milestones. Definitions and per-phase docs live in
// ./types.session-phase.ts (split under the 350-code-line ceiling).
// ---------------------------------------------------------------------------

export type { SessionPhaseName, SessionPhasePayload } from './types.session-phase.js';
import type { SessionPhasePayload } from './types.session-phase.js';

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
  | { kind: 'queued_user_message'; payload: QueuedUserMessagePayload }
  | { kind: 'peer_message'; payload: PeerMessagePayload }
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
  | { ts: string; seq: number; kind: 'queued_user_message'; payload: QueuedUserMessagePayload }
  | { ts: string; seq: number; kind: 'peer_message'; payload: PeerMessagePayload }
  | { ts: string; seq: number; kind: 'session_phase'; payload: SessionPhasePayload }
  | { ts: string; seq: number; kind: 'session_sealed'; payload: SessionSealedPayload };
