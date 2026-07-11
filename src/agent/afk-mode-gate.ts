/**
 * AFK-mode gate hook factory.
 *
 * Returns a `HookHandler` that governs high-risk / irreversible tool calls when
 * the session is in `'autonomous'` (AFK) mode. The handler reads the current
 * mode at call time (not at construction time), so toggling the mode
 * mid-session is reflected immediately without reconstructing the registry.
 *
 * Why a mechanical gate at all: AFK mode raises the agent's autonomy precisely
 * when no human is watching. The posture addendum
 * ({@link module:agent/providers/anthropic-direct/afk-mode-addendum}) asks the
 * model to stop at one-way doors, but posture text is not a safety mechanism.
 * This gate is the enforcement half — it governs the irreversible/destructive
 * operations that must never run unattended on a model's say-so.
 *
 * Policy: the single source of truth for "how dangerous is this op" is
 * {@link classifyRisk} (`risk-classifier.ts`) — the same taxonomy the status
 * line and audit log use. AFK mode treats anything it rates `'high'` as
 * requiring explicit operator approval:
 *   - destructive/irreversible bash (`rm`, `sudo`, `git push --force`,
 *     `git reset --hard`, `mkfs`/`dd`/`diskutil`, pipe-to-shell, `eval`,
 *     `chmod`/`chown`)
 *   - writes that escape the workspace, hit the write-denylist (`~/.ssh`,
 *     `/etc`, …), or target the `.git` object store
 *   - schedule mutations: `create_schedule` / `cancel_schedule` — modify the
 *     daemon cron store with potential immediate live-sync side-effects
 *   - MCP tools whose sub-name contains a destructive verb (the full list is
 *     `DESTRUCTIVE_VERBS` in `risk-classifier.ts` — the single source of truth;
 *     not duplicated here so it cannot drift) — arbitrary third-party server
 *     functions the classifier cannot introspect
 * `'medium'` ops (normal `git push`/`git commit`, installs, builds, file moves)
 * and `'safe'` ops (reads, tests, lint) are ALLOWED — autonomous work has to be
 * useful, and these are reversible enough to run unattended.
 *
 * High-risk handling (v1.5 — approve/deny round-trip):
 *   - MAIN session: instead of a hard block, route an approve/deny prompt to
 *     the operator via the module-scope {@link elicitationRouter}. In AFK mode
 *     that router is swapped to the ledger channel (`/afk on`), so the prompt
 *     renders on the operator's phone (racing the keyboard) and the signed
 *     answer round-trips back. Approve → the op runs (this single call); deny,
 *     decline, cancel, or no answer within the timeout → blocked. This reuses
 *     the proven elicitation hop and adds NO new ledger record. Because the
 *     wait blocks on a human, the gate is registered `longRunning: true` and
 *     forwards the turn signal so session/turn teardown cancels the prompt.
 *   - DENY-ON-TIMEOUT: the elicitation router has no deadline by design (an AFK
 *     operator may be away). For a *high-risk approval* we impose one anyway —
 *     an unanswered destructive op degrades to the safe default (refused),
 *     never silently runs and never stalls the run forever. The timer is armed
 *     by the `onActive` callback so it starts only once this request leaves the
 *     elicitation queue and is actually shown to the operator — a prior queued
 *     prompt's open time is never charged against this op's window.
 *   - SUBAGENTS: a forked sub-agent (`parentSessionId` set) never prompts — the
 *     prompt would surface on the parent's surface with no attribution. It hard-
 *     blocks, mirroring the path-approval hook's sub-agent auto-deny. The safety
 *     ceiling still applies tree-wide; only the *approval affordance* is main-
 *     session-only.
 *   - NO OPERATOR REACHABLE: when no elicitation handler is installed (headless
 *     surfaces, or AFK off), `route()` declines immediately → blocked. This is
 *     the legacy hard-block behavior, preserved as the safe degrade.
 *
 * Path-safety note: in `'autonomous'` mode the typed-file path-approval prompt
 * is disabled (`allowAll`, see `agent/permission-policy.ts`) so AFK does not
 * stall on keyboard prompts the operator cannot answer. That makes THIS gate
 * the sole path-containment layer in AFK — its workspace-escape rule (a
 * `write_file`/`edit_file` whose path resolves outside the session root →
 * `high` → approval-gated) is load-bearing, which is why the gate is wired with
 * a live `getCwd` (so a mid-session `/cwd` change cannot stale the boundary).
 *
 * `send_telegram` is ALWAYS exempt: it is the operator's channel in AFK mode,
 * and the posture explicitly relies on it to surface Asking states.
 *
 * Like the plan-mode gate, the bash classification is a best-effort honesty
 * guardrail, not a sandbox: bash is Turing-complete, so obfuscated writes can
 * slip through. It catches the destructive shapes a cooperative model naturally
 * emits and surfaces refusal/approval so the operator can take over.
 *
 * @module agent/afk-mode-gate
 */

