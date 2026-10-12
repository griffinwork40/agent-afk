/**
 * The single "no human can approve a tool call" predicate for a session (#2302).
 *
 * Contract: returns true when no human is reachable to approve anything during
 * this session, so path-scoped safety hooks must not rely on interactive
 * approval. Both providers feed this into the dispatcher's `isNonInteractive`
 * option, which surfaces on every PreToolUse context as `nonInteractive`; that
 * context field stays the ONE headless signal the bash-restriction hook reads.
 *
 * Invariant: this is deliberately NOT `AgentConfig.isNonInteractive` alone.
 * That flag ALSO controls `ask_question` stripping, and daemon `pull` tasks set
 * it false so they keep `ask_question` (their handoff elicitation handler
 * persists the question and declines; see daemon/handoff-wiring.ts). A pull
 * task is still unattended (bypassPermissions, no live approver), so
 * `surface === 'daemon'` marks it headless here without touching the
 * ask_question strip, which keeps reading `isNonInteractive` directly.
 *
 * @module agent/providers/shared/headless-session
 */

import type { AgentConfig } from '../../types/config-types.js';

/** True when no human can approve a tool call in this session. */
export function isHeadlessSession(config: Pick<AgentConfig, 'isNonInteractive' | 'surface'>): boolean {
  return config.isNonInteractive === true || config.surface === 'daemon';
}
