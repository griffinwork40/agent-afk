/**
 * Generic Telegram slash dispatch through the shared slash registry.
 *
 * Telegram-only commands (/start, /cd, /sessions, /new, /watch, /unwatch,
 * /abort, /afk, /inbox, /insights, /good, /bad) are registered as Telegraf
 * `bot.command` handlers and never reach here. Everything else that starts
 * with `/` is classified: native (run with the Telegram context + writer),
 * refused (capability/lifecycle reason), skill (forwarded to the agent),
 * or unknown (suggestion).
 */
import { parse, lookup, suggest, list } from '../cli/slash/registry.js';
import {
  capabilityReason, missingCapabilities, telegramCapabilities, commandRequirements,
} from '../cli/slash/capabilities.js';
import type { SlashCommand } from '../cli/slash/types.js';

let registration: Promise<void> | null = null;

/**
 * Idempotent: registerAll() resets the process-global registry, so run it once.
 * Lazy import keeps the CLI command tree off the bot's startup/import path.
 */
export function ensureTelegramSlashRegistry(): Promise<void> {
  registration ??= import('../cli/slash/index.js')
    .then(({ registerAll }) => { registerAll(); })
    .catch((err: unknown) => { registration = null; throw err; });
  return registration;
}

/** Test seam. */
export function resetTelegramSlashRegistry(): void { registration = null; }

/** Lifecycle commands whose shared semantics do not map onto a chat. */
const TELEGRAM_DEFERRED: ReadonlyMap<string, string> = new Map([
  ['/exit', 'not applicable on Telegram: use /new to start a fresh conversation'],
  ['/resume', 'not on Telegram: use /sessions to switch conversations'],
  ['/fork', 'not on Telegram yet: forking a session is coming; use the REPL for now'],
  ['/rewind', 'not on Telegram yet: needs an interactive picker; use the REPL for now'],
]);

export type TelegramSlashClass =
  | { kind: 'native'; cmd: SlashCommand; args: string }
  | { kind: 'refused'; command: string; reason: string }
  | { kind: 'skill'; cmd: SlashCommand; args: string }
  | { kind: 'passthrough' }
  | { kind: 'unknown'; command: string; suggestion?: string };

/** Reason a registered command cannot run on Telegram, or undefined. */
export function telegramGateReason(cmd: Pick<SlashCommand, 'name' | 'requires'>): string | undefined {
  const deferred = TELEGRAM_DEFERRED.get(cmd.name);
  if (deferred) return deferred;
  const missing = missingCapabilities(cmd, telegramCapabilities());
  return missing.length > 0
    ? `not available on Telegram: ${missing.map(capabilityReason).join('; ')}`
    : undefined;
}

/**
 * Classify `/name args`. `sessionCommands` are SDK/session-native slash names
 * (bare, no slash) that the agent itself handles; they pass through as text.
 * A `/cmd@botname` group mention is normalized to `/cmd`.
 */
export async function classifyTelegramSlash(
  text: string,
  sessionCommands: readonly string[] = [],
): Promise<TelegramSlashClass> {
  await ensureTelegramSlashRegistry();
  const parsed = parse(text.replace(/^(\/[^\s@]+)@\S+/, '$1'));
  if (!parsed) return { kind: 'passthrough' };
  const cmd = lookup(parsed.name);
  if (!cmd) {
    const bare = parsed.name.slice(1);
    if (sessionCommands.some((c) => c.replace(/^\//, '') === bare)) return { kind: 'passthrough' };
    return { kind: 'unknown', command: parsed.name, suggestion: suggest(parsed.name) };
  }
  if (cmd.acceptsAttachments) return { kind: 'skill', cmd, args: parsed.args };
  const reason = telegramGateReason(cmd);
  if (reason) return { kind: 'refused', command: cmd.name, reason };
  return { kind: 'native', cmd, args: parsed.args };
}

/** True when the command mutates the live conversation and must wait for idle. */
export function needsIdleSession(cmd: Pick<SlashCommand, 'name' | 'requires'>): boolean {
  return commandRequirements(cmd).includes('sessionControl');
}

/** Telegram menu-name rule: 1-32 chars of [a-z0-9_]. */
const MENU_NAME = /^[a-z0-9_]{1,32}$/;

/**
 * Registry commands runnable on Telegram, as `setMyCommands` descriptors.
 * Skills are excluded (they come from the session's own skill list).
 */
export async function registryMenuDescriptors(): Promise<Array<{ command: string; description: string }>> {
  await ensureTelegramSlashRegistry();
  const out: Array<{ command: string; description: string }> = [];
  for (const cmd of list()) {
    if (cmd.acceptsAttachments || telegramGateReason(cmd)) continue;
    const command = cmd.name.slice(1);
    if (!MENU_NAME.test(command)) continue;
    out.push({ command, description: cmd.summary.slice(0, 256) });
  }
  return out;
}
