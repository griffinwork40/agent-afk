/**
 * Pre-dispatch gate chain for {@link SessionToolDispatcher}.
 *
 * Extracted from `dispatcher.ts` to reduce its code-line count below the
 * 350-line ceiling. Contains every gate that runs BEFORE a tool call reaches
 * `executeCore` — in the same precedence order enforced at both call sites
 * (`execute()` single-path and `executeBatch()` phase-1 loop):
 *
 *  1. PreToolUse hook (dispatchPreToolUse)
 *  2. Static allowlist (checkToolPermission)
 *  2a. In-process canUseTool callback
 *  2b. Read-only-bash gate (classifyBashCommand)
 *  2c. Repeat-loop circuit breaker
 *  2c-bis. Enforcing repeat-FAILURE guard
 *  2d. OBSERVE-ONLY suspected-loop telemetry
 *
 * All state that mutates across calls is carried in a
 * {@link PreDispatchGateMutableState} bag owned by the dispatcher and passed
 * into {@link PreDispatchGateDeps} by reference, so the free functions here can
 * read and write it without holding a class reference.
 *
 * @module agent/tools/dispatcher.pre-dispatch-gates
 */

import { debugLog } from '../../utils/debug.js';
import { HookBlockedError } from '../../utils/errors.js';
import { checkToolPermission, type ToolPermissionConfig } from './permissions.js';
import { repeatCallFingerprint } from './repeat-circuit-breaker.js';
import type { ToolCallLedgerReader } from './dispatcher.ledger.js';
import {
  DENIAL_CIRCUIT_BREAKER_THRESHOLD,
  DENIAL_BREAKER_FAILURE_CLASS,
  READ_PATH_TOOLS,
  isSubagentContainmentDenial,
  extractDeniedReadPath,
  buildDenialBreakerMessage,
} from './denial-circuit-breaker.js';
import {
  createSuspectedLoopWindow,
  fingerprintToolCall,
  observeToolCall,
  SUSPECTED_LOOP_WINDOW_SIZE,
  type SuspectedLoopWindow,
} from './suspected-loop-detector.js';
import { RepeatFailureGuard } from './repeat-failure-guard.js';
import { dispatchPreToolUse } from '../subagent-hooks.js';
import { emitHookDecision, emitSessionPhase } from '../trace/emit.js';
import type { HookRegistry, PreToolUseContext } from '../hooks.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import type { CanUseTool } from '../types/sdk-types.js';
import type { TraceSink } from '../trace/index.js';
import type { GrantManager } from './grant-manager.js';
import { readOnlyBashDenialOverride } from './readonly-git-surface.js';
import { isPeerToolBlocked, peerToolChildDenial } from './peer-tool-gate.js';
import type { HookBlockRepeatState } from './hook-block-repeat-breaker.js';
import { applyHookBlockRepeatGate as applyHookBlockRepeat } from './dispatcher.hook-block-repeat-gate.js';
import { bashCommandDenialReason } from './dispatcher.pre-dispatch-gates.bash.js';
import { runCanUseTool } from './dispatcher.pre-dispatch-gates.can-use-tool.js';
export { runCanUseTool } from './dispatcher.pre-dispatch-gates.can-use-tool.js';

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------

/**
 * The three mutable state fields that the pre-dispatch gate chain reads and
 * writes across tool calls. The dispatcher owns this object (one per
 * `SessionToolDispatcher` instance) and passes it into
 * {@link PreDispatchGateDeps} by reference so the free functions can observe
 * and advance the state without holding a class reference.
 */
export interface PreDispatchGateMutableState {
  /**
   * Repeat-loop circuit breaker state. See {@link checkRepeatCircuitBreaker}.
   * `null` when no call has been seen yet on this dispatcher instance.
   */
  repeatBreaker: { fingerprint: string; count: number } | null;
  /**
   * OBSERVE-ONLY suspected-loop telemetry window. Lazily created on the first
   * forked tool call; stays `null` for top-level sessions (never observed).
   * See {@link observeSuspectedLoop}.
   */
  suspectedLoopWindow: SuspectedLoopWindow | null;
  /**
   * Denial circuit breaker state. `null` when no denial has been seen since
   * the last successful tool result. See {@link recordForkReadDenial}.
   */
  denialBreaker: { count: number; deniedPaths: string[] } | null;
  /**
   * Hook-block repeat breaker state (#3736). `null` when no block has been
   * seen since the last successful tool result. See {@link applyHookBlockRepeat}.
   */
  hookBlockRepeat: HookBlockRepeatState | null;
}

