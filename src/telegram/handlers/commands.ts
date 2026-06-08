import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import type { Message } from 'telegraf/types';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { isAbsolute, resolve } from 'path';
import { SessionManager } from '../session-manager.js';
import {
  formatError,
  formatClear,
  formatCompact,
  formatCompactNoop,
  formatModelSwitch,
  formatCwdCurrent,
  formatCwdSwitch,
  formatNameCurrent,
  formatNameInvalid,
  formatNameSet,
  escapeHtml,
  formatSystemError,
} from '../formatter.js';
import { providerForModel } from '../../agent/providers/index.js';
import { slotForInput } from '../../agent/session/model-slots.js';
import type { AgentModelInput } from '../../agent/types.js';
import { slugifySessionName } from '../../cli/session-name.js';
import { formatResumeCommand } from '../../cli/resume-command.js';

type LogFn = (...args: unknown[]) => void;

/** Canonical short aliases accepted by /model and the inline keyboard. */
export const MODEL_ALIASES_HINT = ['small', 'medium', 'large', 'opus', 'opus_1m', 'sonnet', 'sonnet_1m', 'haiku'] as const;

/**
 * Handle /clear command (SDK /clear - clear conversation history)
 */
export async function handleClear(
  ctx: Context,
  sessionManager: SessionManager,
  registeredCommandChats: Set<number>,
  log: LogFn
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply(formatError('Could not identify chat'));
    return;
  }

  try {
    await sessionManager.resetSession(chatId);
    registeredCommandChats.delete(chatId);
    await ctx.reply(formatClear());
  } catch (error) {
    log('Clear error:', error);
    await ctx.reply(formatError(error as Error));
  }
}

/**
 * Handle /compact command — runs the provider-side summarization step in
 * place. Replies with counts on success, a neutral info line on no-op, or
 * an error message on failure.
 */
export async function handleCompact(
  ctx: Context,
  sessionManager: SessionManager,
  log: LogFn
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply(formatError('Could not identify chat'));
    return;
  }

  try {
    const session = await sessionManager.getSession(chatId);
    await ctx.sendChatAction('typing').catch(() => {});
    const result = await session.compact();
    if (!result.compacted) {
      await ctx.reply(formatCompactNoop(result.reason ?? 'unknown'));
    } else {
      await ctx.reply(
        formatCompact({
          before: result.messagesBefore,
          after: result.messagesAfter,
          ...(result.tokensSavedEstimate !== undefined
            ? { tokensSavedEstimate: result.tokensSavedEstimate }
            : {}),
        }),
      );
    }
  } catch (error) {
    log('Compact error:', error);
    await ctx.reply(formatError(error as Error));
  }
}

/**
 * Handle /model command - switch Claude model
 */
export async function handleModelSwitch(
  ctx: Context,
  sessionManager: SessionManager,
  log: LogFn
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply(formatError('Could not identify chat'));
    return;
  }

  const text = (ctx.message as Message.TextMessage).text;
  const args = text.split(/\s+/).slice(1);

  if (args.length === 0) {
    const currentModel = sessionManager.getModel(chatId);
    const buttons = MODEL_ALIASES_HINT.map(alias => [
      Markup.button.callback(alias, `afk:m:${alias}`),
    ]);
    await ctx.reply(
      `Current model: <b>${escapeHtml(currentModel.toUpperCase())}</b>\n\nSwitch to:`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
      },
    );
    return;
  }

  const modelArg = args[0];
  if (!modelArg) {
    await ctx.reply(formatError('Please specify a model: small, medium, large, opus, sonnet, haiku, or an org/model id'));
    return;
  }

  const model = modelArg.toLowerCase() as AgentModelInput;
  const isKnownAlias = MODEL_ALIASES_HINT.includes(model as (typeof MODEL_ALIASES_HINT)[number]);
  const isSlotName = slotForInput(model) !== undefined;
  const isHFStyleId = providerForModel(model) === 'openai-compatible';

  if (!isKnownAlias && !isSlotName && !isHFStyleId) {
    await ctx.reply(
      formatError(`Invalid model: ${modelArg}\nAliases: ${MODEL_ALIASES_HINT.join(', ')}, or org/model HF id`)
    );
    return;
  }

  try {
    await sessionManager.switchModel(chatId, model);
    await ctx.reply(formatModelSwitch(model));
  } catch (error) {
    log('Model switch error:', error);
    await ctx.reply(formatError(error as Error));
  }
}

/**
 * Resolve a user-supplied path to an absolute path.
 *
 * Order:
 * 1. `~` and `~/...` → `$HOME` / `$HOME/...`
 * 2. Absolute path → use as-is
 * 3. Relative path → resolved against `base` (the current session cwd)
 *
 * Exported for test access; not part of the public bot surface.
 */
