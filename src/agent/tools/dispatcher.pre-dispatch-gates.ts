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
import { HookBlockedError, errorMessage } from '../../utils/errors.js';
import { checkToolPermission, type ToolPermissionConfig } from './permissions.js';
import { classifyBashCommand } from './readonly-bash.js';
import { repeatCallFingerprint } from './repeat-circuit-breaker.js';
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
import type { CanUseTool, PermissionResult } from '../types/sdk-types.js';
import type { TraceSink } from '../trace/index.js';
import type { GrantManager } from '../../cli/slash/commands/allow-dir.js';

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
  /** Current working directory injected into PreToolUse context. */
  resolveBase: string | undefined;
  /** Witness trace writer; used by emitHookDecision and emitSessionPhase. */
  traceWriter: TraceSink | undefined;
  /** Returns whether this session has an implementation for `toolName`. */
  isRegisteredTool: (toolName: string) => boolean;
  /** Generates the model-visible message for an allowlist denial. */
  denialReason: (toolName: string, permissionReason: string | undefined) => string;
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
function recordForkReadDenial(
  call: ToolCall,
  blockReason: string | undefined,
  blockResult: ToolResult,
  deps: PreDispatchGateDeps,
): ToolResult {
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
  return {
    content: buildDenialBreakerMessage(breaker.deniedPaths, breaker.count),
    isError: true,
    failureClass: DENIAL_BREAKER_FAILURE_CLASS,
  };
}

/**
 * Consult the optional `canUseTool` permission callback for a single call.
 * Returns a permission-denied {@link ToolResult} to short-circuit when the
 * policy denies (or throws — fail-closed), or `null` to proceed. On an
 * `allow` result carrying `updatedInput`, the call's input is rewritten in
 * place so both the handler and the PostToolUse hook observe the new value.
 *
 * Invariant: callers MUST invoke this AFTER `checkToolPermission` (the static
 * allowlist wins) and BEFORE the read-only-bash gate, in BOTH `execute()` and
 * the `executeBatch()` phase-1 loop, so parallel tool calls are gated too.
 */
async function runCanUseTool(
  call: ToolCall,
  deps: PreDispatchGateDeps,
): Promise<ToolResult | null> {
  if (!deps.canUseTool) return null;
  let result: PermissionResult;
  try {
    result = await deps.canUseTool(call.name, (call.input ?? {}) as Record<string, unknown>, {
      signal: call.signal,
      toolUseID: call.id,
    });
  } catch (err) {
    // Fail closed: a throwing policy denies the call rather than crashing the
    // turn. The message names the cause so the denial is never silent.
    const reason = `Tool "${call.name}" denied by canUseTool (threw): ${
      errorMessage(err)
    }`;
    await emitPreToolUseBlock(call.name, reason, deps);
    return { content: reason, isError: true, failureClass: 'permission-denied' };
  }
  if (result.behavior === 'deny') {
    const reason = result.message || `Tool "${call.name}" denied by permission policy`;
    await emitPreToolUseBlock(call.name, reason, deps);
    return { content: reason, isError: true, failureClass: 'permission-denied' };
  }
  // allow — apply an optional input rewrite in place.
  if (result.updatedInput !== undefined) {
    call.input = result.updatedInput;
  }
  return null;
}

/**
 * Read-only-skill bash gate. Returns an isError {@link ToolResult} when the
 * dispatcher is in `readOnlyBash` mode AND `call` is a `bash` invocation
 * whose command classifies as MUTATING; otherwise returns `null` (allow).
 *
 * Invariant: this runs AFTER the permission check at both call sites
 * (`execute()` single-path and `executeBatch()` phase-1), mirroring a
 * PreToolUse gate but living in the dispatcher because — unlike the hook
 * registry — it needs the raw `call.input.command` string. The input shape
 * is guarded: a non-object input or missing/non-string `command` is treated
 * as a no-op pass-through (the handler will surface its own validation
 * error), so we never throw here.
 */
async function checkReadOnlyBash(
  call: ToolCall,
  deps: PreDispatchGateDeps,
): Promise<ToolResult | null> {
  if (!deps.readOnlyBash || call.name !== 'bash') return null;
  const input = call.input;
  const command =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)['command']
      : undefined;
  if (typeof command !== 'string') return null;
  const verdict = classifyBashCommand(command);
  if (!verdict.mutating) return null;
  // Reason text is shared by the model-visible result and the trace event so
  // the two can never drift; the command string itself is deliberately NOT
  // recorded (ADR 0001 §G.4 keeps raw commands out of telemetry).
  const reason =
    `Bash command blocked: read-only skill may not run mutating commands ` +
    `(${verdict.reason ?? 'mutation detected'}). Allowed: read-only recon ` +
    `(git status/log/diff/show/ls-remote, ls, cat, find, grep, gh pr view/diff). ` +
    `For a remote ref you have not fetched, \`gh pr diff <n>\`, \`gh pr view <n>\` ` +
    `and \`git ls-remote\` need no local ref — \`git fetch\` is blocked. ` +
    `Do NOT retry variants of a blocked command: if the task genuinely requires a ` +
    `mutation, stop and report that requirement to your caller instead.`;
  await emitPreToolUseBlock(call.name, reason, deps);
  return { content: reason, isError: true, failureClass: 'permission-denied' };
}

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
 */
export function accountDenialBreakerPostGate(
  call: ToolCall,
  blockReason: string | undefined,
  blockResult: ToolResult,
  deps: PreDispatchGateDeps,
): ToolResult {
  return recordForkReadDenial(call, blockReason, blockResult, deps);
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
      // Inject the tool-call id so hooks (e.g. edit-preview-hook) can
      // correlate this PreToolUse event with an in-flight tool-lane entry.
      ...(call.id !== undefined ? { toolUseId: call.id } : {}),
    };
    try {
      await dispatchPreToolUse(deps.hookRegistry, preCtx, {
        signal: call.signal,
        ...(deps.traceWriter ? { traceWriter: deps.traceWriter } : {}),
      });
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
        return recordForkReadDenial(call, err.reason, blockResult, deps);
      }
      throw err;
    }
  }

  // 2. Permission check
  const permResult = checkToolPermission(call.name, deps.permissions);
  if (!permResult.allowed) {
    const reason = deps.denialReason(call.name, permResult.reason);
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
  const bashBlock = await checkReadOnlyBash(call, deps);
  if (bashBlock) return bashBlock;

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
