/**
 * Foreground run + user-triggered promotion (Ctrl+B) for the Agent tool.
 *
 * Extracted from `subagent-executor.ts` `execute()`: the deeply-nested
 * foreground path — abort wiring, the promotion `Promise.race`, the
 * adopt-to-background handoff, success/failure telemetry + payload shaping, and
 * the try/finally cleanup that fires the in-turn SubagentStop and appends its
 * injectContext to the tool_result.
 *
 * Pure-ish: the executor's two in-flight maps and its background registry are
 * passed in as explicit parameters (state in), and the function returns the
 * `ToolResult` (or re-throws) — no `this`, no hidden coupling. The exact
 * ordering of telemetry emission, the promotion race, abort listener
 * add/remove, and the finally-block teardown is preserved verbatim; the inline
 * comments documenting those invariants move with the code.
 *
 * @module agent/tools/subagent/foreground-promotion
 */

import type { BackgroundAgentRegistry } from '../../background-registry.js';
import type { SubagentManager } from '../../subagent.js';
import { annotateIfIncomplete } from '../../subagent/result.js';
import { debugLog } from '../../../utils/debug.js';
import type { TraceOrigin, TraceActor } from '../../session/session-identity.js';
import type { ToolResult } from '../types.js';
import type { PromotedSubagentInfo } from '../subagent-executor.js';
import { emitTelemetry, truncate, measurePartial, buildFailurePayload } from './failure-payload.js';
import { appendInjectContext } from './inject-context.js';
import { teardownIsolatedWorktree } from '../handlers/worktree-managed.js';

type ForkedHandle = Awaited<ReturnType<SubagentManager['forkSubagent']>>;

/**
 * Promotion trigger registered per in-flight foreground subagent. `fire()`
 * resolves the executor's promotion signal (winning the race); `ready` resolves
 * with the created job once the handoff completes, or `null` if promotion could
 * not happen. Shared shape with `SubagentExecutor.promotionTriggers`.
 */
export interface PromotionTrigger {
  fire: () => void;
  ready: Promise<PromotedSubagentInfo | null>;
}

export interface RunForegroundArgs {
  handle: ForkedHandle;
  /** The dispatching tool-call's abort signal + id_prefix carrier. */
  signal: AbortSignal;
  prompt: string;
  /** Optional: sourced from `AgentInput.id_prefix` (`id_prefix?: string`); flows only into telemetry, which accepts undefined. */
  idPrefix: string | undefined;
  /** Child model for the promotion registry record; falls back to 'sonnet'. */
  model: string | undefined;
  /** Child manager to tear down in the finally (unless promoted). */
  childManager: SubagentManager | undefined;
  /** Routing-decision identity fields (empty when this executor lacks a surface). */
  identity: { origin?: TraceOrigin; actor?: TraceActor };
  depth: number;
  /** Optional: `IAgentSession.sessionId` is `string | undefined`; forwarded as-is into telemetry + registry (preserves the pre-extraction contract). */
  parentSessionId: string | undefined;
  /** May be undefined — promotion then falls through to a normal foreground await. */
  registry: BackgroundAgentRegistry | undefined;
  /** The executor's live promotion-trigger map (keyed by handle.id). */
  promotionTriggers: Map<string, PromotionTrigger>;
  /** The executor's live cancellable-handle map (keyed by handle.id). */
  activeForegroundHandles: Map<string, { cancel: () => Promise<void> }>;
  /**
   * Present when this dispatch runs in an isolated worktree (isolation:
   * "worktree"). Torn down in the finally unless the run was promoted to
   * background (the detached job then owns the tree; the sweep reclaims it
   * later). A dirty / commits-ahead tree is preserved and locked, not removed.
   */
  isolationTeardown?: { repoRoot: string; worktreePath: string };
}

/**
 * Run the foreground branch: race the run against a promotion signal, handle
 * success/failure, and clean up in a finally. Returns the `ToolResult`, or
 * re-throws on the defense-in-depth error path.
 */
