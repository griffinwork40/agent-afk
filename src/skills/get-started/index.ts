/**
 * /get-started skill — guided first-run onboarding for AFK.
 *
 * Takes a brand-new user from cold install to their first useful action as a
 * boot sequence (a state machine, not a feature menu):
 *
 *   preflight → name + intro → toolbox (migrate + capabilities) →
 *   project context (/init) → save point (/clear) → first job
 *
 * ## Why `context: 'load'` (not `fork` like telegram-setup / service-setup)
 * Onboarding must run in the CURRENT session so the agent can ask the user's
 * name, hold a conversation, recommend slash commands the user then runs
 * (`/init`, `/clear`), dispatch the existing setup sub-skills, and leave its
 * state (name in hot memory, a warm context) in the caller's window. A forked
 * subagent would discard that context and can't drive the REPL. Per the
 * fork-vs-load rule in docs/skill-load-mode.md: this skill orchestrates *from*
 * the current agent and its output lands in the caller's context → `load`.
 *
 * Built-in registry skills default to `inline`, so `context: 'load'` is
 * declared explicitly. The body lives at `prompts/system.md`; the SkillExecutor
 * load branch returns it (after `$ARGUMENT(S)` substitution) wrapped in an
 * execute-now framing header, and the current agent carries it out with its
 * existing tools (ask_question, bash, skill, memory_update).
 *
 * This skill never handles secrets directly — Telegram token setup is delegated
 * to `/telegram-setup` (which has the token-discipline contract). Cross-tool
 * asset import is delegated to `afk migrate` via its non-interactive flag paths
 * (`--dry-run` / `-y`) to avoid the readline conflict with the REPL.
 *
 * @module skills/get-started
 */

import { registerSkill, type SkillMetadata } from '../index.js';

/**
 * No-op handler. `context: 'load'` routes invocations through
 * {@link SkillExecutor.executeLoadedRegistrySkill}, which returns
 * `prompts/system.md` as the tool result without ever calling this handler.
 * Kept only because the registry's type requires one; throws to surface a
 * routing bug loudly rather than silently returning nothing.
 */
async function handler(): Promise<unknown> {
  throw new Error(
    'get-started is a load skill; its handler should never be called directly. ' +
      'Invoke via the `skill` tool or `/get-started` slash command.',
  );
}

export const getStartedSkill: SkillMetadata = {
  name: 'get-started',
  description:
    'Guided first-run onboarding for AFK. Runs a preflight check (git repo, model provider, AFK.md, Exa/Telegram/service config), asks the user their name and gives a brief intro, detects importable Claude Code / Codex assets and offers `afk migrate`, walks optional capability setup (Exa Search, Telegram via /telegram-setup, background service via /service-setup), then recommends /init to generate project context and /clear to start fresh — ending by routing the user to their first task. Runs interactively in the current session.',
  handler,
  context: 'load',
  audience: 'public',
  whenToUse:
    "When someone is setting up AFK for the first time or asks how to get going — triggers on `/get-started`, 'how do I start', 'set me up', 'onboard me', or a fresh install with no AFK.md and unconfigured capabilities. Best run in the interactive REPL.",
};

registerSkill(getStartedSkill);
