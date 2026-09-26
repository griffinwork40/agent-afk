/**
 * Core execution helpers for {@link SessionToolDispatcher}.
 *
 * Extracted from `dispatcher.ts` to reduce its code-line count below the
 * 350-line ceiling. Contains every step that runs AFTER the pre-dispatch gate
 * chain clears — handler routing, executor dispatch, PostToolUse hook firing,
 * output capping, and three tool-routing query helpers:
 *
 *  - {@link isRegisteredTool} — whether a name maps to a live handler/executor
 *  - {@link unknownToolMessage} — model-visible "tool does not exist" phrasing
 *  - {@link denialReason} — permission-gate denial message (registered vs. unknown)
 *  - {@link firePostToolUse} — fire-and-forget PostToolUse hook dispatch
 *  - {@link firePostToolUseFailure} — fire-and-forget PostToolUseFailure dispatch
 *  - {@link applyOutputCap} — central per-result output-byte backstop (#661)
 *  - {@link executeCompose} — compose-tool dispatch wrapper
 *  - {@link executeCoreInner} — handler routing + dispatch + PostToolUse
 *  - {@link executeCore} — executeCoreInner wrapped with applyOutputCap
 *
 * All dispatcher state consumed here is threaded through an explicit
 * {@link CoreExecDeps} bundle owned by the class and rebuilt per call, so the
 * free functions are testable without constructing a full dispatcher.
 *
 * @module agent/tools/dispatcher.core-exec
 */

import { debugLog } from '../../utils/debug.js';
import { dispatchPostToolUse, dispatchPostToolUseFailure } from '../subagent-hooks.js';
import { headAndTail } from './handlers/_output-cap.js';
import { emitPreToolUseBlock } from './dispatcher.pre-dispatch-gates.js';
import { executeSubagentProviderTool, isSubagentProviderTool } from './dispatcher.subagent-tools.js';
import type { HookRegistry, PostToolUseContext, PostToolUseFailureContext } from '../hooks.js';
import type { AnthropicToolDef } from '../providers/anthropic-direct/types.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import type { SubagentExecutor } from './subagent-executor.js';
import type { SkillExecutor } from './skill-executor.js';
import type { ComposeExecutor } from './compose-executor.js';
import type { ToolHandler, ToolHandlerContext } from './types.js';
import type { TraceSink } from '../trace/index.js';
import type { GrantManager } from './grant-manager.js';
import type { PreDispatchGateDeps } from './dispatcher.pre-dispatch-gates.js';
import { errorMessage } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Dependency surface
// ---------------------------------------------------------------------------

/**
 * Everything the core-execution helpers need from the owning dispatcher,
 * bundled into an explicit interface so the free functions are testable without
 * constructing a full {@link SessionToolDispatcher}.
 *
 * Every field maps 1:1 to a private member (or derived value) of the class;
 * names are intentionally identical.
 */
export interface CoreExecDeps {
  /** Registered handler map (name → ToolHandler). */
  handlers: Map<string, ToolHandler>;
  /** Session hook registry; `undefined` = no hooks registered. */
  hookRegistry: HookRegistry | undefined;
  /** Session id; stamped on PostToolUse context. */
  sessionId: string | undefined;
  /** Parent session id; stamped on PostToolUse context. */
  parentSessionId: string | undefined;
  /** Session grant manager; injected into PostToolUse context. */
  sessionGrantManager: GrantManager | undefined;
  /** Witness trace writer; forwarded to dispatchPostToolUse(Failure). */
  traceWriter: TraceSink | undefined;
  /**
   * Central per-result output byte cap. `undefined` = no central capping
   * (top-level session default). See {@link applyOutputCap}.
   */
  maxOutputBytes: number | undefined;
  /** Forked subagent executor (backs `agent`, `cancel_background_job`, etc.). */
  subagentExecutor: SubagentExecutor | undefined;
  /** Skill executor (backs the `skill` tool). */
  skillExecutor: SkillExecutor | undefined;
  /** Compose executor (backs the `compose` tool). */
  composeExecutor: ComposeExecutor | undefined;
  /**
   * Per-call handler context factory. The class supplies this as an arrow
   * calling its own private `callHandlerContext(call)` method so the free
   * functions here never need the class reference.
   */
  callHandlerContext: (call: ToolCall) => ToolHandlerContext;
  /**
   * Pre-dispatch gate deps snapshot. Supplied as an arrow so the free functions
   * can pass it to {@link emitPreToolUseBlock} (the unknown-handler path in
   * {@link executeCoreInner} needs to trace the block).
   */
  gateDeps: () => PreDispatchGateDeps;
  /**
   * Schemas currently advertised to the model. Used by {@link unknownToolMessage}
   * to build the "available tools" hint. Corresponds to `toolDefs` on the class.
   */
  toolDefs: readonly AnthropicToolDef[];
}

