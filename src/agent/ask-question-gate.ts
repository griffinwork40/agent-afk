/**
 * Ask-question gate hook factory.
 *
 * PreToolUse gate on the `ask_question` built-in: when NO elicitation handler
 * is installed (daemon, scheduler, one-shot `afk chat` — no interactive
 * operator attached to this process), a question can never be answered
 * interactively. Without the gate, the elicitation router would park-and-notify
 * then auto-decline AFTER the round-trip, handing the model a bare
 * `{ action: 'decline' }` it may mishandle or retry. The gate moves that
 * outcome BEFORE the call and converts it into actionable guidance at the
 * moment of temptation:
 *
 *   - fires the same best-effort Telegram notification the router would have
 *     fired (park-and-notify is preserved — enforcement must not regress the
 *     operator's async visibility into what the agent wanted to know);
 *   - blocks with a reason instructing the model to proceed on a stated
 *     assumption, or end with a Blocked terminal state when no safe
 *     assumption exists.
 *
 * When a handler IS installed (REPL, Telegram), the gate is a no-op: waiting
 * minutes/hours for an AFK operator is the *designed* behavior of
 * `ask_question` (see `elicitation-router.ts` — deliberately no deadline).
 * Handler presence is probed at call time, so a handler installed after
 * registry construction (the normal bootstrap order) is observed correctly.
 *
 * The block lands in the witness trace as a `hook_decision` event
 * (`hook_block:ask_question`), which doubles as the gate's structured
 * catch-record for the failure-mode telemetry substrate. Classify it as a
 * deliberate guardrail firing — "working as designed" — not new friction.
 *
 * Migration provenance: first gate-skill → hook migration (the `ask-gate`
 * skill's reachability rule, made deterministic). Pattern precedent:
 * `plan-mode-gate.ts`. Plan: `.afk/plans/friction-substrate-and-gate-migration.md`.
 *
 * @module agent/ask-question-gate
 */

import type { HookContext, HookDecision } from './hooks.js';
import { elicitationRouter } from './elicitation-router.js';
import { pushIfConfigured } from '../telegram/push.js';

/**
 * Cap on the question text echoed to Telegram — mirrors the router's
 * `MAX_NOTIFY_MESSAGE_CHARS` rationale: the prompt is the minimal disclosure
 * the operator needs, and truncation bounds inadvertent exposure of any
 * sensitive text a model might embed in it.
 */
const MAX_NOTIFY_QUESTION_CHARS = 300;

/** Block reason surfaced to the model. Exported for tests and for surfaces
 *  that want to detect this specific gate in tool-error output. */
export const ASK_QUESTION_GATE_REASON =
  'ask_question gate: no interactive operator is attached to this surface ' +
  '(no elicitation handler — daemon/scheduled/one-shot run), so the question ' +
  'cannot be answered now. The operator has been notified asynchronously. ' +
  'Do not re-ask or wait. Choose the most reasonable interpretation, state ' +
  'the assumption explicitly in your final report for async review, and ' +
  'proceed. If no safe assumption exists and the next action would be ' +
  'irreversible, end the turn with a Blocked terminal state naming exactly ' +
  'what the operator must supply.';

export interface AskQuestionGateOptions {
  /**
   * Override the handler-availability probe. Default: the module-scope
   * {@link elicitationRouter}. Injected in tests.
   */
  hasHandler?: () => boolean;
  /**
   * Override the best-effort operator notification. Default: Telegram
   * `pushIfConfigured` (no-op when Telegram is unconfigured; transport
   * errors swallowed). Injected in tests.
   */
  notify?: (message: string) => void;
}

function defaultNotify(message: string): void {
  void pushIfConfigured(message).catch(() => undefined);
}

export function createAskQuestionGate(
  options: AskQuestionGateOptions = {},
): (context: HookContext) => HookDecision {
  const hasHandler = options.hasHandler ?? ((): boolean => elicitationRouter.hasHandler());
  const notify = options.notify ?? defaultNotify;

  return function askQuestionGate(context: HookContext): HookDecision {
    if (context.event !== 'PreToolUse') return {};
    if (context.toolName !== 'ask_question') return {};
    // Interactive operator attached — asking (and waiting) is legitimate.
    if (hasHandler()) return {};

    // Park-and-notify parity with the router's unattended path: the block
    // must not cost the operator their async visibility. Best-effort and
    // exception-proof — a notification failure never affects the decision.
    try {
      const question =
        typeof context.input === 'object' && context.input !== null
          ? String((context.input as Record<string, unknown>)['question'] ?? '')
          : '';
      const trimmed = question.trim();
      const text =
        trimmed.length <= MAX_NOTIFY_QUESTION_CHARS
          ? trimmed
          : `${trimmed.slice(0, MAX_NOTIFY_QUESTION_CHARS)}…(truncated)`;
      notify(
        '🔔 AFK question (auto-gated; agent proceeds on a stated assumption):\n' +
          (text !== '' ? text : '(question text unavailable)'),
      );
    } catch {
      // Observational only.
    }

    return { decision: 'block', reason: ASK_QUESTION_GATE_REASON };
  };
}
