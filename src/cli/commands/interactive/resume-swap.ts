import { resumeConfigFor, type ResolvedResumeTarget } from '../../resume-session.js';
import { autoRegisterPluginPassthroughs } from '../../slash/plugin-skills.js';
import { formatCost, formatTokens } from '../../format-utils.js';
import { palette } from '../../palette.js';
import { formatStatusFields, printResumeBanner, reseedStatsFromStored, type ResumeSwapResult, type CompletionWriter } from './shared.js';
import type { SessionRef } from '../../../agent/session-ref.js';
import type { SessionStats } from '../../slash/types.js';
import type { ContextSampler } from '../../context-sampler.js';
import type { StatusLine } from '../../status-line.js';
import type { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import type { AgentSession } from '../../../agent/session.js';

/**
 * Redact credential-shaped substrings from an error message before logging.
 * Patterns: Bearer tokens, API keys (sk-ant-…, sk-…), Authorization headers.
 * Prevents accidental credential leakage through catch-site logging.
 */
function redactMessage(msg: string): string {
  return msg
    .replace(/\bsk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, 'sk-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [REDACTED]')
    .replace(/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]');
}

function warnVia(completionWriter: CompletionWriter, label: string, err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err);
  completionWriter.fn(palette.warning(`⚠ [resume-swap] ${label}: ${redactMessage(raw)}`));
}

/**
 * Pure dependencies the resume-swap sequence needs. Injecting `buildSession`
 * (rather than calling buildAgentSession directly) keeps the function unit-
 * testable without spinning up a real AgentSession.
 */
export interface ResumeSwapDeps {
  sessionRef: SessionRef;
  stats: SessionStats;
  contextSampler: ContextSampler;
  statusLine: StatusLine;
  backgroundRegistry: BackgroundAgentRegistry;
  completionWriter: CompletionWriter;
  isInFlight: () => boolean;
  onSwapped: (target: ResolvedResumeTarget) => void;
  /** Build a fresh AgentSession for the given target. Mock in tests. */
  buildSession: (target: ResolvedResumeTarget) => AgentSession;
}

/**
 * Execute the 11-step mid-session swap sequence. Pure with respect to the
 * deps it's given; mutates state in `deps` and `sessionRef.current` in
 * place. Returns `{ ok: false, reason }` on in-flight refusal; otherwise
 * `{ ok: true, sessionId }`.
 *
 * Invariant: sessionRef.current must always point at a live, initialized
 * session. The new session is fully built and initialized BEFORE any
 * externally-observable state (sessionRef.current, contextSampler binding)
 * is mutated. If buildSession throws or waitForInitialization rejects, the
 * old session remains current and is NOT closed.
 * External constraint: the pointer flip is a one-way door — once flipped,
 * callers reading sessionRef.current see the new session. Therefore all
 * fallible operations on the new session must complete successfully before
 * the flip occurs.
 *
 * Step sequence (load-bearing — order governed by the invariant above):
 *
 *   1. Refuse if a turn is in flight.
 *   2. Build new session — if throws, old session stays live and current.
 *   3. Wait for new session init — if rejects, close new, old stays current.
 *      External constraint (PR #355 C1): no observable mutation of the
 *      outgoing session's environment is permitted until both build and
 *      init succeed. Background jobs MUST NOT be cancelled before this
 *      point — a build/init failure rolls back the swap, but cancelled
 *      background jobs are unrecoverable. Cancel only after commit.
 *   4. Cancel background jobs (commit point — owned by the outgoing session).
 *   5. Close outgoing session (fires SessionEnd, flushes MemoryStore).
 *   6. Pointer-flip sessionRef.current.
 *   7. Reseed stats from target.stored (or reset to zero if absent).
 *   8. Notify owner via onSwapped (typically: mutate ctx.resumeTarget).
 *   9. Rebind ContextSampler to new session (attach() resets cache).
 *  10. Re-fire plugin passthroughs (idempotent).
 *  11. Print "Resuming…" banner.
 *  12. Repaint status line.
 */