// ---------------------------------------------------------------------------
// Dependency surface
// ---------------------------------------------------------------------------

/**
 * Everything the pre-dispatch gates need from the owning dispatcher, bundled
 * into an explicit interface so the free functions are testable without
 * constructing a full `SessionToolDispatcher`.
 *
 * Every field maps 1:1 to a private member of {@link SessionToolDispatcher};
 * the names are intentionally identical.
 */
export interface PreDispatchGateDeps {
  /** Mutable gate state owned by the dispatcher. */
  state: PreDispatchGateMutableState;
  /** Session hook registry; `undefined` = no hooks registered. */
  hookRegistry: HookRegistry | undefined;
  /** Static tool-permission config (allowlist). */
  permissions: ToolPermissionConfig | undefined;
  /** Optional in-process permission callback (consulted after the allowlist). */
  canUseTool: CanUseTool | undefined;
  /** When true, mutating `bash` commands are blocked (read-only skill child). */
  readOnlyBash: boolean;
  /**
   * When true, working-tree-destructive git commands are blocked for ALL child
   * sessions (checkout, switch, restore, clean, reset --hard, stash drop/clear/pop).
   * Set unconditionally for every forked child via `createChildProviderFactory`.
   * Independent of `readOnlyBash` — that blocks ALL mutating bash; this blocks
   * only the destructive-git subset for children that can otherwise run bash.
   */
  blockDestructiveGit: boolean;
  /** Enforcing repeat-failure guard shared with the batch helpers. */
  repeatFailureGuard: RepeatFailureGuard;
  /** Session id; used in PreToolUse context and presence-file marking. */
  sessionId: string | undefined;
  /** Parent session id; used to scope fork-only gates. */
  parentSessionId: string | undefined;
  /** This fork's subagent id, stamped on `hook_decision` events. */
  subagentId: string | undefined;
  /** Session grant manager injected into PreToolUse context. */
  sessionGrantManager: GrantManager | undefined;
  /**
   * Session is headless (`isHeadlessSession(config)`). Injected into
   * the PreToolUse context as `nonInteractive: true` when set — the explicit
   * headless signal, since a grant manager is wired on every production surface.
   */
  nonInteractive: boolean;
  /** Current working directory injected into PreToolUse context. */
  resolveBase: string | undefined;
  /** Witness trace writer; used by emitHookDecision and emitSessionPhase. */
  traceWriter: TraceSink | undefined;
  /** Returns whether this session has an implementation for `toolName`. */
  isRegisteredTool: (toolName: string) => boolean;
  /** Capture non-blocking context for additive delivery on the final result. */
  capturePreToolContext?: (call: ToolCall, context: string) => void;
  /** Generates the model-visible message for an allowlist denial. */
  denialReason: (toolName: string, permissionReason: string | undefined) => string;
  /**
   * Session-scoped tool-call ledger reader (#4476). Used by
   * {@link checkCrossTurnRepeatFailure} to detect inter-turn failure spirals
   * that the per-turn `RepeatFailureGuard` cannot see (it resets each turn).
   * Optional: when absent the cross-turn check is skipped (backward-compat,
   * tests that don't need ledger awareness).
   */
  toolCallLedger?: ToolCallLedgerReader;
}

// ---------------------------------------------------------------------------
// Internal gate helpers (called only by runPreDispatchGates)
// ---------------------------------------------------------------------------

/**
 * Emit a PreToolUse `hook_decision` block, stamped with the dispatcher's
 * `subagentId` when it belongs to a fork.
 *
 * Invariant: EVERY path that returns an isError {@link ToolResult} to the
 * model for a POLICY reason must call this. A denial the model can see but the
 * trace cannot is unattributable after the fact — child tool arguments and
 * error text are persisted nowhere, so this event is the only durable record
 * that the denial happened and which child provoked it.
 */
export async function emitPreToolUseBlock(
  blockedTool: string,
  reason: string,
  deps: PreDispatchGateDeps,
): Promise<void> {
  await emitHookDecision(deps.traceWriter, {
    hookEvent: 'PreToolUse',
    decision: 'block',
    blockedTool,
    reason,
    ...(deps.subagentId !== undefined ? { subagentId: deps.subagentId } : {}),
  });
}

