/**
 * Telegram outbound notification routing.
 *
 * Separates "who may command the bot" (the inbound allowlist
 * `AFK_TELEGRAM_ALLOWED_CHAT_IDS`, enforced in allowlist.ts) from "where
 * out-of-band notifications are delivered" (this module). The two used to be
 * the same flat list, so every notification fanned out to every allowed chat.
 * Routing now defaults to a single "primary" chat and is configurable via the
 * `telegram.notify` block in afk.config.json and `AFK_TELEGRAM_PRIMARY_CHAT_ID`.
 *
 * `resolveNotifyTargets` is the pure decision function (no IO), unit-tested in
 * isolation. `resolveConfiguredNotifyTargets` is the thin IO wrapper consumed
 * by push.ts and the send_telegram tool.
 *
 * @module telegram/notify-routing
 */

import { parseAllowedChatIds } from './allowlist.js';
import { loadTelegramConfig } from '../cli/config.js';
import { env } from '../config/env.js';

/** How notifications fan out across the allowed chats. */
export type NotifyMode = 'primary' | 'broadcast' | 'custom';

export interface TelegramNotifyConfig {
  /**
   * - `primary` (default): deliver to exactly one chat — `primaryChatId` if set,
   *   else the first private/DM chat in the allowlist (Telegram DM ids are
   *   positive; group/channel ids are negative), else the first allowed chat.
   * - `broadcast`: deliver to every chat in the allowlist (the legacy default).
   * - `custom`: deliver to `targets` verbatim. Targets are NOT constrained to
   *   the allowlist — an announce-only group the bot posts to but takes no
   *   commands from is a valid target; Telegram's own bot-messaging rules gate
   *   actual delivery. Empty/invalid `targets` falls back to primary resolution.
   */
  mode?: NotifyMode;
  /** Explicit primary chat. Overrides the positive-id (DM) heuristic. */
  primaryChatId?: number;
  /** Explicit delivery targets — only consulted when `mode === 'custom'`. */
  targets?: number[];
}

/**
 * Resolve the single "main" chat for primary-mode delivery.
 * Priority: explicit `primaryChatId` → first positive (DM) id → first allowed id.
 */
export function resolvePrimaryChatId(
  allowed: readonly number[],
  explicit?: number,
): number | undefined {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit !== 0) {
    return explicit;
  }
  const firstDm = allowed.find((id) => id > 0);
  return firstDm ?? allowed[0];
}

/**
 * Pure routing decision. Given the inbound allowlist and the notify config,
 * return the ordered, de-duplicated list of chat ids that should receive an
 * out-of-band notification. Never reads env or files.
 */
export function resolveNotifyTargets(
  allowlist: Set<number>,
  config: TelegramNotifyConfig = {},
): number[] {
  const allowed = [...allowlist];
  const mode: NotifyMode = config.mode ?? 'primary';

  if (mode === 'broadcast') {
    return allowed;
  }

  if (mode === 'custom') {
    const targets = (config.targets ?? []).filter(
      (id) => typeof id === 'number' && Number.isFinite(id) && id !== 0,
    );
    if (targets.length > 0) {
      return [...new Set(targets)];
    }
    // Empty/invalid custom targets — fall through to primary resolution so a
    // misconfigured `custom` block still delivers somewhere sensible.
  }

  const primary = resolvePrimaryChatId(allowed, config.primaryChatId);
  return primary !== undefined ? [primary] : [];
}

/**
 * Result of resolving an explicit chat target (`send_telegram`'s `chat` param
 * or a scheduled task's `notifyChat`). Discriminated on `ok` so callers can
 * surface a precise, actionable error instead of silently dropping the send.
 */
export type ChatTargetResolution =
  | { ok: true; id: number }
  | { ok: false; reason: 'invalid' | 'unknown-alias'; message: string };

/**
 * Resolve an explicit chat target to a numeric chat id.
 *
 * - `number` → used verbatim (must be finite and non-zero).
 * - numeric string (`"-100123"`, `" 42 "`) → parsed as a chat id.
 * - any other string → looked up as a NAME in `aliases`
 *   (`telegram.chatAliases`), returning the mapped id or an `unknown-alias`
 *   error that lists the available names.
 *
 * Pure — never reads env or files. Allowlist enforcement is a SEPARATE step the
 * caller applies (`isChatAllowed`); this function only turns a name/number into
 * an id (or a typed error).
 */
export function resolveChatTarget(
  chat: number | string,
  aliases: Readonly<Record<string, number>> = {},
): ChatTargetResolution {
  if (typeof chat === 'number') {
    if (!Number.isFinite(chat) || chat === 0) {
      return { ok: false, reason: 'invalid', message: `Invalid chat id: ${chat}` };
    }
    return { ok: true, id: chat };
  }

  const trimmed = chat.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'invalid', message: 'Invalid chat: empty string' };
  }

  // A numeric string is a raw chat id; anything else is an alias NAME.
  const asId = parseChatId(trimmed);
  if (asId !== undefined) {
    return { ok: true, id: asId };
  }

  const aliasNames = Object.keys(aliases);
  const mapped = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  if (mapped !== undefined && Number.isFinite(mapped) && mapped !== 0) {
    return { ok: true, id: mapped };
  }

  const available =
    aliasNames.length > 0
      ? `Available aliases: ${aliasNames.join(', ')}.`
      : 'No chat aliases are configured (set telegram.chatAliases in afk.config.json).';
  return {
    ok: false,
    reason: 'unknown-alias',
    message: `Unknown chat alias "${trimmed}". ${available}`,
  };
}

/** Parse a single chat id from an env string. Returns undefined when absent/invalid. */
export function parseChatId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

/** Parse a notify mode from an env string. Returns undefined when absent/invalid. */
export function parseMode(raw: string | undefined): NotifyMode | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  return v === 'primary' || v === 'broadcast' || v === 'custom' ? v : undefined;
}

/**
 * Assemble the effective notify config from afk.config.json (`telegram.notify`)
 * and the env overrides (`AFK_TELEGRAM_NOTIFY_MODE`, `AFK_TELEGRAM_PRIMARY_CHAT_ID`).
 * The file config is the structured source of truth and wins on conflict; env
 * vars fill gaps the file leaves unset. `targets` (custom mode) is file-only.
 */
export function loadNotifyConfig(): TelegramNotifyConfig {
  const file: TelegramNotifyConfig = loadTelegramConfig().notify ?? {};
  const mode = file.mode ?? parseMode(env.AFK_TELEGRAM_NOTIFY_MODE);
  const primaryChatId = file.primaryChatId ?? parseChatId(env.AFK_TELEGRAM_PRIMARY_CHAT_ID);
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(primaryChatId !== undefined ? { primaryChatId } : {}),
    ...(file.targets !== undefined ? { targets: file.targets } : {}),
  };
}

/**
 * IO convenience used by push.ts and the send_telegram tool: read the allowlist
 * + notify config from env/afk.config.json and resolve the delivery targets.
 */
export function resolveConfiguredNotifyTargets(): number[] {
  const allowlist = parseAllowedChatIds(env.AFK_TELEGRAM_ALLOWED_CHAT_IDS);
  return resolveNotifyTargets(allowlist, loadNotifyConfig());
}

/**
 * IO convenience: read the named-chat alias map (`telegram.chatAliases`) from
 * afk.config.json. Returns `{}` when unset. Consumed by the `send_telegram`
 * handler and the daemon's `notifyChat` resolution to turn an alias name into a
 * chat id via {@link resolveChatTarget}.
 */
export function loadChatAliases(): Record<string, number> {
  return loadTelegramConfig().chatAliases ?? {};
}
