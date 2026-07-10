/**
 * REPL-backed elicitation handler — facade.
 *
 * History: split into `elicitation/` mode modules (#367). This file remains
 * as a facade re-exporting the original public surface so no import path
 * changes for existing consumers (`commands/interactive/bootstrap.ts`,
 * `commands/interactive/surface-setup.ts`, tests). Implementation now lives
 * in:
 *   - `elicitation/repl-shared.ts`    — `ReplElicitationDeps` + result singletons
 *   - `elicitation/url-mode.ts`       — URL-consent rendering
 *   - `elicitation/form-mode.ts`      — form schema parsing + field prompting
 *   - `elicitation/agent-question.ts` — `ask_question` overlays + fallbacks
 *   - `elicitation/repl-handler.ts`   — `makeReplElicitationHandler` factory
 */

export type { ReplElicitationDeps } from './elicitation/repl-shared.js';
export { makeReplElicitationHandler } from './elicitation/repl-handler.js';