export async function performResumeSwap(
  target: ResolvedResumeTarget,
  deps: ResumeSwapDeps,
): Promise<ResumeSwapResult> {
  // Step 1 — Refuse if a turn is in flight.
  if (deps.isInFlight() === true) {
    return { ok: false, reason: 'A turn is in flight — wait for it to finish before resuming.' };
  }

  // Step 2 — Build the new session with the target's resume config.
  // INVARIANT: build before touching any externally-observable state so that
  // a constructor failure never leaves sessionRef.current pointing at a closed
  // or missing session. The old session is not closed until after both build
  // and init succeed.
  // External constraint (PR #355 C1): background jobs are owned by the
  // outgoing session and must not be cancelled before this point — a build
  // failure rolls back the swap, but cancelled background jobs cannot be
  // resurrected.
  let newSession: ReturnType<typeof deps.buildSession>;
  try {
    newSession = deps.buildSession(target);
  } catch (err: unknown) {
    // Old session is still open and current — no rollback needed.
    // Redact credentials before surfacing to the user — reason is printed by
    // src/cli/slash/commands/resume.ts via ctx.out.warn and SDK errors may
    // include Bearer/Authorization headers.
    const raw = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `buildSession failed: ${redactMessage(raw)}`,
    };
  }

  // Step 3 — Wait for the new session to initialize before committing.
  // INVARIANT: init must succeed before the pointer flip and sampler bind so
  // that sessionRef.current never points at a degraded session. On rejection,
  // close the new session and leave the old one live and current.
  // External constraint (PR #355 C1): background jobs still belong to the
  // outgoing session at this point — do not cancel them in the rollback path.
  let initFailReason: string | undefined;
  const initOk = await newSession.waitForInitialization().then(
    () => true,
    (err: unknown) => {
      // Redact at capture — `reason` is both printed via completionWriter
      // and returned to the slash-command surface for `ctx.out.warn`. SDK
      // 401/403 errors during init may echo Bearer tokens.
      initFailReason = redactMessage(err instanceof Error ? err.message : String(err));
      return false;
    },
  );
  if (!initOk) {
    // Close the new (failed) session to release its resources.
    await newSession.close().catch((err: unknown) => {
      warnVia(deps.completionWriter, 'new session close after init failure', err);
    });
    const reason = `Session initialization failed: ${initFailReason ?? 'unknown error'}`;
    deps.completionWriter.fn(palette.warning(`⚠ ${reason}`));
    return { ok: false, reason };
  }

  // Step 4 — Commit point. The new session is built and initialized; from
  // here we mutate the outgoing session's environment. Cancel background
  // jobs (mirrors interactive exit semantics) only now — cancellation is
  // unrecoverable, so it must follow the last fallible operation that could
  // roll the swap back.
  await deps.backgroundRegistry.cancelAll().catch((err: unknown) => {
    warnVia(deps.completionWriter, 'cancelAll failed', err);
  });

  // Step 5 — Close the outgoing session (fires SessionEnd, flushes MemoryStore).
  await deps.sessionRef.current.close().catch((err: unknown) => {
    warnVia(deps.completionWriter, 'session close failed', err);
  });

  // Step 6 — Atomic pointer flip. All subsequent reads now see newSession.
  deps.sessionRef.current = newSession;

  // Step 7 — Reseed stats from the stored payload.
  if (target.stored) {
    // Use the shared helper so bootstrap.ts and resume-swap.ts stay in sync.
    reseedStatsFromStored(deps.stats, target.stored, target.resumeId);
    // Clear per-turn cost/token accumulators — they belong to the outgoing
    // session and must not carry over into the resumed one.
    deps.stats.turnCosts = [];
    deps.stats.turnTokens = [];
  } else {
    // No stored data — reset all counters for a fresh session.
    deps.stats.totalTurns = 0;
    deps.stats.totalCostUsd = 0;
    deps.stats.totalTokens = 0;
    deps.stats.totalDurationMs = 0;
    deps.stats.turns = [];
    deps.stats.sessionId = target.resumeId;
    deps.stats.sessionStartTime = Date.now();
    // No stored model — keep the current model unchanged (no override available).
    deps.stats.turnCosts = [];
    deps.stats.turnTokens = [];
  }
  // Reset plan-mode state — the incoming session starts in default mode.
  // planMode is user-controlled state that does NOT persist in StoredSession
  // (by design: it's a per-session UI toggle, not a durable preference).
  // Carrying it forward would cause the resumed session to inherit an
  // unexpected permission mode from the outgoing session. pendingPlanExit
  // must also be cleared; leaving it set while planMode is false is incoherent.
  deps.stats.planMode = false;
  delete deps.stats.pendingPlanExit;

  // Step 8 — Update ctx.resumeTarget for potential banner helpers.
  // Wrapped in try/catch so a misbehaving onSwapped handler cannot abort the
  // swap sequence after the pointer flip has already occurred.
  try {
    deps.onSwapped(target);
  } catch (err: unknown) {
    warnVia(deps.completionWriter, 'onSwapped callback threw', err);
  }

  // Step 9 — Rebind ContextSampler to the new session source.
  // attach() resets the cache so the next status-line repaint fetches fresh
  // data from the new session. The closure-captured `contextSampler` is a
  // stable reference; callers that read it at call time (repaintStatusLine,
  // clearScreen) automatically pick up the new source without replacement.
  // Gated on successful init (above) — attaching to a degraded session would
  // produce stale or invalid context samples.
  deps.contextSampler.attach(newSession);

  // Step 10 — Re-fire plugin passthroughs (idempotent).
  // autoRegisterPluginPassthroughs is only run when init succeeded — running
  // it against a session that failed to initialize risks registering stale
  // or partially-constructed passthroughs.
  await autoRegisterPluginPassthroughs(newSession).catch((err: unknown) => {
    warnVia(deps.completionWriter, 'autoRegisterPluginPassthroughs failed', err);
  });

  // Step 11 — Print a "Resuming…" line.
  const resumingParts: string[] = [`↪ Resumed ${target.id}`];
  if (deps.stats.totalTurns > 0) resumingParts.push(`${deps.stats.totalTurns} prior turn${deps.stats.totalTurns === 1 ? '' : 's'}`);
  if (deps.stats.totalCostUsd > 0) resumingParts.push(formatCost(deps.stats.totalCostUsd));
  if (deps.stats.totalTokens > 0) resumingParts.push(formatTokens(deps.stats.totalTokens) + ' tokens');
  deps.completionWriter.fn(palette.brand(resumingParts.join('  ·  ')));

  // Step 11b — Surface a brief "where was I" cue under the resume line
  // (last user message + first sentence of last assistant reply + pointer
  // to /history). Mirrors the startup-time banner in interactive.ts. At
  // this point the persistent compositor IS armed (we're mid-REPL), so
  // completionWriter.fn routes through commitAbove rather than direct
  // stdout — this is the load-bearing reason we accept a writer rather
  // than calling process.stdout.write directly. See printResumeBanner's
  // docblock for the transport rationale.
  printResumeBanner(deps.stats, deps.completionWriter);

  // Step 12 — Repaint status line.
  deps.statusLine.repaint(formatStatusFields(deps.stats, deps.contextSampler));

  return { ok: true, sessionId: newSession.sessionId ?? deps.stats.sessionId ?? target.resumeId };
}

// Re-export resumeConfigFor so callers constructing buildSession don't need a
// separate import from ../../resume-session.js.
export { resumeConfigFor };
