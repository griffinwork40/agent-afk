/**
 * Standalone photo-message handler extracted from MessageHandler.
 *
 * Invariant: all state mutations go through explicit parameters -- never closed
 * over from the enclosing class. The class delegates via handlePhotoImpl so the
 * public surface of MessageHandler is unchanged (importers need not update).
 *
 * @module telegram/handlers/message.photo-handler
 */

import { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { registerInboundImageBlocks } from '../../agent/content/attachment-registry.js';
import { isRateLimitError, isNetworkError, isTelegramTransportError, formatRateLimitReply } from '../error-utils.js';
import { formatInternalError, formatQueued } from '../formatter.js';
import { registerChatCommands } from './registration.js';
import { errorMessage } from '../../utils/errors.js';
import { type TelegramRoute, routeKey, routeFromCtx } from '../route.js';
import { senderPrefix } from '../sender-attribution.js';
import { replyContextPrefix, type RepliedMessage } from '../reply-context.js';
import { forwardProvenancePrefix } from '../forward-provenance.js';
import { addressedToBot } from './message.addressed-to-bot.js';
import { fetchAndClassifyPhoto } from './message.media-helpers.js';
import type { SessionManager } from '../session-manager.js';
import type { Telegraf } from 'telegraf';

type LogFn = (...args: unknown[]) => void;

/** Subset of MessageHandler state needed by handlePhotoImpl. */
export interface PhotoHandlerContext {
  bot: Telegraf;
  sessionManager: SessionManager;
  registeredCommandChats: Set<number>;
  tagOnlyChats: Set<number>;
  log: LogFn;
  /** Claim-management callbacks so photo handling participates in the same
   *  turn-slot protocol as text messages (see claimedChats in MessageHandler). */
  isClaimed(key: string): boolean;
  reserveClaim(key: string): void;
  releaseClaim(key: string): void;
  enqueuePhoto(route: TelegramRoute, ctx: Context, content: ContentBlockParam[]): number | false;
  processOne(route: TelegramRoute, ctx: Context, content: ContentBlockParam[]): Promise<void>;
  MAX_QUEUE_DEPTH: number;
  messageQueues: Map<string, unknown[]>;
}

/**
 * Handle photo messages (with optional caption).
 *
 * Telegram sends photo updates with `message.photo[]` and no `message.text`,
 * so the 'text' listener silently drops them. This function covers that gap.
 *
 * Note: Telegram delivers each photo in a media group (album) as a separate
 * update -- multi-photo album support is a known limitation and is not
 * implemented here.
 */
export async function handlePhotoImpl(
  ctx: Context,
  hc: PhotoHandlerContext,
): Promise<void> {
  const { bot, sessionManager, registeredCommandChats, tagOnlyChats, log } = hc;
  const route = routeFromCtx(ctx);
  const chatId = route?.chatId;
  const msg = ctx.message as Message.PhotoMessage | undefined;
  const photo = msg?.photo;

  if (!route || !chatId || !photo?.length) {
    log(`Photo handling: missing chatId or photo array for chat ${chatId ?? '(unknown)'}`);
    return;
  }

  // Tag-only response policy (mirrors handle()): in a configured chat, drop a
  // photo that is not addressed to the bot BEFORE the ack/getFileLink path, so
  // an un-addressed photo produces no reaction and no CDN download -- just a log
  // line. A photo's caption carries the mention entities (caption_entities).
  // Fail-closed if the bot identity is unknown.
  if (tagOnlyChats.has(chatId)) {
    const botId = ctx.botInfo?.id;
    if (botId === undefined) {
      log(`[tag-only] Dropping photo in chat ${chatId}: bot identity unknown (botInfo missing)`);
      return;
    }
    if (!addressedToBot(msg?.caption, msg?.caption_entities, msg?.reply_to_message?.from?.id, botId, ctx.botInfo?.username)) {
      log(`[tag-only] Dropping un-addressed photo in chat ${chatId}`);
      return;
    }
  }

  log(`📷 Photo from chat ID: ${chatId}`);
  // Ack the photo on receipt (best-effort) -- instant feedback even if the
  // image is later rejected (too large / unsupported) or queued.
  await ctx.react?.('👀').catch(() => {});

  // Use the largest available size (Telegram orders photo[] smallest -> largest)
  const largest = photo[photo.length - 1];
  if (!largest) {
    log(`Photo handling: empty photo array for chat ${chatId}`);
    return;
  }

  // H2: hard cap -- Telegram CDN files can be large; bail early to avoid
  // downloading something the Anthropic API will reject anyway.
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
  if (largest.file_size != null && largest.file_size > MAX_PHOTO_BYTES) {
    log(`Photo handling: oversized file (${largest.file_size} bytes) rejected for chat ${chatId}`);
    await ctx.reply('❌ Image is too large (max 5 MB). Please send a smaller photo.');
    return;
  }

  const caption = msg?.caption;

  let alreadyClaimed = false;
  try {
    // Invariant: reserve this chat's turn slot SYNCHRONOUSLY (no `await`
    // between the check and the reserve), before the async `getSession()`
    // call below -- see the `claimedChats` field doc for the exact race this
    // closes. Photos widen the pre-fix race further than text messages
    // (the CDN download + base64 encode below is a much larger gap than
    // `ctx.react`), so this check matters even more here. Only reserve when
    // not already claimed so a losing concurrent call doesn't inflate the
    // count it never releases; processOne takes its own reservation for the
    // turn it actually runs (drain-path coverage, #603 Item 1).
    alreadyClaimed = hc.isClaimed(routeKey(route));
    if (!alreadyClaimed) hc.reserveClaim(routeKey(route));

    // M3+M6: session lookup and queue-depth check happen before getFileLink /
    // download so that allowlist-burst rejections don't burn Telegram API quota
    // or trigger a full CDN download for a message that will be dropped anyway.
    const session = await sessionManager.getSession(route);

    // Register dynamic commands for this chat (non-blocking). Chat-scoped, so
    // keyed by chatId even when the message arrived in a topic.
    registerChatCommands(bot, chatId, session, registeredCommandChats, log).catch(err =>
      log('Failed to register chat commands:', err)
    );

    if (session.state !== 'idle' || alreadyClaimed) {
      // Check queue capacity before downloading: if the queue is already full we
      // can reject immediately without spending Telegram API quota on getFileLink.
      const queue = hc.messageQueues.get(routeKey(route));
      if ((queue?.length ?? 0) >= hc.MAX_QUEUE_DEPTH) {
        await ctx.reply('⏳ Queue full. Please wait for your messages to be processed.');
        return;
      }
      // Queue has room -- fall through to download so we can build contentBlocks
      // and enqueue the decoded photo for processing after the active turn ends.
    }

    // Validate CDN URL, download bytes, and detect MIME type. All error replies
    // are sent by fetchAndClassifyPhoto; { ok: false } means the caller should return.
    const fetchResult = await fetchAndClassifyPhoto(ctx, largest.file_id, chatId, log);
    if (!fetchResult.ok) return;
    const { bytes, media_type } = fetchResult;

    // Build content-block array: optional text block + image block
    // H4: use != null so an explicit empty-string caption is preserved
    // M2: prefix with [User caption] so the model can distinguish user text from system context
    // Cap at 1024 code points -- Telegram's own limit -- to prevent prompt-injection via
    // an arbitrarily long caption constructed by a relay or bot.
    // Use spread-then-slice to count Unicode code points, not UTF-16 code units:
    // emoji and other non-BMP characters span two code units, and slicing at a
    // surrogate-pair boundary with plain .slice() produces malformed text.
    // system-trusted sender marker (no-op in private chats; see sender-attribution.ts)
    const prefix = senderPrefix(msg?.from, ctx.chat?.type);
    // reply/quote context + forward provenance (both empty in common case; see reply-context.ts, forward-provenance.ts)
    const replyCtx = replyContextPrefix({
      replyToMessage: msg?.reply_to_message as RepliedMessage | undefined,
      quote: msg?.quote,
      botId: ctx.botInfo?.id,
    });
    const fwdPrefix = forwardProvenancePrefix(msg ?? {});
    const attribution = replyCtx + fwdPrefix + prefix;
    const contentBlocks: ContentBlockParam[] = [];
    if (caption != null) {
      contentBlocks.push({ type: 'text', text: `${attribution}[User caption]: ${[...caption].slice(0, 1024).join('')}` });
    } else if (attribution) {
      // No caption, but still attribute the sender and/or reply target of the image.
      contentBlocks.push({ type: 'text', text: `${attribution}(image, no caption)` });
    }
    await session.waitForInitialization();
    if (session.sessionId === undefined) throw new Error('Telegram session initialized without a session id');
    await registerInboundImageBlocks(contentBlocks, session.sessionId, [{ mediaType: media_type, bytes }]);

    if (session.state !== 'idle' || alreadyClaimed) {
      const depth = hc.enqueuePhoto(route, ctx, contentBlocks);
      if (depth !== false) await ctx.reply(formatQueued(depth));
      return;
    }

    await hc.processOne(route, ctx, contentBlocks);
  } catch (error) {
    // Redact any embedded bot token before logging: getFileLink() returns URLs of the form
    // https://api.telegram.org/file/bot<TOKEN>/<path>, and HTTP client errors frequently
    // embed the request URL in their message string.
    const rawErrStr = errorMessage(error);
    const sanitizedErr = rawErrStr.replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
    log('Photo handling error:', sanitizedErr);
    // Note: 'session is busy' is no longer handled here -- that race is covered
    // inside processOne's catch so it applies uniformly to all callers.
    if (isTelegramTransportError(error)) {
      // Telegram-side failure fetching the image (e.g. getFileLink 429) -- a
      // Telegram limit, not a Claude one. Attribute it honestly.
      await ctx.reply('❌ Couldn\'t reach Telegram to fetch that image. Please try resending.');
    } else if (isRateLimitError(error)) {
      await ctx.reply(formatRateLimitReply(error));
    } else if (isNetworkError(error)) {
      await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
    } else {
      await ctx.reply(formatInternalError());
    }
  } finally {
    // Only the call that actually reserved the slot releases it -- see the
    // matching comment in handle(). processOne holds its own reservation for
    // the turn it runs, so releasing this outer guard here never drops the
    // slot out from under an in-flight (possibly drained) turn.
    if (!alreadyClaimed) hc.releaseClaim(routeKey(route));
  }
}
