/**
 * Preflight barrel: public API for the dispatcher.
 *
 * Importing this module does NOT register any preflights as a side effect
 * (A02 refactor). Call `initBuiltinPreflights()` once from the bootstrap
 * path (currently `registerBuiltinSkillCommands()` in builtin-skills.ts)
 * to activate built-in registrations before the first preflight lookup.
 */

import { registerPreflight, _sealBuiltinKeys } from './registry.js';
import { reviewPrPreflight } from './review-pr.js';

export { runPreflight, getPreflight, registerPreflight } from './registry.js';
export { getSkillPreflightDir } from './artifact-dir.js';
export { stitchForwardManifest } from './stitch-forward.js';
export type {
  SkillInvocation,
  PreflightContext,
  PreflightResult,
  SkillPreflight,
} from './types.js';

/** M2: Guards against duplicate bootstrap calls producing spurious stderr warnings. */
let _builtinsInitialized = false;

/**
 * Register all built-in preflights and seal the first-party key set.
 * Must be called exactly once during bootstrap (before the first slash
 * command dispatch). Safe to call multiple times — subsequent calls are
 * silent no-ops (M2 idempotency guard).
 *
 * A02: explicit init function replaces the previous module-evaluation
 * side-effect, so importing this barrel has no observable side effects.
 *
 * To add a new built-in preflight: append one `registerPreflight(...)` line
 * before the `_sealBuiltinKeys()` call below.
 */
export function initBuiltinPreflights(): void {
  if (_builtinsInitialized) return;
  _builtinsInitialized = true;

  // Invariant: registry key is the bare skill name that the slash dispatcher
  // computes via `parsed.name.replace(/^\//, '').split(':').pop()` —
  // `/review 277`, `/example-plugin:review 277`, and the native handler all
  // resolve to bare `'review'`. The plugin skill is named `review` (see
  // `~/.afk/plugins/.../example-plugin/skills/review/SKILL.md`); no `/review-pr`
  // command exists. The prior `'review-pr'` registration was a no-op in
  // production — no slash command ever produced that bare name.
  registerPreflight('review', reviewPrPreflight);

  // F03: seal all built-in keys so plugins cannot overwrite first-party preflights.
  _sealBuiltinKeys();
}

/**
 * Reset the init guard. Call only from tests alongside _clearPreflightsForTests()
 * so subsequent initBuiltinPreflights() calls re-register on the empty registry.
 */
export function _resetBuiltinsInitializedForTests(): void {
  _builtinsInitialized = false;
}
