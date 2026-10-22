/**
 * Runs shared-registry slash commands for a Telegram chat route.
 *
 * Contract (/clear): Telegram adopts the shared reset-in-place semantics
 * (session-control `clearConversation`, via the shared `/clear` handler). The
 * chat's AgentSession object survives, so per-route bg-job injection and
 * notifier registrations (keyed by routeKey, not session id) stay valid, and
 * cwd/model/permission/thinking preferences survive. The SessionManager keeps a
 * chat-level lifecycle wrapper only for identity bookkeeping it alone owns:
 * the old sessionId's elicitation route and registry handle are retired, the
 * staged /sessions resume is dropped, and persisted SessionData re-points at
 * the reset session's id so a bot restart never resumes the cleared
 * transcript. If the in-place reset leaves the session closed (lifecycle
 * rebuild failure), we fall back to replacing it so the chat stays usable.
 */
import type { Context } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import type { SessionManager } from '../session-manager.js';
import { type TelegramRoute, routeKey } from '../route.js';
import { TelegramWriter } from '../writer.telegram.js';
import { createTelegramSlashContext } from '../slash-context.telegram.js';
import { classifyTelegramSlash, needsIdleSession, type TelegramSlashClass } from '../slash-dispatch.telegram.js';
import { escapeTelegramHtml } from '../writer.telegram.js';
import { formatQueued, formatError } from '../formatter.js';
import { withTypingIndicator } from '../typing-indicator.js';
import type { SlashCommand } from '../../cli/slash/types.js';
import { modelPickerMarkup } from './slash.model-picker.js';

type LogFn = (...args: unknown[]) => void;

export interface SlashRunnerDeps {
  sessionManager: SessionManager;
  registeredCommandChats: Set<number>;
  log: LogFn;
  isClaimed(key: string): boolean;
  reserveClaim(key: string): void;
  releaseClaim(key: string): void;
  /** Queue the raw command text; returns the queue depth or false when full. */
  enqueueSlash(route: TelegramRoute, ctx: Context, text: string): number | false;
  /** Process the next queued item once a mutating command releases the route. */
  drainQueue(route: TelegramRoute): Promise<void>;
}

async function replyHtml(ctx: Context, chunks: string[], markup?: InlineKeyboardMarkup): Promise<void> {
  for (const [i, chunk] of chunks.entries()) {
    const last = i === chunks.length - 1;
    await ctx.reply(chunk, { parse_mode: 'HTML', ...(last && markup ? { reply_markup: markup } : {}) });
  }
}

/** Session-native slash names (SDK commands + skills) that the agent handles itself. */
function sessionCommandNames(sm: SessionManager, route: TelegramRoute): string[] {
  try {
    const meta = sm.getSessionIfExists(route)?.getSessionMetadata();
    return [...(meta?.slashCommands ?? []), ...(meta?.skills ?? [])];
  } catch {
    return [];
  }
}

/**
 * Handle a `/`-prefixed message. Returns false when the text should continue
 * as a normal agent message (skills and session-native commands).
 */
export async function dispatchTelegramSlash(
  deps: SlashRunnerDeps,
  ctx: Context,
  route: TelegramRoute,
  text: string,
  fromQueue = false,
): Promise<boolean> {
  const cls: TelegramSlashClass = await classifyTelegramSlash(text, sessionCommandNames(deps.sessionManager, route));
  if (cls.kind === 'passthrough' || cls.kind === 'skill') return false;
  if (cls.kind === 'unknown') {
    const hint = cls.suggestion ? ` Did you mean ${cls.suggestion}?` : ' Send /help for the command list.';
    await ctx.reply(escapeTelegramHtml(`Unknown command: ${cls.command}.${hint}`), { parse_mode: 'HTML' });
    return true;
  }
  if (cls.kind === 'refused') {
    await ctx.reply(escapeTelegramHtml(`${cls.command} is ${cls.reason}`), { parse_mode: 'HTML' });
    return true;
  }
  await runNative(deps, ctx, route, cls.cmd, cls.args, text, fromQueue);
  return true;
}

async function runNative(
  deps: SlashRunnerDeps,
  ctx: Context,
  route: TelegramRoute,
  cmd: SlashCommand,
  args: string,
  text: string,
  fromQueue: boolean,
): Promise<void> {
  const { sessionManager: sm, log } = deps;
  const key = routeKey(route);
  const mutating = needsIdleSession(cmd);
  if (mutating && !fromQueue && deps.isClaimed(key)) {
    const depth = deps.enqueueSlash(route, ctx, text);
    if (depth !== false) await ctx.reply(formatQueued(depth));
    return;
  }
  if (mutating) deps.reserveClaim(key);
  // A busy re-queue must not also drain (the active turn's own drain picks it
  // up); draining here would spin shift→busy→re-queue. Mirrors processOne.
  let reEnqueued = false;
  try {
    const session = await sm.getSession(route);
    if (mutating && session.state !== 'idle') {
      const depth = deps.enqueueSlash(route, ctx, text);
      reEnqueued = true;
      if (depth !== false && !fromQueue) await ctx.reply(formatQueued(depth));
      return;
    }
    const stats = sm.getStats(route);
    const modelBefore = stats.model;
    const writer = new TelegramWriter();
    const slashCtx = createTelegramSlashContext(session, stats, writer);
    const isClear = cmd.name === '/clear';
    if (isClear) sm.beginConversationReset(route);
    try {
    await withTypingIndicator(ctx, () => cmd.handler(slashCtx, args));
    } catch (handlerError) {
      if (isClear) sm.finishConversationReset(route);
      throw handlerError;
    }
    if (isClear) {
      if (session.state === 'closed') await sm.resetSession(route);
      else sm.finishConversationReset(route);
      // Command menus are chat-scoped and re-registered on the next turn.
      deps.registeredCommandChats.delete(route.chatId);
    }
    if (stats.model !== modelBefore) sm.noteModel(route, stats.model);
    const chunks = writer.toHtmlChunks();
    // Telegram-native choice UI: bare /model keeps its tap-to-switch keyboard.
    const markup = cmd.name === '/model' && args.trim() === '' ? modelPickerMarkup() : undefined;
    await replyHtml(ctx, chunks.length > 0 ? chunks : [escapeTelegramHtml(`${cmd.name} done.`)], markup);
  } catch (error) {
    log(`Slash ${cmd.name} error:`, error);
    await ctx.reply(formatError(error as Error));
  } finally {
    if (mutating) {
      if (!reEnqueued) deps.drainQueue(route).catch((err) => log('Drain error:', err));
      deps.releaseClaim(key);
    }
  }
}
