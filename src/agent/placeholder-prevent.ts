/**
 * SessionStart hook: proactive placeholder-prevention instruction (Layer 1).
 *
 * Injects a brief instruction into the session's first turn context telling
 * the model to resolve placeholder values from context before including them
 * in shell commands or code blocks, and to flag unresolvable ones prominently
 * rather than leaving them silent.
 *
 * ## Two-layer placeholder defense
 *
 * This hook is Layer 1 (Prevention) of the two-layer defense established in
 * issue #2125:
 *
 * ```
 * Layer 1 (Prevention): SessionStart injectContext  ← this hook
 *   → Model is instructed to resolve/mark placeholders before output
 *   → Works on all surfaces (Telegram, daemon, chat)
 *   → Non-deterministic — the model may still generate placeholders
 *
 * Layer 2 (Correction): Stop hook (placeholder-detect.ts)
 *   → Scans shellable code blocks for placeholder patterns
 *   → Injects correction into the next turn
 *   → REPL-only, deterministic, bounded at 2 per session
 * ```
 *
 * Prevention is non-deterministic — the model may still generate placeholders
 * despite the instruction. The Stop hook (Layer 2) serves as the escape-
 * catcher: it fires when prevention fails, bouncing a targeted correction
 * into the next turn.
 *
 * ## Surface scope
 *
 * `dispatchSessionStart` already skips subagent forks (gated on
 * `parentSessionId` being absent in AgentSession.pullInitialization), so
 * this handler fires for top-level sessions only — matching exactly the scope
 * the Stop-hook Layer 2 targets. No additional guard is needed here.
 *
 * @module agent/placeholder-prevent
 */

import type { HookContext, HookDecision, HookHandler } from './hooks.js';
import { debugLog } from '../utils/debug.js';

// ─── Prevention instruction ──────────────────────────────────────────────────

/**
 * The instruction injected into the session's first turn context.
 *
 * Deliberately brief: this is a priming nudge, not a system-prompt replacement.
 * Longer instructions would consume more tokens on every session for marginal
 * prevention gain — the Stop-hook correction provides the backstop.
 */
const PREVENTION_INSTRUCTION =
  '[placeholder-prevent] When including shell commands or code blocks in your ' +
  'response, resolve placeholder values from available context (env, config, ' +
  'prior output) before presenting them. If a value is genuinely unknown, wrap ' +
  'it in a prominent callout — e.g. "⚠ Replace `<your-token>` with ..." — so ' +
  'the user cannot miss that substitution is required. Do not leave silent ' +
  'unresolved placeholders (e.g. `your-user@mac-mini-ip`, `<YOUR_API_KEY>`, ' +
  '`REPLACE_ME`) in runnable commands.';

// ─── SessionStart hook ───────────────────────────────────────────────────────

/**
 * Build a `SessionStart` hook handler that injects the placeholder-prevention
 * instruction into the session's first turn context.
 *
 * - Fires for top-level sessions only. Subagent forks are already excluded by
 *   `AgentSession.pullInitialization` (gated on `parentSessionId` being
 *   absent), but this handler also guards on `context.parentSessionId` for
 *   defence-in-depth.
 * - Never blocks (always returns `continue: undefined`).
 * - Never throws — fails open so a bug here cannot prevent a session from
 *   starting. Matches the fail-open model of the Stop-hook Layer 2.
 *
 * @returns A `HookHandler` suitable for registration on the `'SessionStart'`
 *   event.
 */
export function createPlaceholderPreventHook(): HookHandler {
  return (context: HookContext): HookDecision => {
    if (context.event !== 'SessionStart') return {};
    // Skip subagent forks — prevention is only useful in top-level sessions.
    // AgentSession.pullInitialization already gates on this, but guard here
    // too for defence-in-depth (unit tests, non-standard callers).
    if (context.parentSessionId) return {};

    debugLog('[placeholder-prevent] injecting prevention instruction into session context', {
      sessionId: context.sessionId,
    });

    return { injectContext: PREVENTION_INSTRUCTION };
  };
}