import type { HookContext, HookDecision, HookHandler } from './hooks.js';
import type { PermissionMode } from './types/sdk-types.js';
import type { ElicitationRequest, ElicitationResult } from './types/sdk-types.js';
import type { TraceWriter } from './trace/index.js';
import { classifyRisk } from './risk-classifier.js';
import { elicitationRouter } from './elicitation-router.js';
import { emitHookDecision } from './trace/emit.js';
import { redactInlineSecrets } from './session/prompt-dump.js';

/** Default deny-on-timeout window for a high-risk approval (ms). */
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;
/** Cap the tool-input preview shown to the operator in the approval prompt. */
const MAX_INPUT_PREVIEW = 300;

export interface AfkModeGateOptions {
  /**
   * Max time to wait for an operator approve/deny before denying (deny-on-
   * timeout). Defaults to {@link DEFAULT_APPROVAL_TIMEOUT_MS}.
   */
  approvalTimeoutMs?: number;
  /**
   * When false, high-risk ops hard-block immediately (legacy behaviour) instead
   * of eliciting approval. Defaults to true.
   */
  promptForApproval?: boolean;
  /**
   * Elicitation entry point. Defaults to the module-scope
   * {@link elicitationRouter}. Injectable for tests.
   */
  route?: (
    request: ElicitationRequest,
    options: { signal: AbortSignal; onActive?: () => void },
  ) => Promise<ElicitationResult>;
  /**
   * Trace writer for structured audit events. When provided, the gate emits a
   * `hook_decision` event on every approval decision (approve, deny, timeout,
   * cancel, decline, or unrecognised choice). No-op when undefined.
   */
  traceWriter?: TraceWriter;
}