/**
 * Denial circuit breaker (#546). Called from the `HookBlockedError` catch with
 * the block `reason` and the just-built `hook-block` result. Counts the denial
 * ONLY when ALL of:
 *   - it is a forked child (`parentSessionId` set — only forks auto-deny reads;
 *     an interactive session gets a prompt instead), AND
 *   - the tool is a {@link READ_PATH_TOOLS} read (so write-confinement is never
 *     counted), AND
 *   - the block is a genuine path-approval CONTAINMENT denial per {@link
 *     isSubagentContainmentDenial} — NOT the credential/secret read-denylist
 *     floor or an arbitrary user-defined `PreToolUse` hook, whose denials the
 *     breaker's "widen readRoots" remedy would misdirect.
 * Below the threshold the original block result is returned unchanged; at the
 * threshold a `denial-breaker` result is returned instead, which the provider
 * loop converts into a loud `error` event so the parent gets a structured,
 * actionable failure rather than a fork that burns its wall-clock budget.
 *
 * Invariant: consecutive — {@link resetDenialBreaker} clears the count on any
 * successful tool result, so a fork that probes a couple of out-of-scope
 * paths and then makes progress never trips.
 */
async function recordForkReadDenial(
  call: ToolCall,
  blockReason: string | undefined,
  blockResult: ToolResult,
  deps: PreDispatchGateDeps,
): Promise<ToolResult> {
  if (
    deps.parentSessionId === undefined ||
    !READ_PATH_TOOLS.has(call.name) ||
    !isSubagentContainmentDenial(blockReason)
  ) {
    return blockResult;
  }
  const breaker = deps.state.denialBreaker ?? { count: 0, deniedPaths: [] };
  breaker.count += 1;
  const deniedPath = extractDeniedReadPath(call);
  if (!breaker.deniedPaths.includes(deniedPath)) breaker.deniedPaths.push(deniedPath);
  deps.state.denialBreaker = breaker;
  if (breaker.count < DENIAL_CIRCUIT_BREAKER_THRESHOLD) return blockResult;
  // Emit exactly once at trip time so the measurement path in `afk insights`
  // can count distinct breaker trip episodes (#3849). Mirrors the
  // `hook_block_repeat_tripped` pattern in dispatcher.hook-block-repeat-gate.ts.
  if (breaker.count === DENIAL_CIRCUIT_BREAKER_THRESHOLD) {
    void emitSessionPhase(deps.traceWriter, {
      phase: 'denial_circuit_breaker_tripped',
      metadata: {
        count: breaker.count,
        fork: true,
        deniedPaths: breaker.deniedPaths.join(', '),
        ...(deps.subagentId !== undefined ? { subagentId: deps.subagentId } : {}),
      },
    });
  }
  return {
    content: buildDenialBreakerMessage(breaker.deniedPaths, breaker.count),
    isError: true,
    failureClass: DENIAL_BREAKER_FAILURE_CLASS,
  };
}

// Bash-command gates (checkReadOnlyBash, checkDestructiveGitBash) extracted to
// dispatcher.pre-dispatch-gates.bash.ts.

/**
 * Repeat-loop circuit breaker. Increments a per-dispatcher consecutive-call
 * counter keyed on the (toolName, input) fingerprint; when the same call is
 * seen `threshold` times in a row, returns a synthetic isError nudge so the
 * model breaks the loop instead of receiving the (unchanging) tool result.
 * Returns null otherwise.
 *
 * Invariant: must be called exactly once per tool call, on the sequential
 * pre-execution path (execute() and executeBatch phase 1) so the count
 * reflects call order. Mirrors checkReadOnlyBash's gate placement — it runs
 * after the permission/abort gates, so denied or aborted calls (which never
 * execute) do not advance the counter.
 */
function checkRepeatCircuitBreaker(
  call: ToolCall,
  repeatBreakerExemptTools: ReadonlySet<string>,
  state: PreDispatchGateMutableState,
  threshold: number,
): ToolResult | null {
  if (repeatBreakerExemptTools.has(call.name)) return null;
  const fingerprint = repeatCallFingerprint(call);
  if (state.repeatBreaker !== null && state.repeatBreaker.fingerprint === fingerprint) {
    state.repeatBreaker.count += 1;
  } else {
    state.repeatBreaker = { fingerprint, count: 1 };
  }
  if (state.repeatBreaker.count < threshold) return null;
  return {
    content:
      `Loop circuit breaker: "${call.name}" has been called ${state.repeatBreaker.count} times ` +
      `in a row with byte-identical input. The result will not change. Stop repeating this ` +
      `call — reuse the previous result, change the input, try a different tool, or end the turn.`,
    isError: true,
    circuitBreaker: true,
  };
}

