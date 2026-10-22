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

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { BackgroundAgentRegistry } from '../../background-registry.js';
import type { BackgroundDelivery } from './background-delivery.js';
import type { SubagentManager } from '../../subagent.js';
import { debugLog } from '../../../utils/debug.js';
import type { TraceOrigin, TraceActor } from '../../session/session-identity.js';
import type { TraceSink } from '../../trace/index.js';
import { emitQueuedUserMessage } from '../../trace/emit.js';
import type { ToolResult } from '../types.js';
import { appendInjectContext } from './inject-context.js';
import { claimQueuedNote, type QueuedNoteClaim } from './queued-note.js';
import { teardownIsolatedWorktree } from '../handlers/worktree-managed.js';
import { lockWorktreeForBackground, unlockWorktreeForPromotion } from '../handlers/worktree-managed.background.js';
import { prepareForegroundRun, foregroundCompletionResult, emitForegroundRejection, foregroundPromotionPayload, reportPreservedForegroundWorktree, adoptForegroundRun } from './foreground-handoff.js';
import { withProvenanceHeader } from './foreground-promotion.provenance.js';
import { errorMessage } from '../../../utils/errors.js';
export { withProvenanceHeader };

/** Identity of a subagent that was promoted from foreground to background. */
export interface PromotedSubagentInfo {
  jobId: string;
  label: string;
  /** True when the child shares the parent's worktree (no isolation). See #1513. */
  sharesWorktree?: boolean;
}

type ForkedHandle = Awaited<ReturnType<SubagentManager['forkSubagent']>>;

/**
 * Promotion trigger registered per in-flight foreground subagent. `fire()`
 * resolves the executor's promotion signal (winning the race); `ready` resolves
 * with the created job once the handoff completes, or `null` if promotion could
 * not happen. Shared shape with `SubagentExecutor.promotionTriggers`.
 *
 * `fire()` optionally carries a {@link QueuedNoteClaim} — the REPL user's
 * typed-ahead messages, flushed into this turn by the same Ctrl+B keypress that
 * triggered promotion. The claim is shared across every trigger fired by one
 * keypress; whichever promotion succeeds first claims it, so the note is
 * delivered exactly once (and not at all if none succeed).
 */
export interface PromotionTrigger {
  fire: (queuedNote?: QueuedNoteClaim) => void;
  ready: Promise<PromotedSubagentInfo | null>;
}