export function resolveCwdInput(input: string, base: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }
  return resolve(base, trimmed);
}

/**
 * Handle /cd (and /cwd alias) — change the working directory for the
 * current chat session.
 *
 * - No args: show the current effective cwd.
 * - With path: resolve (`~`, relative, absolute), validate it's a real
 *   directory, then persist via `sessionManager.setCwd`. The next
 *   message in this chat creates a fresh session in the new cwd.
 *
 * Refuses paths that don't exist or aren't directories — these would
 * otherwise be persisted and break the next session spawn.
 */
export async function handleCwd(
  ctx: Context,
  sessionManager: SessionManager,
  log: LogFn,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply(formatError('Could not identify chat'));
    return;
  }

  const text = (ctx.message as Message.TextMessage).text;
  // Filter empties so `/cd ` (trailing whitespace) is treated as "no args"
  // rather than dispatching an empty path through resolveCwdInput.
  const args = text.split(/\s+/).slice(1).filter((a) => a.length > 0);

  // Reading the current cwd is allowed mid-turn since it doesn't mutate
  // session state — but mutating it via setCwd closes the active session,
  // which would orphan a streaming turn. Match the switchModel precedent
  // (unconditional close); the user can re-issue if they hit a race.
  if (args.length === 0) {
    const currentCwd = sessionManager.getCwd(chatId);
    await ctx.reply(formatCwdCurrent(currentCwd));
    return;
  }

  const pathArg = args[0];
  if (!pathArg) {
    await ctx.reply(formatError('Please specify a directory path'));
    return;
  }

  const base = sessionManager.getCwd(chatId) ?? process.cwd();
  const resolved = resolveCwdInput(pathArg, base);

  // Validate BEFORE persisting — a stat failure here means the next
  // session would fail to spawn with a confusing ENOENT from a tool
  // handler, far from the /cd call site.
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      await ctx.reply(formatError(`Not a directory: ${resolved}`));
      return;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await ctx.reply(formatSystemError('ENOENT', resolved));
    } else if (code === 'EACCES') {
      await ctx.reply(formatSystemError('EACCES', resolved));
    } else {
      log('cwd stat error:', error);
      await ctx.reply(formatError(error as Error));
    }
    return;
  }

  try {
    await sessionManager.setCwd(chatId, resolved);
    await ctx.reply(formatCwdSwitch(resolved));
  } catch (error) {
    log('Cwd switch error:', error);
    await ctx.reply(formatError(error as Error));
  }
}

/**
 * Handle /name [name] — show or set the human-readable name for this chat's
 * session. Mirrors the CLI `/name` command so a Telegram conversation can be
 * resumed by name from the CLI (`afk i --resume <name>`) instead of a UUID.
 *
 * - No args: reply with the current name (or a hint when unset).
 * - With an arg: slugify it; reject when it has no usable characters;
 *   otherwise set the name on the chat's accumulating session stats. Once the
 *   conversation has a recorded turn the name persists immediately so it's
 *   resolvable from the CLI; before the first turn the name rides along on the
 *   first per-turn autosave.
 *
 * The leading command token (`/name`, or `/name@botname` in groups) is
 * dropped and the remainder is joined back into one string, so a multi-word
 * name like `/name my cool session` slugifies as a phrase.
 */
export async function handleName(
  ctx: Context,
  sessionManager: SessionManager,
  log: LogFn,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.reply(formatError('Could not identify chat'));
    return;
  }

  const text = (ctx.message as Message.TextMessage).text;
  const raw = text.split(/\s+/).slice(1).join(' ').trim();

  // No arg → report the current name.
  if (!raw) {
    await ctx.reply(formatNameCurrent(sessionManager.getSessionName(chatId)));
    return;
  }

  const slug = slugifySessionName(raw);
  if (!slug) {
    await ctx.reply(formatNameInvalid());
    return;
  }

  try {
    const { persisted } = sessionManager.setSessionName(chatId, slug);
    const resumeCommand = persisted
      ? formatResumeCommand(slug, sessionManager.getModel(chatId))
      : undefined;
    await ctx.reply(formatNameSet(slug, resumeCommand));
  } catch (error) {
    // The name was set in memory; only the immediate persist failed (it will
    // retry on the next per-turn autosave). Surface the failure without
    // pretending the rename didn't take. Do NOT forward error.message — a
    // failed writeFileSync leaks the host filesystem path to the user.
    log('Name set error:', error);
    await ctx.reply(`🏷️ Named "${slug}" but couldn't save it — it'll retry on your next message.`);
  }
}