// ---------------------------------------------------------------------------
// Tool-routing query helpers
// ---------------------------------------------------------------------------

/**
 * Whether this session has a live implementation for `toolName`, regardless of
 * permission. Checks the handler map AND the three executor-backed specials.
 */
export function isRegisteredTool(toolName: string, deps: CoreExecDeps): boolean {
  return (
    deps.handlers.has(toolName) ||
    (toolName === 'agent' && deps.subagentExecutor !== undefined) ||
    (toolName === 'cancel_background_job' && deps.subagentExecutor?.supportsBackgroundJobs?.() === true) ||
    (toolName === 'send_message_to_agent' && deps.subagentExecutor?.supportsBackgroundJobs?.() === true) ||
    (toolName === 'get_background_job_health' && deps.subagentExecutor?.supportsBackgroundJobs?.() === true) ||
    (toolName === 'skill' && deps.skillExecutor !== undefined) ||
    (toolName === 'compose' && deps.composeExecutor !== undefined)
  );
}

/**
 * Contract: the single model-visible phrasing for "this tool does not exist".
 * Suggestions come from `toolDefs` (what was advertised), never `handlers`
 * (which may contain tools the gate will reject). See the long comment in
 * `dispatcher.ts` on `unknownToolMessage` for the full invariant.
 */
export function unknownToolMessage(toolName: string, deps: CoreExecDeps): string {
  const available = deps.toolDefs.map((s) => s.name).join(', ');
  // An empty listing means no schema survived the allowlist filter — the
  // model was shown nothing, so pointing at "the tools listed above" is a
  // dangling reference.
  const guidance =
    available.length > 0
      ? `Available tools: ${available}. Do NOT retry "${toolName}" or a variant of it; ` +
        `use one of the tools listed above.`
      : `Do NOT retry "${toolName}" or a variant of it.`;
  return `Unknown tool "${toolName}" — it does not exist in this session. ${guidance}`;
}

/**
 * Model-visible reason text for an allowlist denial. Registered-but-denied
 * tools keep the original permission reason; unregistered names receive the
 * "unknown tool" message instead (giving the model the available-tools list).
 * See the invariant comment in `dispatcher.ts` on `denialReason`.
 */
export function denialReason(
  toolName: string,
  permissionReason: string | undefined,
  deps: CoreExecDeps,
): string {
  if (isRegisteredTool(toolName, deps)) {
    return permissionReason ?? `Tool "${toolName}" is not permitted`;
  }
  return unknownToolMessage(toolName, deps);
}

// ---------------------------------------------------------------------------
// PostToolUse hook helpers
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget PostToolUse dispatch. Routes through `dispatchPostToolUse`
 * so the witness-layer `hook_decision` event lands automatically.
 *
 * `resultFlags` is an OPTIONAL trailing parameter (additive, back-compat):
 * callers that omit it get byte-identical behavior — no new keys on `postCtx`.
 * Callers that have the full ToolResult in scope pass it so a PostToolUse hook
 * can read `incomplete`/`incompleteReason` without substring-matching banners.
 */