export function createAfkModeGate(
  getMode: () => PermissionMode,
  cwd?: string,
  getCwd?: () => string | undefined,
  opts?: AfkModeGateOptions,
): HookHandler {
  const approvalTimeoutMs = opts?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const promptForApproval = opts?.promptForApproval ?? true;
  const traceWriter = opts?.traceWriter;
  const route =
    opts?.route ??
    ((request: ElicitationRequest, options: { signal: AbortSignal; onActive?: () => void }) =>
      elicitationRouter.route(request, options));

  async function requestApproval(
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<HookDecision> {
    const start = Date.now();
    const request = buildApprovalRequest(toolName, input);

    // A child controller so a deny-on-timeout (or a parent turn abort) cancels
    // the pending elicitation prompt — the real router resolves to a decline on
    // abort, so the phone prompt does not linger past the decision.
    const ac = new AbortController();
    const onParentAbort = (): void => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }

    const TIMEOUT = Symbol('afk-approval-timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armTimer!: () => void;
    // Contract: timeoutP resolves only after armTimer() is called (i.e. once
    // this request leaves the elicitation queue and is shown to the operator).
    // If onActive never fires (no handler / pre-aborted / aborted-in-queue),
    // the timer is never armed and timeoutP never resolves — that's correct,
    // because route() resolves DECLINE and wins the race. This ensures a prior
    // queued prompt's open time is never charged against this op's window.
    const timeoutP = new Promise<typeof TIMEOUT>((resolve) => {
      armTimer = () => {
        if (timer) return; // idempotent
        // Start the deny-on-timeout window only once this request leaves the
        // elicitation queue and is shown to the operator, so a prior queued
        // prompt's open time is not charged against this op's window.
        timer = setTimeout(() => {
          ac.abort();
          resolve(TIMEOUT);
        }, approvalTimeoutMs);
        timer.unref?.();
      };
    });

    // Helper to emit the structured audit trace and return the hook decision.
    // Called on every exit path from requestApproval — centralises the emit so
    // no path accidentally skips it, and keeps the mapping explicit.
    function decide(
      decision: HookDecision,
      approvalOutcome: 'approved' | 'denied' | 'unrecognised' | 'timeout' | 'decline' | 'cancel',
    ): HookDecision {
      const durationMs = Date.now() - start;
      const isBlock = decision.decision === 'block';
      void emitHookDecision(traceWriter, {
        hookEvent: 'PreToolUse',
        ...(isBlock ? { decision: 'block' as const } : {}),
        ...(isBlock && decision.reason !== undefined ? { reason: decision.reason } : {}),
        ...(isBlock ? { blockedTool: toolName } : {}),
        durationMs,
        approvalOutcome,
      });
      return decision;
    }

    let outcome: ElicitationResult | typeof TIMEOUT;
    try {
      // Race the operator's answer against the deny-on-timeout. Racing (rather
      // than relying on the handler to observe the abort) guarantees progress
      // even for a handler that ignores its signal. The timer is armed via
      // onActive so it starts only when the prompt is actually shown.
      outcome = await Promise.race([route(request, { signal: ac.signal, onActive: armTimer }), timeoutP]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onParentAbort);
    }

    if (outcome === TIMEOUT) {
      return decide(
        blockDecision(toolName, `no approval arrived within ${Math.round(approvalTimeoutMs / 1000)}s`),
        'timeout',
      );
    }
    if (outcome.action !== 'accept') {
      return decide(
        blockDecision(
          toolName,
          outcome.action === 'cancel'
            ? 'the operator cancelled the approval prompt'
            : 'no operator approval was available',
        ),
        outcome.action === 'cancel' ? 'cancel' : 'decline',
      );
    }
    const choice = String(outcome.content?.['choice'] ?? '').toLowerCase();
    if (choice === 'approve') return decide({}, 'approved'); // operator approved this single call
    if (choice === 'deny') return decide(blockDecision(toolName, 'the operator denied it'), 'denied');
    // action was 'accept' but choice ∉ {approve,deny} — a handler regression
    // (dropped/garbled choice), not a deliberate deny. Fail closed with a distinct,
    // diagnosable reason instead of masquerading as a deny.
    return decide(
      blockDecision(toolName, 'the approval prompt returned an unrecognised choice'),
      'unrecognised',
    );
  }

  return function afkModeGate(
    context: HookContext,
    signal?: AbortSignal,
  ): HookDecision | Promise<HookDecision> {
    if (context.event !== 'PreToolUse') return {};
    // No subagent guard on the ceiling itself, on purpose: the safety ceiling
    // applies tree-wide. (The approval *affordance* below is main-session-only.)
    if (getMode() !== 'autonomous') return {};

    const { toolName } = context;

    // The operator's channel is never gated — the posture relies on it to
    // surface Asking states from an unattended run.
    if (toolName === 'send_telegram') return {};

    // Single source of truth for risk. `workspaceRoot` is set to the session
    // cwd so writes that escape it are flagged `high` (classifyRisk's workspace
    // boundary rule). Resolution order, most-specific first:
    //   1. context.cwd — the dispatcher's per-call resolve base. Load-bearing
    //      for forked subagents: they intentionally share the parent hook
    //      registry, but their dispatcher runs in a sibling worktree, so the
    //      per-call cwd classifies a child's in-worktree write correctly instead
    //      of against the parent session's cwd. For the top-level session this
    //      tracks /cwd in lockstep with getCwd() (updateCwdDependents keeps the
    //      main dispatcher's resolveBase synced), so the two agree there.
    //   2. getCwd() — the live session cwd (tracks a mid-session /cwd change),
    //      preferred over the static construction-time cwd.
    //   3. the static construction-time cwd, then process.cwd().
    // This matters because in AFK the path-approval prompt is disabled
    // (allowAll), so this gate is the SOLE path-safety layer.
    const root = context.cwd ?? getCwd?.() ?? cwd ?? process.cwd();
    const risk = classifyRisk(toolName, context.input, {
      cwd: root,
      workspaceRoot: root,
    });

    if (risk !== 'high') return {};

    // High-risk in AFK. A forked sub-agent must not prompt the operator (the
    // prompt would surface on the parent's surface with no attribution), and the
    // approval path can be opted out — both degrade to the legacy hard block.
    if (context.parentSessionId !== undefined || !promptForApproval) {
      return blockDecision(toolName, 'AFK mode runs autonomously without a human watching');
    }

    // Main session: ask the operator to approve/deny (deny-on-timeout). Returns
    // a Promise<HookDecision>; the gate is registered `longRunning: true`.
    return requestApproval(toolName, context.input, signal);
  };
}

/** Build the approve/deny form elicitation (same shape the path-approval hook
 *  uses, so it renders via the proven REPL numbered-prompt / Telegram inline-
 *  keyboard path). */
function buildApprovalRequest(toolName: string, input: unknown): ElicitationRequest {
  const preview = clipInput(input);
  const message =
    `AFK: \`${toolName}\` is high-risk / irreversible and AFK mode runs ` +
    `unattended. Approve this single call?` +
    (preview ? `\n\nInput: ${preview}` : '');
  return {
    serverName: 'agent-afk',
    message,
    mode: 'form',
    title: 'AFK high-risk approval',
    requestedSchema: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          title: 'Approve this high-risk operation?',
          enum: ['approve', 'deny'],
          description:
            "'approve' runs this single call. 'deny' refuses it (the model " +
            'gets an error and should push an Asking summary or take a safe path).',
        },
      },
      required: ['choice'],
    },
  };
}

/**
 * Compact, bounded, secret-redacted preview of a tool input for the approval
 * prompt. Secrets are scrubbed via {@link redactInlineSecrets} BEFORE truncation
 * so a credential straddling the {@link MAX_INPUT_PREVIEW} boundary cannot leak a
 * partial value. This preview renders on the operator's phone in AFK mode, so it
 * gets the same redaction the AFK push path applies (see
 * cli/commands/interactive/afk-push.ts).
 */
function clipInput(input: unknown): string {
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (!s) return '';
  // Redact secrets before any truncation — a credential split across the
  // MAX_INPUT_PREVIEW boundary must not leak a partial value to the phone.
  s = redactInlineSecrets(s);
  return s.length > MAX_INPUT_PREVIEW ? `${s.slice(0, MAX_INPUT_PREVIEW)}… [truncated]` : s;
}

/** The refusal decision surfaced to the model, with a cause-specific tail. */
function blockDecision(toolName: string, why: string): HookDecision {
  return {
    decision: 'block',
    reason:
      `AFK mode: ${toolName} is refused — this op is high-risk or irreversible, ` +
      `and ${why}. Push an Asking summary to Telegram (send_telegram) and stop, ` +
      `or have the operator run /afk off and take over.`,
  };
}