export async function runForegroundWithPromotion(args: RunForegroundArgs): Promise<ToolResult> {
  const {
    handle,
    signal,
    prompt,
    idPrefix,
    model,
    childManager,
    identity,
    depth,
    parentSessionId,
    registry,
    promotionTriggers,
    activeForegroundHandles,
  } = args;

  // Wire abort: if signal fires, cancel the handle (foreground only —
  // see comment on the background branch above for why).
  const abortListener = () => {
    void handle.cancel();
  };
  signal.addEventListener('abort', abortListener, { once: true });

  const startedAt = Date.now();

  // ------------------------------------------------------------------
  // Promotion plumbing (user-triggered backgrounding of a running
  // foreground subagent — Ctrl+B).
  //
  // External constraint: the parent model is suspended at the single
  // `runToResult` await below for this subagent's entire lifetime, and
  // its progress reaches the UI through a side-channel progress sink —
  // NOT via events on the parent stream. So a keyboard flag polled in the
  // turn loop cannot interrupt this await. Instead we expose a promotion
  // trigger through the narrow SubagentControl seam: when fired, it wins a
  // race against the run; we hand the still-running handle to the
  // BackgroundAgentRegistry and return the same synthetic "running"
  // pointer the mode:'background' branch returns — unblocking the parent
  // turn while the subagent keeps running detached.
  //
  // `promoted` gates the finally so a promoted (detached) handle and its
  // child manager are NOT torn down here: the registry now owns the
  // handle's lifetime, bounded by parent-session abort exactly like a
  // natively-backgrounded job.
  // ------------------------------------------------------------------
  let promoted = false;
  let firePromotion!: () => void;
  const promotionSignal = new Promise<void>((resolve) => {
    firePromotion = resolve;
  });
  let resolveJob!: (info: PromotedSubagentInfo | null) => void;
  const jobReady = new Promise<PromotedSubagentInfo | null>((resolve) => {
    resolveJob = resolve;
  });
  promotionTriggers.set(handle.id, { fire: firePromotion, ready: jobReady });
  // Registry-independent cancel handle (soft-stop path). Removed in the same
  // finally as the promotion trigger below.
  activeForegroundHandles.set(handle.id, handle);

  // In-turn SubagentStop delivery.
  //
  // Invariant (delivery order — externally governed by the SDK tool-use
  // protocol): SubagentStop fires from `handle.teardown()` in the `finally`
  // below, which runs BEFORE this async execute() resolves and its
  // tool_result is assembled/sent. So a foreground `agent` fork can carry the
  // stop hook's `injectContext` (e.g. the shadow-verify nudge) in-turn — as
  // part of the SAME tool_result the parent sees — instead of via the
  // deferred queue channel. We therefore hoist the completion ToolResult into
  // `toolResult` (rather than returning inside the try) and, after teardown
  // records the note, append it to `toolResult.content`. Exactly-once:
  // `teardown({ deferInjectContextToCaller: true })` suppresses the queue
  // push for this stop, so the note rides the tool_result OR the queue, never
  // both. The promoted / error-rethrow / abort paths leave `toolResult`
  // unset, so no append happens on them (queue/registry semantics preserved).
  let toolResult: ToolResult | undefined;

  // Start the run but don't await it directly — race it against the
  // promotion signal. The same `runPromise` is handed to the registry on
  // promotion (it must NOT be re-run via runInBackground; see adoptRunning).
  const runPromise = handle.runToResult(prompt);
  try {
    const outcome = await Promise.race<
      | { kind: 'result'; result: Awaited<typeof runPromise> }
      | { kind: 'promote' }
    >([
      runPromise.then((result) => ({ kind: 'result' as const, result })),
      promotionSignal.then(() => ({ kind: 'promote' as const })),
    ]);

    // Promotion path: hand the in-flight handle to the background registry
    // and return the synthetic running pointer (mirrors mode:'background').
    // Falls through to await the run normally when no registry is wired or
    // the background-job cap is hit — the subagent is never dropped.
    if (outcome.kind === 'promote') {
      if (registry) {
        try {
          const job = registry.adoptRunning({
            handle,
            runPromise,
            prompt,
            model: model ?? 'sonnet',
            parentSessionId,
          });
          promoted = true;
          // Detach the end-of-turn abort bridge — the promoted job must
          // outlive the turn that spawned it, exactly like mode:'background'.
          signal.removeEventListener('abort', abortListener);
          resolveJob({ jobId: job.jobId, label: job.label });
          return {
            content: JSON.stringify({
              status: 'running' as const,
              jobId: job.jobId,
              subagentId: job.subagentId,
              label: job.label,
              message:
                `Subagent backgrounded by user (jobId=${job.jobId}). ` +
                `It keeps running detached; its result will be delivered into ` +
                `this context automatically with the next user message once it ` +
                `finishes. /bgsub:join ${job.jobId} remains available for manual replay.`,
            }),
          };
        } catch (e) {
          // Cap hit (or registry refusal): stay foreground. Mark the trigger
          // "not promoted" and await the run normally below.
          debugLog(
            'subagent-executor: promotion failed, staying foreground: ' +
              (e instanceof Error ? e.message : String(e)),
          );
          resolveJob(null);
        }
      } else {
        resolveJob(null);
      }
    }

    // Normal completion: result already in hand from the race, or promotion
    // fell through and we await the still-running run.
    const result = outcome.kind === 'result' ? outcome.result : await runPromise;

    // Extract success or failure
    if (result.status === 'succeeded' && result.message) {
      const rawContent = result.message.content;
      // Guard against non-string content (e.g. SDK may return a ContentBlock[])
      const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
      const trace = result.trace;
      void emitTelemetry({
        ...identity,
        event: 'subagent.completed',
        subagent_id: handle.id,
        parent_session_id: parentSessionId,
        status: result.status,
        duration_ms: Date.now() - startedAt,
        content_chars: content.length,
        depth,
        tool_call_count: trace?.toolCalls.length,
        // Preserve `false` ("confirmed absent") distinctly from `undefined`
        // ("no trace available"); `|| undefined` would collapse both.
        thinking_present: trace != null ? trace.thinkingPresent : undefined,
        tool_names: trace?.toolCalls.length
          ? JSON.stringify([...new Set(trace.toolCalls.map(tc => tc.name))])
          : undefined,
      });
      // Assign (don't return) so the finally can append the in-turn
      // SubagentStop injectContext after teardown. See `toolResult` above.
      // annotateIfIncomplete marks capped/stream-truncated partials so the
      // parent model doesn't treat them as a final answer (no-op if clean).
      toolResult = { content: annotateIfIncomplete(content, result.stopReason) };
      return toolResult;
    }

    const errorMessage =
      result.error?.message ?? 'Subagent failed with no output';
    const failedTrace = result.trace;
    void emitTelemetry({
      ...identity,
      event: 'subagent.failed',
      subagent_id: handle.id,
      id_prefix: idPrefix,
      parent_session_id: parentSessionId,
      status: result.status,
      duration_ms: Date.now() - startedAt,
      error_message: truncate(errorMessage),
      schema_error: result.schemaError
        ? truncate(result.schemaError.message)
        : undefined,
      partial_output_chars: measurePartial(result.partialOutput),
      depth,
      // Mirror trace fields on the failure path — failed subagents are the
      // highest-value debugging target and benefit most from this signal.
      tool_call_count: failedTrace?.toolCalls.length,
      thinking_present: failedTrace != null ? failedTrace.thinkingPresent : undefined,
      tool_names: failedTrace?.toolCalls.length
        ? JSON.stringify([...new Set(failedTrace.toolCalls.map(tc => tc.name))])
        : undefined,
    });
    // Audit §F.1: surface a structured JSON payload to the parent model
    // instead of a plain error string, so the model can distinguish
    // schema mismatch / partial output / hard failure rather than seeing
    // a flattened "Subagent failed: ..." line.
    const payload = buildFailurePayload({
      status: result.status,
      errorMessage,
      schemaErrorMessage: result.schemaError?.message,
      partialOutput: result.partialOutput,
      subagentId: handle.id,
    });
    // Assign (don't return) so the finally can append the in-turn
    // SubagentStop injectContext after teardown. See `toolResult` above.
    toolResult = {
      content: JSON.stringify(payload),
      isError: true,
    };
    return toolResult;
  } catch (err) {
    // Defense in depth: an unexpected throw (e.g. timeout that surfaces
    // as a rejection rather than a `failed` status) should still emit
    // telemetry before propagating. The outer call chain treats a thrown
    // execute() as an error path; we preserve that by re-throwing.
    const message = err instanceof Error ? err.message : String(err);
    void emitTelemetry({
      ...identity,
      event: 'subagent.failed',
      subagent_id: handle.id,
      id_prefix: idPrefix,
      parent_session_id: parentSessionId,
      status: 'failed',
      duration_ms: Date.now() - startedAt,
      error_message: truncate(message),
      depth,
    });
    throw err;
  } finally {
    promotionTriggers.delete(handle.id);
    activeForegroundHandles.delete(handle.id);
    // Safety net: if the run won the race (or threw) before a fired
    // promotion could be honored, resolve the trigger so a concurrent
    // promoteActiveForeground() await never hangs. Idempotent — a no-op
    // once resolveJob has already settled on the promotion path.
    resolveJob(null);
    if (!promoted) {
      signal.removeEventListener('abort', abortListener);
      await childManager?.teardownAll();
      // Defer the SubagentStop injectContext to this caller so it rides the
      // tool_result in-turn instead of the deferred queue. teardown() fires
      // SubagentStop; with deferInjectContextToCaller the queue push is
      // suppressed and the note (if any) is readable below.
      await handle.teardown({ deferInjectContextToCaller: true });
      // In-turn append: only when this foreground run produced a completion
      // ToolResult (success or structured failure). The error-rethrow path
      // leaves toolResult unset — nothing to append to, note is dropped for
      // that stop by design (the throw is the parent's signal; keep-drop
      // confirmed in #392, queue-fallback rejected — rationale in
      // inject-context.ts). Attribution: the note is appended to THIS
      // subagent's own result, so a parent batching multiple `agent` calls
      // sees each nudge next to its result. Optional-chain: real
      // SubagentHandleImpl always defines this; the `?.()` tolerates narrow
      // handle doubles (returns undefined = no note).
      const injectContext = handle.getLastStopInjectContext?.();
      appendInjectContext(toolResult, injectContext);

      // isolation:"worktree" teardown — remove the child's worktree now that it
      // has finished. A dirty / commits-ahead tree is preserved and locked
      // (WIP is never destroyed); the promoted path skips this (guarded by
      // !promoted) so a still-running detached job keeps its tree. Best-effort:
      // teardownIsolatedWorktree never throws, so it cannot break the finally.
      if (args.isolationTeardown) {
        const { repoRoot, worktreePath } = args.isolationTeardown;
        const outcome = await teardownIsolatedWorktree({ repoRoot, worktreePath });
        if (outcome.preserved) {
          debugLog(
            `[isolation] preserved worktree ${worktreePath} (${outcome.reason}) — ` +
              `locked so the sweep will not reap it; recover via the worktree tool`,
          );
        }
      }
    }
  }
}