/**
 * Enforcing repeat-FAILURE guard (#723). Returns a refusal — and emits the
 * telemetry the issue requires — when this exact call has already failed
 * REPEAT_FAILURE_REFUSAL_THRESHOLD times in a row. Honours the same
 * exempt-tool list as the advisory breaker, so a tool whose repeated identical
 * calls are legitimate is never refused either.
 */
function checkRepeatFailureGuard(
  call: ToolCall,
  repeatBreakerExemptTools: ReadonlySet<string>,
  repeatFailureGuard: RepeatFailureGuard,
): ToolResult | null {
  if (repeatBreakerExemptTools.has(call.name)) return null;
  const verdict = repeatFailureGuard.check(call);
  if (verdict === null) return null;
  // Measurement (#723 requires the behaviour be observable) rides the
  // EXISTING per-call `tool_call` trace event via `failureClass:
  // 'repeat-failure'`, which `src/improve/scan/detectors/tool-failure-density.ts`
  // already consumes. Deliberately no new `session_phase` name: that union is
  // closed in two places (trace/types.ts + the hand-listed zod enum in
  // trace/events.ts), and this file's own output-cap comment records the
  // precedent that widening it for a diagnostic is out of scope.
  debugLog(
    `[repeat-failure-guard #723] refused ${verdict.tool} after ${verdict.count} identical failures`,
  );
  return verdict.result;
}

/**
 * OBSERVE-ONLY suspected-loop telemetry (see
 * {@link import('./suspected-loop-detector.js')}). Pushes this call's
 * normalized fingerprint into the per-dispatcher sliding window and, on the
 * FIRST time a fingerprint recurs past the threshold within the window,
 * fire-and-forgets a `suspected_loop` session-phase event carrying
 * `{ tool, count, windowSize }`.
 *
 * CRITICAL INVARIANT — this function has NO effect on dispatch. It returns
 * `void`, never a `ToolResult`; it never aborts, never sets a `failureClass`,
 * never mutates or delays the tool result, and never changes control flow.
 * The trace write is `void`-ed (fire-and-forget) so a slow witness write can
 * never delay a tool call. It exists purely to gather data on whether real
 * (tool, args) busy-loops occur in forked sub-agents.
 *
 * Scope: FORKED children only (`parentSessionId` set), mirroring the denial
 * breaker — interactive sessions, where the operator drives repetition, are
 * never observed and the window stays `null`.
 */
