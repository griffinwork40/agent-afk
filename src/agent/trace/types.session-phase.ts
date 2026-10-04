/**
 * `session_phase` trace payload types, split out of `types.ts` under the
 * 350-code-line ceiling. `types.ts` re-exports both names, so importers are
 * unchanged; the Zod mirror lives in `events.session-phase.ts`.
 *
 * @module agent/trace/types.session-phase
 */

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
  // Client-side time-to-first-byte watchdog re-drive: OUR timer fired because no
  // content token arrived within the per-attempt bound (⌊2/3⌋ of
  // `AFK_MODEL_TTFB_TIMEOUT_MS` — 120s at the 180s default), so the request was
  // aborted and re-driven while the round's counted budget still had allowance.
  // `metadata.attempt` is the 1-based index of the re-drive being served.
  // Deliberately NOT `rate_limit`:
  // nothing throttled us and there is no server retry-after — conflating the two
  // made a self-inflicted 3-minute stall read as provider throttling in every
  // trace (5 such stalls in one `/ground-state` pre-flight were misattributed
  // this way). `durationMs` is the dead wait before the abort; metadata keeps
  // `reason: 'ttfb-timeout'` so pre-split analyses still match.
  | 'ttfb_timeout'
  // OAuth subscription usage-limit park/unpark. Unlike `rate_limit` (a short,
  // bounded retry-after backoff), these bracket a potentially multi-HOUR pause
  // while the turn waits for the subscription window to reset (or a keychain
  // hot-swap). `usage_limit_resume` carries the parked `durationMs`. Emitted as
  // a pair, but a pause may end without a resume (auto-resume off, abort, or the
  // 2-hour cap surfacing the error) — so a lone `usage_limit_pause` is expected.
  | 'usage_limit_pause'
  | 'usage_limit_resume'
  // Mid-stream overload (529) exhaustion park/unpark (#762). Distinct from
  // `usage_limit_pause` — that brackets an OAuth subscription window with an
  // authoritative reset deadline; a 529 carries NO reset timestamp, so this pair
  // brackets a bounded PLAIN WALL-CLOCK park that re-probes upstream capacity on
  // a jittered interval. `overload_resume` carries the parked `durationMs`.
  // Emitted as a pair, but a pause may end without a resume (ceiling reached,
  // abort, or the pause disabled for the surface) — a lone `overload_pause` is
  // expected, and is always followed by a real `closure`.
  | 'overload_pause'
  | 'overload_resume'
  // A progress-aware watchdog fired on unexplained silence. Two sources, told
  // apart by `metadata.source`:
  //   - absent → a forked sub-agent turn: the child produced no observable
  //     OutputEvent for the idle window and its controller was aborted (see
  //     subagent/idle-watchdog.ts). Carries `idleTimeoutMs`,
  //     `elapsedSinceLastProgressMs`, and `lastEventType`.
  //   - `'model-stream'` → a provider stream that had ALREADY produced a first
  //     content token then went silent for the whole stall window, so the round
  //     was aborted instead of hanging (see providers/shared/stream-stall-timeout.ts,
  //     issue #762). Carries `stallTimeoutMs` + `elapsedSinceLastProgressMs`.
  // A single event either way (no paired start). Distinct from
  // `rate_limit`/`usage_limit_*`, which mark LEGITIMATE waits — this marks an
  // unexplained stall that fired.
  | 'idle_watchdog_fired'
  // A forked sub-agent turn's wall-clock ceiling granted a bounded extension
  // because the provider reported being parked (`paused` w/ resetsAt or
  // `rate_limit` w/ retryAfterMs). See subagent/pause-ceiling.ts. A single event
  // per grant (no paired start), emitted fire-and-forget from the handle when
  // `PauseAwareCeiling.onDeadline()` returns a positive grant. Carries, in
  // `metadata`, the `subagentId`, `grantMs`, `totalGrantedMs`, `remainingCapMs`,
  // `grantCount`, and (when known) the `pauseDescription`. PURE OBSERVABILITY:
  // without it, a pause-driven extension is invisible until the eventual
  // terminal timeout error — reconstructing "the child got N extensions
  // totaling Xms across this park" required the error string alone.
  | 'pause_extension_granted'
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
  | 'suspected_loop'
  // History compaction was DISABLED for the remainder of the session because the
  // backend proved it cannot serve the summarize request (e.g. the ChatGPT/Codex
  // Responses backend refusing the throwaway summarize turn — issue #653). A
  // single event (no paired start), emitted AT MOST ONCE per session, carrying
  // `wire`, `reason`, `error`, and (when present) `status` in `metadata`. High
  // signal: the auto-compaction caller discards its result, so without this the
  // disable is invisible until a human runs /compact — and an undisclosed
  // disable ends in a context-window overflow the operator cannot explain.
  | 'compaction_disabled'
  // A bootstrap-time warning (agent-registry builtin-shadow, MCP config) was
  // collected before `interactive.ts`'s startup-screen clear could destroy it
  // (issue #745). Emitted ONE EVENT PER WARNING at PUSH time inside
  // `bootstrapSession` (see `boot-warning-recorder.ts`) — never aggregated at
  // drain time — so a warning collected just before bootstrap THROWS is still
  // recorded even though the drain never runs on that path (issue #754).
  // `metadata.producer` names which producer pushed it (`agent-registry` |
  // `mcp`); `metadata.message` carries the warning text verbatim. HIGH
  // SIGNAL: the builtin-shadow warning from #739 is a safety signal (a user
  // agent file can silently convert a read-only verifier into a
  // write-capable agent machine-wide), so — like `rate_limit` — this renders
  // in the DEFAULT `afk trace show` view instead of behind `--all`.
  | 'boot_warning'
  // Workspace subscription lifecycle (Pillar 3, #1418).
  // `workspace_subscribed` is emitted when a child calls workspace_subscribe;
  // `workspace_delivery` is emitted each time entries are pushed to a
  // subscriber's ring buffer. Both carry agent + subscription context in
  // `metadata`. Fire-and-forget (consistent with other Pillar 1/2 events).
  | 'workspace_subscribed'
  | 'workspace_delivery'
  // Gate-shape telemetry for parallel dispatch (#1924). A single event emitted
  // from `executeBatchImpl` after Phase 1 gates settle, carrying the partition
  // sizes and wall-clock cost of the parallel gate wave. PURE OBSERVABILITY —
  // never alters dispatch. Absent for the length-1 fast path (no batching).
  // `metadata` keys: `safeCount` (tools gated in parallel), `unsafeCount`
  // (tools gated sequentially), `parallelGatesMs` (wall-clock for the parallel
  // gate wave, or 0 when there were no safe calls).
  | 'gate_shape'
  // Session-identity assignment event. Emitted whenever the provider-issued
  // session id first becomes known (or changes — e.g. a resumed/forked session
  // adopts its parent's id). The `sessionId` field on the payload carries the
  // value; `prior` carries the previous id when this is a change rather than a
  // first assignment. PURE OBSERVABILITY: this event exists solely so consumers
  // (friction analyzer, `afk insights`, harvest) can join a trace file to its
  // SessionFacet and ledger entry by session id without any side channel.
  //
  // Backward compat: old traces that predate this event simply lack it. Consumers
  // must treat its absence as "id unknown from trace alone" — the ledger
  // `traceLabel` bridge remains the fallback for those traces.
  | 'session_id_assigned'
  // Many-image dimension guard fired at request-build time and replaced one or
  // more image blocks with imageOmitted text blocks (issue #2348). Emitted when
  // `enforceManyImageLimit` degrades at least one image in `openRound` (single
  // event, no paired start). `metadata` carries `degradedCount` (number of
  // blocks replaced), `threshold` (MANY_IMAGE_THRESHOLD = 20), and
  // `maxDimension` (MAX_DIMENSION_MANY_IMAGES = 2000). PURE OBSERVABILITY: the
  // degradation itself is already reflected in the mutated messages array; this
  // event makes the repair visible in the trace so operators can diagnose
  // sessions that hit the many-image ceiling without inspecting raw message
  // payloads.
  | 'many_image_degraded'
  // Mid-stream transport drop was accepted as a clean completion because a
  // terminal finish_reason had already arrived before the socket closed
  // (#2780). Emitted in the openai-compatible driveStream accept branch (single
  // event, no paired start). `metadata` carries only `usageReceived` (whether
  // the usage-only trailing chunk arrived before the drop; false means the
  // retry budget ran out and usage is degraded). PURE OBSERVABILITY.
  | 'stream_accepted_after_drop'
  // Connection-phase network retry (anthropic-direct `createWithRetry`): the
  // request failed before any stream body was consumed (SDK
  // `APIConnectionError`, a socket/DNS code, an SDK connect timeout, or a
  // 408/409/500/502/504 status), so nothing was generated and the round
  // re-sends. One event per retry; `durationMs` is the backoff about to be
  // slept, and `metadata` carries `attempt`, `maxRetries`, `error` (truncated,
  // passed through redactSecrets) and, when present, `code` and `status`.
  // Built by `connectionRetryMetadata`. Exists because #2422 disabled the
  // SDK's silent retries, which had been absorbing these blips. A lone event
  // followed by success means the retry saved the turn; `attempt === maxRetries`
  // then an error means it ran out.
  | 'connection_retry'
  // Fan-out dispatch usage notice (compose / agent wave start). Emitted once at
  // dispatch start when the Anthropic quota snapshot shows warn (≥80%) or over
  // (≥100%) usage. PURE OBSERVABILITY — no blocking, no routing change.
  // `metadata` carries `level` ('warn'|'over'), `pct` (0–100), `windowLabel`
  // ('5h window'|'7d window'), and optionally `resetsAtMs` (epoch ms).
  | 'usage_notice'
  // Per-session tool-degradation signal (#2774). Emitted at most once per
  // (tool, errorHead) pair per session when >= 90% of the last 10 calls to
  // a given tool fail with the same error. PURE OBSERVABILITY — never alters
  // dispatch or isError. A later daemon builtin (PR 3) counts these across
  // sessions and pushes a Telegram alert.
  // metadata: { tool, errorHead, errorCount, callCount }
  | 'tool_degraded';

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
  origin?: 'cli' | 'telegram' | 'daemon' | 'web' | 'unknown';
  /**
   * Actor role that produced this session. Set on `session_init_start`:
   * `'main'` for a top-level session, `'subagent'` for a forked child
   * (derived from `parentSessionId`). Answers "main session or subagent?"
   * orthogonally to `origin` — a subagent forked under a Telegram session is
   * `{ origin: 'telegram', actor: 'subagent' }`.
   */
  actor?: 'main' | 'subagent';
  /**
   * Provider-issued session id. Set ONLY on `session_id_assigned` events —
   * the canonical durable bridge between a trace file (keyed by its directory
   * label) and the session store / SessionFacet (keyed by this id). Absent on
   * all other phase events and on older traces that predate this field.
   */
  sessionId?: string;
  /**
   * The previous session id, when this `session_id_assigned` event represents
   * a change rather than a first assignment (e.g. a resumed or forked session
   * adopting its parent's id). Absent on first-assignment events and on all
   * other phase kinds.
   */
  priorSessionId?: string;
}
