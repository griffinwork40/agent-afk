/**
 * /service-setup skill — walks the user through installing an AFK background
 * process (telegram bot, daemon) as an OS-supervised service (macOS launchd
 * LaunchAgent / Linux systemd `--user` unit) so it auto-starts on login and
 * relaunches on crash.
 *
 * This is the natural companion to the `afk service` CLI surface introduced
 * in PR #346. The CLI itself is one-shot and assumes you know what you want.
 * The skill orchestrates the lifecycle: pre-flight prerequisites (e.g., the
 * telegram bot won't survive `KeepAlive` if the token is invalid), runs the
 * install via the sanctioned `afk service install` subcommand, verifies with
 * `afk service status`, and hands the user the management cheatsheet.
 *
 * ## Why a skill (not just a CLI command)
 * - Pre-flight matters: installing the telegram service with no/invalid
 *   token produces an infinite KeepAlive crash loop. The skill checks
 *   `afk telegram check-token` first and routes to `/telegram-setup` if
 *   the token isn't valid.
 * - macOS + Linux — the skill checks `uname` up front and surfaces a clean
 *   error on unsupported platforms (e.g. Windows) instead of relying on the
 *   CLI's platform dispatch to fail mid-pipeline.
 * - Parallel to `/telegram-setup` (which configures the token) — together
 *   they cover the full "make this thing always-on" flow.
 *
 * This is a `fork` skill: the executor routes invocations through a forked
 * subagent that reads `prompts/system.md` as its system prompt. The handler
 * registered here is a no-op (never called for fork skills) and exists only
 * so the skill metadata can be registered.
 *
 * @module skills/service-setup
 */

import { registerSkill, type SkillMetadata } from '../index.js';

/**
 * No-op handler. The skill's `context: 'fork'` setting routes invocations
 * through {@link SkillExecutor.executeForkedRegistrySkill}, which loads
 * `prompts/system.md` and forks a subagent — the handler here is never
 * called. Kept only because the registry's type requires one.
 */
async function handler(): Promise<unknown> {
  throw new Error(
    'service-setup is a fork skill; its handler should never be called directly. ' +
      'Invoke via the `skill` tool or `/service-setup` slash command.',
  );
}

export const serviceSetupSkill: SkillMetadata = {
  name: 'service-setup',
  description:
    'Install an AFK background process (telegram bot or daemon) as an OS-supervised service — a launchd LaunchAgent on macOS or a systemd `--user` unit on Linux — so it auto-starts on login and relaunches on crash. Runs pre-flight checks (e.g., refuses to install the telegram service with an invalid token, which would otherwise crash-loop under KeepAlive/Restart=always), invokes `afk service install`, verifies with `afk service status`, and surfaces the management cheatsheet (including the `loginctl enable-linger` step on Linux). macOS + Linux — gracefully refuses on other platforms.',
  handler,
  context: 'fork',
  whenToUse:
    "When the user wants to make `afk telegram start` or `afk daemon` always-on — i.e., survive reboot, crash, OOM. Triggers on phrasings like 'install as a service', 'auto-start on login', 'keep the bot running', 'launchd', 'always-on telegram', or right after a successful `/telegram-setup` when the user asks how to make it persistent.",
};

registerSkill(serviceSetupSkill);
