/**
 * Contract: Plugin-skill bridge + unified `/skills` listing — facade.
 *
 * This module owns two responsibilities:
 *
 *   1. Bridging plugin-discovered skills (from `~/.afk/plugins/.../SKILL.md`)
 *      into the slash dispatcher. Each becomes a passthrough handler that
 *      returns `'forward'`, so the REPL pipes the raw `/skill args` line back
 *      into the normal turn loop unchanged — the SDK runtime knows how to
 *      dispatch plugin skills natively.
 *
 *   2. Rendering `/skills`, the single canonical listing of every skill
 *      available in this session — vendored TS skills, user-authored
 *      `~/.afk/skills/` skills, and plugin skills, all under one header.
 *      `/builtin-skills` exists as an alias for back-compat with prior tests
 *      and muscle memory.
 *
 * Vendored wins on bare-name collision: when a plugin (or user) skill shares
 * a bare name with a vendored skill, the plugin/user version is reachable
 * only via its namespaced form (e.g. `/example-plugin:mint`, `/user:mint`),
 * never under the bare `/mint`. The unified listing surfaces shadowed alts as
 * continuation rows under the winning entry; on REPL boot we print a one-time
 * dim notice for each collision so users aren't surprised.
 *
 * Flow:
 *   1. `registerStaticPluginSkillCommands()` installs the placeholder
 *      `/skills` (also reachable as `/builtin-skills`) at REPL boot — the
 *      session isn't up yet, so plugin discovery is empty but the registry
 *      already has vendored + user skills, which the placeholder can list.
 *   2. After `session.waitForInitialization()` resolves,
 *      `registerPluginSkills(session)` calls `session.supportedCommands()`,
 *      registers passthrough handlers for non-colliding plugin skills, and
 *      hot-swaps `/skills` to render the live merged list.
 *   3. `/reload-plugins` re-runs the query after the user edits SKILL.md
 *      files on disk.
 *
 * The implementation is split across `plugin-skills/` siblings (#366):
 *   - `plugin-skills/flags.ts`    — SKILL.md flag/hint harvesting from disk
 *   - `plugin-skills/listing.ts`  — `/skills` rendering pipeline + commands
 *   - `plugin-skills/dispatch.ts` — forward handlers + plugin registration
 *   - `plugin-skills/reload.ts`   — `/reload-plugins` + summary helpers
 *   - `plugin-skills/state.ts`    — shared module-scope state (single instance)
 * This file remains the stable import path: it re-exports every public
 * symbol so no consumer's import changes.
 */

import { register } from './registry.js';
import { initialSkillsCmd } from './plugin-skills/listing.js';
import { reloadPluginsCmd } from './plugin-skills/reload.js';

export {
  harvestPluginSkillFlags,
  extractHintFromDescription,
} from './plugin-skills/flags.js';
export { initialSkillsCmd } from './plugin-skills/listing.js';
export {
  makeForwardHandler,
  registerPluginSkills,
  getPluginShadowingNoticeLines,
  autoRegisterPluginPassthroughs,
} from './plugin-skills/dispatch.js';
export {
  buildSourceBreakdown,
  computeSkillDelta,
  formatSkillDelta,
  buildPluginRows,
  reloadPluginsCmd,
} from './plugin-skills/reload.js';

/** Register the always-available commands (placeholder `/skills` + reload). */
export function registerStaticPluginSkillCommands(): void {
  register(initialSkillsCmd);
  register(reloadPluginsCmd);
}