export interface RunForegroundArgs {
  handle: ForkedHandle;
  /** The dispatching tool-call's abort signal + id_prefix carrier. */
  signal: AbortSignal;
  prompt: string | ContentBlockParam[];
  /** Plain string prompt retained for background promotion metadata. */
  backgroundPrompt: string;
  /** Optional: sourced from `AgentInput.id_prefix` (`id_prefix?: string`); flows only into telemetry, which accepts undefined. */
  idPrefix: string | undefined;
  /** Child model for the promotion registry record; falls back to 'sonnet'. */
  model: string | undefined;
  /**
   * Parent session's model. Used ONLY to decide whether to stamp a provenance
   * header on the returned result — the header is added only when the child ran
   * on a different model than the parent (the mixed-model fan-out case, where
   * the parent benefits from knowing which model produced a finding). Absent in
   * contexts that don't wire it, in which case no header is ever added.
   */
  parentModel?: string;
  /** Child manager to tear down in the finally (unless promoted). */
  childManager: SubagentManager | undefined;
  /** Routing-decision identity fields (empty when this executor lacks a surface). */
  identity: { origin?: TraceOrigin; actor?: TraceActor };
  traceWriter?: TraceSink;
  depth: number;
  /** Optional: `IAgentSession.sessionId` is `string | undefined`; forwarded as-is into telemetry + registry (preserves the pre-extraction contract). */
  parentSessionId: string | undefined;
  /** May be undefined — promotion then falls through to a normal foreground await. */
  registry: BackgroundAgentRegistry | undefined;
  /** How a promoted job's result reaches the dispatcher. See background-delivery.ts. */
  delivery?: BackgroundDelivery;
  /** The executor's live promotion-trigger map (keyed by handle.id). */
  promotionTriggers: Map<string, PromotionTrigger>;
  /** The executor's live cancellable-handle map (keyed by handle.id). */
  activeForegroundHandles: Map<string, { cancel: () => Promise<void> }>;
  /**
   * Present when this dispatch runs in an isolated worktree (isolation:
   * "worktree"). Torn down in the finally unless the run was promoted to
   * background (the detached job then owns the tree; markTerminal() unlocks +
   * tears it down via onCleanup when the job settles). A dirty / commits-ahead
   * tree is preserved and locked, not removed.
   */
  isolationTeardown?: { repoRoot: string; worktreePath: string };
  /**
   * Item 4: optional delegation-budget release callback. When set and the
   * foreground run is promoted to background, this callback is deferred to
   * the registry's `onSettled` hook so the concurrent slot stays charged
   * until the promoted job actually settles — not when this function returns.
   * When not promoted (normal foreground completion), the CALLER releases via
   * this same reference after `runForegroundWithPromotion` resolves.
   */
  budgetRelease?: () => void;
  /**
   * Item 4: mutable flag flipped synchronously when promotion succeeds and
   * `budgetRelease` ownership is transferred to the registry's `onSettled`
   * hook. The executor checks this after the call to decide whether to release
   * the slot itself (`true` → registry owns it; `false` → caller releases).
   */
  promotionTookBudget?: { value: boolean };
  /** Called synchronously once the run is adopted by the background registry (continuation stamping, D6). */
  onPromoted?: () => void;
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
    childManager,
    backgroundPrompt,
    model,
    parentModel,
    parentSessionId,
    identity,
    depth,
    idPrefix,
    traceWriter,
    registry,
    promotionTriggers,
    activeForegroundHandles,
    budgetRelease,
    promotionTookBudget,
  } = args;

  // Invariant: abort wiring precedes trigger registration, which precedes starting the run.
  const { abortListener, startedAt, promotionSignal, resolveJob } = prepareForegroundRun(args);
  let promoted = false;

  // Invariant (in-turn SubagentStop delivery): SubagentStop fires from `handle.teardown()` in the
  // `finally` below, BEFORE execute() resolves, so a foreground `agent` fork carries the stop
  // hook's `injectContext` in-turn. We hoist into `toolResult` and append after teardown.
  // `teardown({ deferInjectContextToCaller: true })` suppresses the queue push — note rides
  // the tool_result OR the queue, never both. Promoted/error/abort paths leave `toolResult`
  // unset so no append happens on them (queue/registry semantics preserved).
  let toolResult: ToolResult | undefined;

  // Invariant: start once, outside try, before racing; retain the result-first race operand order.
  // Start the run but don't await it directly — race it against the
  // promotion signal. The same `runPromise` is handed to the registry on
  // promotion (it must NOT be re-run via runInBackground; see adoptRunning).
  const runPromise = handle.runToResult(prompt);
  try {
    const outcome = await Promise.race<
      | { kind: 'result'; result: Awaited<typeof runPromise> }
      | { kind: 'promote'; queuedNote: QueuedNoteClaim | undefined }
    >([
      runPromise.then((result) => ({ kind: 'result' as const, result })),
      promotionSignal.then((queuedNote) => ({ kind: 'promote' as const, queuedNote })),
    ]);

    // Promotion path: hand the in-flight handle to the background registry
    // and return the synthetic running pointer (mirrors mode:'background').
    // Falls through to await the run normally when no registry is wired or
    // the background-job cap is hit — the subagent is never dropped.
    if (outcome.kind === 'promote') {
      if (registry) {
        // Hoist isoTd so the catch block can unlock on cap-hit / refusal.
        // Invariant: if lockWorktreeForBackground() succeeds but adoptRunning()
        // throws, the worktree would stay permanently locked (git refuses
        // `worktree remove` on a locked tree). The catch block unlocks it so the
        // foreground finally can tear it down normally.
        const isoTd = args.isolationTeardown;
        try {
          // Invariant: await the worktree lock before handing to the registry — the promoted
          // job outlives the foreground finally that would have torn it down.
          if (isoTd) await lockWorktreeForBackground(isoTd.repoRoot, isoTd.worktreePath);
          // Invariant: adoption is synchronous after the lock await; ownership flips in this continuation.
          const job = adoptForegroundRun({ handle, backgroundPrompt, model, parentSessionId, budgetRelease }, registry, runPromise, isoTd);
          promoted = true;
          args.onPromoted?.();
          // Item 4: signal the caller that the registry owns budgetRelease now.
          if (promotionTookBudget !== undefined && budgetRelease !== undefined) {
            promotionTookBudget.value = true;
          }
          // Invariant: mark promotion and budget transfer before detaching abort, then resolve ready.
          // Detach the end-of-turn abort bridge — the promoted job must
          // outlive the turn that spawned it, exactly like mode:'background'.
          signal.removeEventListener('abort', abortListener);
          // Absence of isolationTeardown means the child runs in the parent's
          // worktree — flag this so the TUI can warn the user (#1513).
          resolveJob({ jobId: job.jobId, label: job.label, sharesWorktree: !isoTd });
          // Invariant: payload shaping stays synchronous, before claiming the queued note.
          const promotedPayload = foregroundPromotionPayload(job, args.delivery);
          // Invariant: claim the queued note only AFTER `adoptRunning` succeeded
          // and `promoted` is set. The cap-hit / registry-refusal path below
          // throws out of `adoptRunning` and falls through to a normal
          // foreground await — there is no promotion tool_result for the note to
          // ride there, so leaving the claim unclaimed is what tells the REPL to
          // keep the message queued instead of dropping it.
          const queuedUserMessage = claimQueuedNote(outcome.queuedNote);
          if (queuedUserMessage !== undefined) {
            // Invariant: claim → await witness → structural carrier. The trace
            // records only size/job identity (never raw user text), and the model
            // receives authority outside child-controlled `content`.
            await emitQueuedUserMessage(traceWriter, {
              jobId: job.jobId,
              subagentId: job.subagentId,
              byteLength: Buffer.byteLength(queuedUserMessage, 'utf8'),
            });
          }
          const promotedResult: ToolResult = {
            content: JSON.stringify(promotedPayload),
            ...(queuedUserMessage !== undefined
              ? { harnessUserMessage: { kind: 'queued_user_message' as const, text: queuedUserMessage } }
              : {}),
          };
          return promotedResult;
        } catch (e) {
          // Cap hit (or registry refusal): stay foreground. Mark the trigger
          // "not promoted" and await the run normally below.
          debugLog(
            'subagent-executor: promotion failed, staying foreground: ' +
              (errorMessage(e)),
          );
          // Invariant: await unlock before resolving ready(null) and awaiting the original run.
          // If the worktree was locked (before adoptRunning threw), unlock it
          // now. The foreground finally will handle full teardown; a locked
          // tree would cause `git worktree remove` to fail and leak permanently.
          if (isoTd) {
            try {
              await unlockWorktreeForPromotion(isoTd.repoRoot, isoTd.worktreePath);
            } catch (unlockErr) {
              debugLog(
                `[isolation] failed to unlock worktree after promotion failure: ${String(unlockErr)}`,
              );
            }
          }
          resolveJob(null);
        }
      } else {
        resolveJob(null);
      }
    }

    // Invariant: refusal/no registry falls back to awaiting the same run, never restarting it.
    // Normal completion: result already in hand from the race, or promotion
    // fell through and we await the still-running run.
    const result = outcome.kind === 'result' ? outcome.result : await runPromise;

    // Invariant: shape synchronously and assign before teardown appends the stop note.
    toolResult = foregroundCompletionResult({ handle, identity, parentSessionId, depth, model, parentModel, idPrefix }, result, startedAt);
    return toolResult;
  } catch (err) {
    // Defense in depth: an unexpected throw (e.g. timeout that surfaces
    // as a rejection rather than a `failed` status) should still emit
    // telemetry before propagating. The outer call chain treats a thrown
    // execute() as an error path; we preserve that by re-throwing.
    // Invariant: unexpected-failure telemetry is emitted before rethrow and finally cleanup.
    emitForegroundRejection({ identity, handle, idPrefix, parentSessionId, depth }, err, startedAt);
    throw err;
  } finally {
    // Invariant: remove both control-map entries and settle ready before any teardown awaits.
    promotionTriggers.delete(handle.id);
    activeForegroundHandles.delete(handle.id);
    // Safety net: if the run won the race (or threw) before a fired
    // promotion could be honored, resolve the trigger so a concurrent
    // promoteActiveForeground() await never hangs. Idempotent — a no-op
    // once resolveJob has already settled on the promotion path.
    resolveJob(null);
    if (!promoted) {
      // Invariant: detach abort → await child-manager teardown → await handle stop → append context.
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
      // has finished. A dirty / commits-ahead / ignored-local-state tree is
      // preserved and locked (WIP and non-rebuildable ignored files are never
      // destroyed); the promoted path skips this (guarded by !promoted) so a
      // still-running detached job keeps its tree. Best-effort:
      // teardownIsolatedWorktree never throws, so it cannot break the finally.
      // Invariant: isolated worktree teardown follows stop-context append; promoted jobs skip it.
      if (args.isolationTeardown) {
        const { repoRoot, worktreePath } = args.isolationTeardown;
        const outcome = await teardownIsolatedWorktree({ repoRoot, worktreePath });
        if (outcome.preserved) {
          reportPreservedForegroundWorktree(worktreePath, outcome);
        }
      }
    }
  }
}
