/**
 * Voice and audio handler registration for TelegramBot.setupHandlers.
 *
 * Extracted from bot.ts to keep that file within the 350-code-line ceiling.
 * Registers Telegraf listeners for 'voice' and 'audio' updates; each listener
 * downloads the file, transcribes it, and dispatches the transcript as a text
 * turn via MessageHandler.handle.
 *
 * @module telegram/bot.audio-handler
 */

import type { Telegraf, Context } from 'telegraf';
import type { Message, MessageEntity } from 'telegraf/types';
import { addressedToBot } from './handlers/message.js';
import type { MessageHandler } from './handlers/message.js';
import type { AudioTranscriber } from './audio-transcriber.js';
import { handleVoiceOrAudio } from './handlers/voice.js';

type LogFn = (...args: unknown[]) => void;

/**
 * Register voice and audio Telegraf listeners on `bot`.
 *
 * @param bot         The Telegraf instance to register listeners on.
 * @param transcriber Configured transcriber, or null when AFK_TRANSCRIBE_API_URL
 *                    is unset (causes a named refusal reply per update).
 * @param messageHandler  MessageHandler whose `.handle()` receives the transcript.
 * @param runDetached Fire-and-forget wrapper that owns error logging (mirrors
 *                    the same helper in bot.ts setupHandlers).
 * @param log         Logger callback.
 */
export function registerAudioHandlers(
  bot: Telegraf,
  transcriber: AudioTranscriber | null,
  messageHandler: MessageHandler,
  runDetached: (work: Promise<void>) => void,
  log: LogFn,
  tagOnlyChats: Set<number> = new Set(),
): void {
  const handleAudio = (type: 'voice' | 'audio') => (ctx: Context) =>
    runDetached(
      (async () => {
        // Tag-only gate: in tag-only chats, voice/audio must be addressed to
        // the bot (reply or @mention in caption) BEFORE we spend money on
        // transcription.  Mirrors the text-message gate in message.ts.
        const chatId = ctx.chat?.id;
        if (chatId !== undefined && tagOnlyChats.has(chatId)) {
          const msg = ctx.message as Message.AudioMessage | Message.VoiceMessage | undefined;
          const caption = (msg as Record<string, unknown> | undefined)?.['caption'] as string | undefined;
          const captionEntities = (msg as Record<string, unknown> | undefined)?.['caption_entities'] as MessageEntity[] | undefined;
          const botId = ctx.botInfo?.id ?? 0;
          if (!addressedToBot(caption, captionEntities, msg?.reply_to_message?.from?.id, botId, ctx.botInfo?.username)) {
            log(`Voice/audio ignored in tag-only chat ${chatId} (not addressed to bot)`);
            return;
          }
        }

        const transcript = await handleVoiceOrAudio(ctx, type, transcriber, log);
        if (transcript === null) return; // handler already replied with error/refusal
        // Synthesise a text-message context so MessageHandler.handle() can
        // process the transcript through the normal turn pipeline (queue,
        // claim, streamResponse).  We build a shallow clone of the context
        // with an own `message` property carrying the transcript as `text`.
        // Object.create preserves the Telegraf prototype chain so instanceof
        // checks inside handle() still work; the own `message` property
        // shadows the prototype getter without triggering a TypeError.
        const synthCtx = Object.create(Object.getPrototypeOf(ctx)) as Context;
        Object.assign(synthCtx, ctx);
        Object.defineProperty(synthCtx, 'message', {
          value: Object.assign({}, ctx.message, { text: transcript, entities: [] }),
          writable: true,
          enumerable: true,
          configurable: true,
        });
        await messageHandler.handle(synthCtx);
      })(),
    );

  bot.on('voice', handleAudio('voice'));
  bot.on('audio', handleAudio('audio'));

  // Acknowledge remaining unsupported media types so users know why the bot
  // is silent rather than assuming a bug. Video and sticker are not transcribed.
  bot.on(['video', 'sticker', 'video_note'], (ctx) => {
    if (ctx.chat) {
      void ctx.reply(
        'I can process text, photo, document, and voice/audio messages. ' +
          'Video and sticker support is not yet available.',
      ).catch((e) => log('Failed to send unsupported-type reply:', e));
    }
  });
}