export function firePostToolUse(
  toolName: string,
  output: string,
  signal: AbortSignal,
  deps: CoreExecDeps,
  input?: unknown,
  resultFlags?: Pick<ToolResult, 'incomplete' | 'incompleteReason' | 'isError'>,
): void {
  if (!deps.hookRegistry) return;
  const postCtx: PostToolUseContext = {
    event: 'PostToolUse',
    toolName,
    output,
    ...(input !== undefined ? { input } : {}),
    ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
    ...(deps.parentSessionId !== undefined ? { parentSessionId: deps.parentSessionId } : {}),
    // Mirror PreToolUse so path-approval "Once"-grant revoke uses the same grant manager.
    ...(deps.sessionGrantManager ? { grantManager: deps.sessionGrantManager } : {}),
    ...(resultFlags?.isError === true ? { isError: true } : {}),
    ...(resultFlags?.incomplete === true
      ? {
          incomplete: true,
          ...(resultFlags.incompleteReason ? { incompleteReason: resultFlags.incompleteReason } : {}),
        }
      : {}),
  };
  void dispatchPostToolUse(deps.hookRegistry, postCtx, {
    signal,
    ...(deps.traceWriter ? { traceWriter: deps.traceWriter } : {}),
  }).catch(() => {});
}

/**
 * Fire-and-forget PostToolUseFailure dispatch. Mirrors {@link firePostToolUse}.
 * Called only from handler catch paths — never from the success path. Errors
 * inside the hook are swallowed so a broken observer cannot reach the dispatcher.
 */
export function firePostToolUseFailure(
  toolName: string,
  errorMessage: string,
  signal: AbortSignal,
  deps: CoreExecDeps,
  input?: unknown,
): void {
  if (!deps.hookRegistry) return;
  const ctx: PostToolUseFailureContext = {
    event: 'PostToolUseFailure',
    toolName,
    error: errorMessage,
    ...(input !== undefined ? { input } : {}),
    ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
    ...(deps.parentSessionId !== undefined ? { parentSessionId: deps.parentSessionId } : {}),
  };
  void dispatchPostToolUseFailure(deps.hookRegistry, ctx, {
    signal,
    ...(deps.traceWriter ? { traceWriter: deps.traceWriter } : {}),
  }).catch((err: unknown) => {
    debugLog(`firePostToolUseFailure outer catch (tool=${toolName}): ${String(err)}`);
  });
}

// ---------------------------------------------------------------------------
// Output cap
// ---------------------------------------------------------------------------

/**
 * Reduce `result.content` to head+tail when a central `maxOutputBytes` cap is
 * armed AND the content exceeds it; otherwise return the result untouched.
 *
 * - No-op when `deps.maxOutputBytes` is undefined (top-level default) or the
 *   content already fits — {@link headAndTail} is idempotent, no double-truncation.
 * - NEVER touches `result.image`: the cap governs text only.
 * - Mutates and returns the same object, setting `truncated: true`.
 */
