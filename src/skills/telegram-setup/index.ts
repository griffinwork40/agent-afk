/**
 * /telegram-setup skill — guides the user through first-time Telegram bot
 * onboarding without ever putting the bearer token in the model's context.
 *
 * This is a `fork` skill: the executor routes invocations through a forked
 * subagent that reads `prompts/system.md` as its system prompt. The handler
 * registered here is a no-op (never called for fork skills) and exists only
 * so the skill metadata can be registered.
 *
 * ## Why a skill (not just a CLI command)
 * Skills in AFK auto-register as `/telegram-setup` slash commands AND become
 * model-callable via the `skill` tool — one module gives both surfaces. The
 * existing `afk telegram setup` is unreachable from inside `afk interactive`
 * (its readline conflicts with the REPL's) and from Telegram (no stdin).
 *
 * ## Why no $EDITOR or in-chat paste
 * The skill never opens an editor and never asks the user to paste the token
 * into chat. Instead, it instructs the user to run `afk telegram setup` in a
 * terminal (which uses the existing battle-tested stdin wizard), then resume
 * the conversation. The token's lifetime stays:
 *   clipboard → local stdin → upsertEnvVar → ~/.afk/config/afk.env (0o600)
 *
 * Nothing crosses the LLM provider boundary, nothing enters a chat transcript.
 *
 * ## How the model reads/writes config
 * Three sanctioned subcommands (added to `afk telegram`) read the env file
 * in-process and emit only safe metadata as JSON:
 *   - `afk telegram check-token`     → {set, valid, username?, botId?, reason?}
 *   - `afk telegram discover-chat`   → {found, chats, reason?}
 *   - `afk telegram set-allowed-chat <id>` → {ok, path}
 *
 * The model uses only these; the token is structurally absent from its tool
 * outputs. See `prompts/system.md` for the L3 prompt-discipline contract.
 *
 * @module skills/telegram-setup
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
    'telegram-setup is a fork skill; its handler should never be called directly. ' +
      'Invoke via the `skill` tool or `/telegram-setup` slash command.',
  );
}

export const telegramSetupSkill: SkillMetadata = {
  name: 'telegram-setup',
  description:
    'Guide the user through first-time Telegram bot onboarding without leaking the bearer token. Walks the user to run `afk telegram setup` in a terminal for token entry, then uses the sanctioned `afk telegram check-token`/`discover-chat`/`set-allowed-chat` subcommands to validate and finish allowlist setup — the token never enters the model context. Works in REPL or Telegram. Use when the user wants to set up Telegram push notifications for the first time, or to debug a partially-configured install.',
  handler,
  context: 'fork',
  whenToUse:
    'When the user wants to set up Telegram bot notifications for the first time, or when they say something like "set up telegram", "connect telegram", "enable push", or you detect that TELEGRAM_BOT_TOKEN is unset and they\'re asking for notifications.',
};

registerSkill(telegramSetupSkill);
