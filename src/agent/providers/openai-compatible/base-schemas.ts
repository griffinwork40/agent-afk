/**
 * Surface-scoped builtin schema filter for the OpenAI-compatible provider.
 *
 * Extracted from `index.ts` (baselined over the 350-code-line ceiling, which
 * may shrink but never grow) so dispatcher wiring can be added there without
 * growth. Behaviour is unchanged.
 *
 * @module agent/providers/openai-compatible/base-schemas
 */

import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import { isWhatifEpisode } from '../../whatif-episode-gate.js';

/**
 * Invariant: skill-dispatch sub-agents must never pause to ask the operator
 * "which skill?" nor mutate the operator's environment. Strip `ask_question`
 * (operator-prompt escape hatch) and `terminal_font_size` (an environment tool
 * a bare numeric skill arg can lure a confused model into), plus the clipboard
 * tools. Non-interactive surfaces drop the operator-facing tools. Parity with
 * the toolDefs filter in AnthropicDirectProvider. No skill calls either tool.
 *
 * Exception: what-if episodes (#2600) keep `ask_question` in the non-interactive
 * branch so the episode gate can log it as 'executed' and observe.ts can measure
 * firstAction='ask' / askedBeforeActing. The gate blocks the call immediately
 * with proceed-on-assumption guidance — observable without being interactive.
 */
export function selectBaseSchemas(
  schemas: AnthropicToolDef[],
  opts: { isSkillDispatch?: boolean; isNonInteractive?: boolean },
): AnthropicToolDef[] {
  if (opts.isSkillDispatch) {
    return schemas.filter(
      (t) =>
        t.name !== 'ask_question' &&
        t.name !== 'terminal_font_size' &&
        t.name !== 'clipboard_write' &&
        t.name !== 'clipboard_read',
    );
  }
  if (opts.isNonInteractive) {
    // In what-if episode mode, keep ask_question so its intent is observable
    // via the episode gate's tool log (#2600).
    if (isWhatifEpisode()) {
      return schemas.filter(
        (t) => t.name !== 'clipboard_read' && t.name !== 'clipboard_write',
      );
    }
    return schemas.filter(
      (t) => t.name !== 'ask_question' && t.name !== 'clipboard_read' && t.name !== 'clipboard_write',
    );
  }
  return schemas;
}