export function applyOutputCap(result: ToolResult, deps: CoreExecDeps): ToolResult {
  const cap = deps.maxOutputBytes;
  if (cap === undefined) return result;
  const originalBytes = Buffer.byteLength(result.content, 'utf8');
  if (originalBytes <= cap) return result;
  result.content = headAndTail(result.content, cap);
  result.truncated = true;
  // Observability (#661): fork-side truncation is otherwise invisible — the
  // `truncated` flag is a structured signal for downstream consumers, but the
  // ORIGINAL-vs-capped byte delta (how much a fork's tool actually
  // overflowed) is dropped. Emit it via the file's existing lightweight
  // logger (debugLog, gated on AFK_DEBUG/DEBUG).
  debugLog(
    `[output-cap #661] fork tool result capped: original=${originalBytes}B ` +
      `capped=${Buffer.byteLength(result.content, 'utf8')}B (cap=${cap}B)`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Compose executor dispatch
// ---------------------------------------------------------------------------

/**
 * Compose tool dispatch wrapper. Returns an error result when no executor
 * is configured rather than throwing.
 */
export async function executeCompose(call: ToolCall, deps: CoreExecDeps): Promise<ToolResult> {
  if (!deps.composeExecutor) {
    return {
      content: 'Compose tool is not available in this session configuration',
      isError: true,
    };
  }
  try {
    return await deps.composeExecutor.execute(call);
  } catch (err) {
    const message = errorMessage(err);
    return { content: `Compose tool error: ${message}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

/**
 * Core execution: agent routing + handler dispatch + PostToolUse hook.
 * Shared by both `execute()` (single-tool path) and `executeBatch()`
 * (after pre-hooks and permissions are already handled). Wrapped by
 * {@link executeCore}, which applies the central output-cap backstop.
 */
export async function executeCoreInner(call: ToolCall, deps: CoreExecDeps): Promise<ToolResult> {
  // Agent dispatch and model cancellation share the provider-level executor.
  if (isSubagentProviderTool(call.name)) {
    const outcome = await executeSubagentProviderTool(deps.subagentExecutor, call);
    if (outcome.thrownMessage !== undefined) {
      firePostToolUseFailure(call.name, outcome.thrownMessage, call.signal, deps, call.input);
    } else {
      firePostToolUse(call.name, outcome.result.content, call.signal, deps, call.input, outcome.result);
    }
    return outcome.result;
  }

  // Skill tool — provider-level dispatch
  if (call.name === 'skill') {
    if (!deps.skillExecutor) {
      return {
        content: 'Skill tool is not available in this session configuration',
        isError: true,
      };
    }
    let result: ToolResult;
    let skillThrew = false;
    let skillErrMsg = '';
    try {
      result = await deps.skillExecutor.execute(call);
    } catch (err) {
      skillThrew = true;
      skillErrMsg = errorMessage(err);
      result = { content: `Skill tool error: ${skillErrMsg}`, isError: true };
    }
    if (skillThrew) {
      firePostToolUseFailure(call.name, skillErrMsg, call.signal, deps, call.input);
    } else {
      firePostToolUse(call.name, result.content, call.signal, deps, call.input, result);
    }
    return result;
  }

  // Compose tool — DAG-based parallel subagent dispatch
  if (call.name === 'compose') {
    const result = await executeCompose(call, deps);
    firePostToolUse(call.name, result.content, call.signal, deps, call.input, result);
    return result;
  }

  // Handler lookup
  const handler = deps.handlers.get(call.name);
  if (!handler) {
    const msg = unknownToolMessage(call.name, deps);
    await emitPreToolUseBlock(call.name, msg, deps.gateDeps());
    return { content: msg, isError: true, failureClass: 'permission-denied' };
  }

  let result: ToolResult;
  let handlerThrew = false;
  let handlerErrMsg = '';
  try {
    result = await handler(call.input, call.signal, deps.callHandlerContext(call));
  } catch (err) {
    handlerThrew = true;
    handlerErrMsg = errorMessage(err);
    result = { content: `Tool execution error: ${handlerErrMsg}`, isError: true };
  }

  // Invariant: exactly one of PostToolUse / PostToolUseFailure fires per call.
  if (handlerThrew) {
    firePostToolUseFailure(call.name, handlerErrMsg, call.signal, deps, call.input);
  } else {
    firePostToolUse(call.name, result.content, call.signal, deps, call.input, result);
  }
  return result;
}

/**
 * Core execution + central output-cap backstop. The single result path both
 * `execute()` and `executeBatch()` call per tool, so applying the cap here
 * (after {@link executeCoreInner} has run the handler AND fired PostToolUse)
 * bounds EVERY tool result exactly once. See
 * {@link CoreExecDeps.maxOutputBytes} and the long comment in `dispatcher.ts`.
 *
 * Ordering: the cap is applied AFTER executeCoreInner returns — i.e. after
 * PostToolUse has already observed the full, uncapped content.
 */
export async function executeCore(call: ToolCall, deps: CoreExecDeps): Promise<ToolResult> {
  const result = await executeCoreInner(call, deps);
  return applyOutputCap(result, deps);
}
