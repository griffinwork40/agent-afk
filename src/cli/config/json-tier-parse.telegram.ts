/**
 * Parse the `telegram` block from an afk.config.json file.
 *
 * Extracted from {@link parseJsonConfigFile} to keep that function within the
 * 200-line function ceiling. All validation rules are identical to the original
 * inline block.
 *
 * @module cli/config/json-tier-parse.telegram
 */
import type { CliConfig, ConfigFileSchema } from './types.js';

type TelegramConfig = NonNullable<CliConfig['telegram']>;

/**
 * Parse and validate the `telegram` section of a raw config file schema.
 * Returns `undefined` when the section is absent or not an object.
 */
export function parseTelegramBlock(
  raw: ConfigFileSchema['telegram'],
): TelegramConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const telegram: TelegramConfig = {};
  const notify = raw.notify;
  if (notify && typeof notify === 'object') {
    const parsed: NonNullable<TelegramConfig['notify']> = {};
    if (notify.mode === 'primary' || notify.mode === 'broadcast' || notify.mode === 'custom') {
      parsed.mode = notify.mode;
    }
    if (typeof notify.primaryChatId === 'number' && Number.isFinite(notify.primaryChatId)) {
      parsed.primaryChatId = notify.primaryChatId;
    }
    if (Array.isArray(notify.targets)) {
      const targets = notify.targets.filter(
        (t): t is number => typeof t === 'number' && Number.isFinite(t),
      );
      if (targets.length > 0) parsed.targets = targets;
    }
    telegram.notify = parsed;
  }
  if (typeof raw.verifyDone === 'boolean') {
    telegram.verifyDone = raw.verifyDone;
  }
  if (Array.isArray(raw.tagOnlyChats)) {
    const tagOnly = raw.tagOnlyChats.filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t),
    );
    if (tagOnly.length > 0) telegram.tagOnlyChats = tagOnly;
  }
  // chatAliases: name → chat-id map. Drop non-numeric, non-finite, and
  // zero values (0 is the sentinel for "no chat" throughout routing).
  if (
    raw.chatAliases &&
    typeof raw.chatAliases === 'object' &&
    !Array.isArray(raw.chatAliases)
  ) {
    const aliases: Record<string, number> = {};
    for (const [name, id] of Object.entries(
      raw.chatAliases as Record<string, unknown>,
    )) {
      if (typeof id === 'number' && Number.isFinite(id) && id !== 0) {
        aliases[name] = id;
      }
    }
    if (Object.keys(aliases).length > 0) telegram.chatAliases = aliases;
  }
  return telegram;
}