function observeSuspectedLoop(call: ToolCall, deps: PreDispatchGateDeps): void {
  // Top-level sessions are out of scope: never observed, no window allocated.
  if (deps.parentSessionId === undefined) return;
  if (deps.state.suspectedLoopWindow === null) {
    deps.state.suspectedLoopWindow = createSuspectedLoopWindow();
  }
  const fingerprint = fingerprintToolCall(call);
  const observation = observeToolCall(deps.state.suspectedLoopWindow, fingerprint);
  if (!observation.fired) return;
  // Fire-and-forget: emission must never delay or perturb dispatch, and
  // emitSessionPhase already swallows writer errors internally.
  void emitSessionPhase(deps.traceWriter, {
    phase: 'suspected_loop',
    metadata: {
      tool: call.name,
      count: observation.count,
      windowSize: SUSPECTED_LOOP_WINDOW_SIZE,
    },
  });
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Clear the denial breaker's consecutive-denial count. Called on any
 * successful tool result so the breaker tracks "read denials since the last
 * progress", not lifetime denials. See {@link recordForkReadDenial}.
 */
export function resetDenialBreaker(state: PreDispatchGateMutableState): void {
  state.denialBreaker = null;
}

// Hook-block repeat gate extracted to dispatcher.hook-block-repeat-gate.ts.
export { applyHookBlockRepeatGate as applyHookBlockRepeat } from './dispatcher.hook-block-repeat-gate.js';

/**
 * Reset all progress-sensitive breakers on any successful tool result.
 * Combines the denial-breaker reset and the hook-block-repeat reset (#3736)
 * into one call so `dispatcher.ts` stays under the code-line ceiling.
 */
export function resetProgressBreakers(state: PreDispatchGateMutableState): void {
  state.denialBreaker = null;
  state.hookBlockRepeat = null;
}

/** @internal */
/**
 * Post-parallel denial-breaker accounting for blocked safe calls.
 *
 * When `runPreDispatchGates` runs with `parallelSafe: true`, it skips the
 * `recordForkReadDenial` read-modify-write to avoid a race. This function
 * re-runs that accounting sequentially after `runParallelGates` returns, so
 * the denial breaker still fires when the threshold is reached — just counted
 * AFTER the parallel wave settles rather than inside it.
 *
 * Callers: {@link executeBatchImpl} iterates the `blocked` set for safe
 * indices and calls this once per blocked safe call whose gate result
 * indicates a hook-block denial.
 *
 * Returns the (potentially upgraded) `ToolResult`: at the threshold it
 * replaces the original block with a `denial-breaker` error, identical to
 * what `recordForkReadDenial` would have returned in the sequential path.
 *
 * @internal
 */
export async function accountDenialBreakerPostGate(
  call: ToolCall,
  blockReason: string | undefined,
  blockResult: ToolResult,
  deps: PreDispatchGateDeps,
): Promise<ToolResult> {
  return recordForkReadDenial(call, blockReason, blockResult, deps);
}

/**
 * Post-parallel suspected-loop observer replay for non-blocked safe calls.
 *
 * When `runPreDispatchGates` runs with `parallelSafe: true`, it skips
 * `observeSuspectedLoop` to avoid a concurrent read-modify-write race on the
 * per-dispatcher sliding window state. This function re-runs the observer
 * sequentially after `runParallelGates` returns, so the loop-telemetry window
 * covers sessions that ONLY issue safe (read-heavy / recon) tool calls — the
 * population where parallel dispatch is most active.
 *
 * Like the original `observeSuspectedLoop`, this has NO effect on dispatch:
 * it is purely observe-only, never blocking, never altering the result, and
 * never changing control flow. The trace write is fire-and-forget.
 *
 * Callers: {@link executeBatchImpl} iterates the safe indices that were NOT
 * blocked and calls this once per call so the window advances for every call
 * that actually passed the gate (blocked calls do not advance the window,
 * matching the sequential path where the observer runs AFTER the gate).
 *
 * @internal
 */
export function replayObserveSuspectedLoopPostGate(
  call: ToolCall,
  deps: PreDispatchGateDeps,
): void {
  observeSuspectedLoop(call, deps);
}

// ---------------------------------------------------------------------------
// Cross-turn repeat-failure suppression (#4476 item 3)
// ---------------------------------------------------------------------------

/**
 * Minimum number of cross-turn error observations of the SAME normalized call
 * required before the cross-turn suppressor fires.
 *
 * The per-turn {@link RepeatFailureGuard} already fires at 3 consecutive
 * within-turn failures. This threshold is set higher (5) so the cross-turn
 * suppressor catches inter-turn spirals (the same call failing across multiple
 * rounds, with a fresh per-turn guard each time) without blocking a tool that
 * occasionally recovers between turns. Five cross-turn failures at the same
 * fingerprint is a strong signal that the environment problem is persistent,
 * not transient.
 */
export const CROSS_TURN_REPEAT_FAILURE_THRESHOLD = 5;

/**
 * Cross-turn repeat-failure suppression consumer (#4476 item 3).
 *
 * Consults the session-scoped {@link ToolCallLedger} for prior observations of
 * this exact call. If the call has accumulated at least
 * {@link CROSS_TURN_REPEAT_FAILURE_THRESHOLD} error results across the last N
 * turns (the ledger's configured turn window), the call is refused with a hint
 * that quotes the most recent failure — without executing it again.
 *
 * This complements the per-turn {@link RepeatFailureGuard}: that guard resets
 * between turns and catches within-turn streaks; this one spans turns and
 * catches cross-turn spirals where the model retries the same failing call in
 * successive rounds.
 *
 * Returns the blocking `ToolResult` when the threshold is reached, or `null`
 * to proceed. Never throws — a ledger lookup failure degrades gracefully to
 * `null` (allow the call through).
 *
 * Invariant: observe-only gate. It reads the ledger but never writes it;
 * writes happen only via `noteSettledOutcome` after the call settles.
 *
 * @internal Called only from {@link runPreDispatchGates}.
 */
function checkCrossTurnRepeatFailure(
  call: ToolCall,
  ledger: ToolCallLedgerReader,
  exempt: ReadonlySet<string>,
): ToolResult | null {
  if (exempt.has(call.name)) return null;
  let history;
  try {
    history = ledger.lookup(call);
  } catch {
    // Failure-isolated: a throwing ledger must never block execution.
    return null;
  }
  if (history.length < CROSS_TURN_REPEAT_FAILURE_THRESHOLD) return null;
  // Count only errors AFTER the last success, mirroring RepeatFailureGuard's
  // "success clears the streak" contract. Without this, 5 alternating
  // fail/success pairs would trigger the gate even though the most recent call
  // succeeded — a false positive the per-turn guard explicitly avoids.
  const lastSuccessIdx = history.reduce(
    (best, e, i) => (e.result.isError !== true ? i : best),
    -1,
  );
  const tail = lastSuccessIdx === -1 ? history : history.slice(lastSuccessIdx + 1);
  const errorCount = tail.filter((e) => e.result.isError === true).length;
  if (errorCount < CROSS_TURN_REPEAT_FAILURE_THRESHOLD) return null;
  // Quote the most recent error for actionability (same pattern as per-turn guard).
  // Sanitize before reflecting: strip ANSI escape sequences and C0/C1 control
  // bytes so adversarial tool output cannot inject terminal sequences through
  // the gate-issued ToolResult (prompt-injection amplification vector).
  const lastError = [...tail].reverse().find((e) => e.result.isError === true);
  const rawSummary = lastError
    ? lastError.result.content.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
    : '';
  // Strip ESC-prefixed sequences then bare C0/C1/DEL bytes, then collapse spaces.
  const sanitized = rawSummary
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  const truncated = sanitized.length > 240 ? `${sanitized.slice(0, 240)}…` : sanitized;
  debugLog(
    `[cross-turn-repeat-failure #4476] refused ${call.name} after ${errorCount} cross-turn errors`,
  );
  return {
    content:
      `Cross-turn repeat-failure: "${call.name}" has failed ${errorCount} times across recent turns ` +
      `with the same arguments, so this call was NOT executed again. The last failure was: ` +
      `${truncated}\n\n` +
      `Retrying it verbatim will fail the same way. Fix the underlying cause, change the ` +
      `arguments, use a different tool, or stop and report the blocker.`,
    isError: true,
    failureClass: 'repeat-failure',
  };
}

/**
 * Options for {@link runPreDispatchGates}.
 */
export interface RunPreDispatchGatesOpts {
  /**
   * When true, skip the `checkRepeatCircuitBreaker` and `recordForkReadDenial`
   * read-modify-write counter updates. Set by {@link executeBatchImpl} for the
   * parallel gate path (concurrency-safe calls) so simultaneous gate closures
   * do not race on `state.repeatBreaker` or `state.denialBreaker`.
   *
   * Invariant: only the parallel-gate path in executeBatch sets this to true.
   * The sequential paths — the unsafe-call loop and the single `execute()` —
   * always use the default (false), so counter accounting stays sequential and
   * correct for those callers.
   *
   * @internal
   */
  parallelSafe?: boolean;
}

/**
 * Shared 7-step pre-dispatch gate chain used by both {@link execute} and
 * {@link executeBatch}'s phase-1 admission loop: PreToolUse hook, static
 * allowlist, in-process `canUseTool` callback, read-only-bash gate, repeat
 * circuit-breaker, repeat-failure guard, and suspected-loop telemetry.
 *
 * Invariant: the precedence order below is load-bearing (see the per-step
 * comments) — the static allowlist deny wins over `canUseTool`, which runs
 * before the bash gate, which runs before the repeat-breaker/failure-guard
 * pair, which runs before the observe-only loop telemetry. Do not reorder.
 *
 * Returns `null` if the call should proceed to execution, or the blocking
 * `ToolResult` if a gate short-circuited it. The suspected-loop step never
 * blocks (observe-only) and always runs last when nothing else did.
 */
export async function runPreDispatchGates(
  call: ToolCall,
  deps: PreDispatchGateDeps,
  repeatBreakerExemptTools: ReadonlySet<string>,
  repeatCircuitBreakerThreshold: number,
  opts?: RunPreDispatchGatesOpts,
): Promise<ToolResult | null> {
  // 1. PreToolUse hook — can block. Routed through dispatchPreToolUse
  // so the witness-layer hook_decision event lands automatically.
  if (deps.hookRegistry) {
    const preCtx: PreToolUseContext = {
      event: 'PreToolUse',
      toolName: call.name,
      input: call.input,
      // Lets the path-approval prompt mark THIS session's presence file as
      // blocked-on-human while the operator decides.
      ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
      ...(deps.resolveBase !== undefined ? { cwd: deps.resolveBase } : {}),
      ...(deps.parentSessionId !== undefined
        ? { parentSessionId: deps.parentSessionId }
        : {}),
      // Inject THIS session's provider so path-scoped hooks resolve the real
      // (possibly forked-child) grants instead of the process-global ref.
      ...(deps.sessionGrantManager !== undefined
        ? { grantManager: deps.sessionGrantManager }
        : {}),
      // Explicit headless signal (#2302): grant-manager presence cannot carry
      // it, because every production provider wires one on every surface.
      ...(deps.nonInteractive ? { nonInteractive: true } : {}),
      // Inject the tool-call id so hooks (e.g. edit-preview-hook) can
      // correlate this PreToolUse event with an in-flight tool-lane entry.
      ...(call.id !== undefined ? { toolUseId: call.id } : {}),
    };
    try {
      const preDecision = await dispatchPreToolUse(deps.hookRegistry, preCtx, {
        signal: call.signal,
        ...(deps.traceWriter ? { traceWriter: deps.traceWriter } : {}),
      });
      if (preDecision.injectContext) deps.capturePreToolContext?.(call, preDecision.injectContext);
      // Apply input rewrite from the hook chain. The registry dispatches all
      // handlers against the original context; last-writer-wins — the final
      // non-blocking hook's updatedInput is used. Hooks do NOT see each
      // other's rewrites during dispatch (only the winner is applied here).
      // The rewritten input goes through the same permission gates and
      // tool-schema validation below — a hook can narrow a call but cannot
      // widen it past policy. Only plain objects are accepted;
      // arrays/primitives are rejected at parse time.
      if (preDecision.updatedInput !== undefined) {
        call.input = preDecision.updatedInput;
      }
    } catch (err) {
      if (err instanceof HookBlockedError) {
        const blockResult: ToolResult = {
          content:
            `Tool "${call.name}" blocked by PreToolUse hook` +
            `${err.reason ? `: ${err.reason}` : ''}` +
            `${err.injectContext ? `\n\n${err.injectContext}` : ''}`,
          isError: true,
          failureClass: 'hook-block',
        };
        // Skip the read-modify-write on state.denialBreaker when called from
        // the parallel-gate path — concurrent closures would race on the shared
        // counter. The caller (executeBatchImpl) handles denial accounting
        // sequentially after runParallelGates returns.
        // Preserve err.reason as blockReason so accountDenialBreakerPostGate
        // can pass the original reason string to isSubagentContainmentDenial
        // rather than the composite content string (which could false-positive
        // if injectContext also contains the containment-denial prefix).
        if (opts?.parallelSafe) {
          if (err.reason !== undefined) blockResult.blockReason = err.reason;
          return blockResult;
        }
        // Apply denial breaker first (fork read-containment denials), then the
        // hook-block repeat breaker (#3736) so both run on every sequential block.
        // Pass err.reason to applyHookBlockRepeat so it can exclude containment
        // denials (isSubagentContainmentDenial) without relying on blockReason,
        // which is only set on the parallelSafe path.
        const afterDenial = await recordForkReadDenial(call, err.reason, blockResult, deps);
        return applyHookBlockRepeat(call, afterDenial, deps, err.reason);
      }
      throw err;
    }
  }

  // 2-pre. Top-level-only peer tools (list_sessions / send_to_session).
  // Structural: a forked child is refused regardless of its allowlist, which
  // (CHILD_ALLOWED_TOOLS) contains every builtin name. Shares its predicate
  // with the toolDefs filter so visibility and execution never diverge.
  if (isPeerToolBlocked(call.name, deps)) {
    const reason = peerToolChildDenial(call.name);
    await emitPreToolUseBlock(call.name, reason, deps);
    return { content: reason, isError: true, failureClass: 'permission-denied' };
  }

  // 2. Permission check
  const permResult = checkToolPermission(call.name, deps.permissions);
  if (!permResult.allowed) {
    const reason = readOnlyBashDenialOverride(call.name, deps.readOnlyBash) ?? deps.denialReason(call.name, permResult.reason);
    await emitPreToolUseBlock(call.name, reason, deps);
    return { content: reason, isError: true, failureClass: 'permission-denied' };
  }

  // 2a. In-process permission callback (canUseTool). Consulted AFTER the
  // static allowlist (a hard allowlist deny wins) and BEFORE the bash gate.
  // A `deny` short-circuits here; an `allow` may have rewritten `call.input`.
  const canUseDeny = await runCanUseTool(call, deps);
  if (canUseDeny) return canUseDeny;

  // 2b. Read-only-skill bash gate. Runs after the permission check so the
  // allowlist denial (if any) takes precedence; blocks mutating bash while
  // letting read-only recon through.
  // 2b-bis. Destructive-git gate. Runs after readOnlyBash so read-only children
  // (where all mutating bash is already blocked) never redundantly reach this.
  // Blocks checkout/switch/restore/clean/reset --hard/stash drop|clear|pop for
  // ALL child sessions where blockDestructiveGit is true.
  // Both run inside bashCommandDenialReason, in that order.
  const bashDenial = bashCommandDenialReason(call, deps);
  if (bashDenial !== undefined) {
    await emitPreToolUseBlock(call.name, bashDenial, deps);
    return { content: bashDenial, isError: true, failureClass: 'permission-denied' };
  }

  // 2c. Repeat-loop circuit breaker. Short-circuits no-progress loops where
  // the model calls the same tool with byte-identical input N times in a row.
  // Skipped on the parallel-gate path (parallelSafe) to avoid a race on
  // state.repeatBreaker — concurrent closures cannot safely share a
  // read-modify-write counter. The sequential paths still run this gate.
  if (!opts?.parallelSafe) {
    const repeatBlock = checkRepeatCircuitBreaker(
      call,
      repeatBreakerExemptTools,
      deps.state,
      repeatCircuitBreakerThreshold,
    );
    if (repeatBlock) return repeatBlock;
  }

  // 2c-bis. Enforcing repeat-FAILURE guard (#723). Unlike the advisory
  // breaker above, this one stops execution: a call that has already failed
  // identically N times is refused with the prior error quoted back.
  // Skipped on the parallel-gate path for the same reason as checkRepeatCircuitBreaker
  // above: consecutive ordering is undefined for parallel calls, so the
  // read-modify-write state inside repeatFailureGuard is not safe to share
  // across concurrent closures.
  if (!opts?.parallelSafe) {
    const failureRefusal = checkRepeatFailureGuard(
      call,
      repeatBreakerExemptTools,
      deps.repeatFailureGuard,
    );
    if (failureRefusal) return failureRefusal;
  }

  // 2c-ter. Cross-turn repeat-failure suppression (#4476 item 3). Consults
  // the session-scoped ToolCallLedger for prior error observations spanning
  // multiple turns. The per-turn guard (2c-bis) only sees within-turn
  // consecutive failures and resets each round; this gate catches inter-turn
  // spirals where the same call fails across successive rounds. Read-only
  // from the ledger; writes happen in noteSettledOutcome after the call
  // settles.
  // Skipped on the parallel-gate path (parallelSafe) to match the asymmetric
  // enforcement of sibling gates 2c and 2c-bis, which also skip on
  // parallelSafe. Although lookup() is a pure read and cannot race, applying
  // an enforcing gate only on the sequential path keeps the enforcement model
  // consistent: the gate fires when the sequential path catches it, and the
  // parallel-safe path runs the full set of calls without interference.
  if (!opts?.parallelSafe && deps.toolCallLedger !== undefined) {
    const crossTurnRefusal = checkCrossTurnRepeatFailure(
      call,
      deps.toolCallLedger,
      repeatBreakerExemptTools,
    );
    if (crossTurnRefusal) return crossTurnRefusal;
  }

  // 2d. OBSERVE-ONLY suspected-loop telemetry (forked children only). Records
  // the fingerprint and emits a `suspected_loop` trace signal on first
  // recurrence past threshold. Pure observability — never blocks, never
  // alters the result, never changes control flow. Runs after the repeat
  // breaker so a short-circuited call is not counted twice.
  // Skipped on the parallel-gate path: the loop detector is observe-only,
  // so skipping it here loses no enforcing signal; the sequential path still
  // runs it.
  if (!opts?.parallelSafe) {
    observeSuspectedLoop(call, deps);
  }

  return null;
}
