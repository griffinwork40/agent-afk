/**
 * Voice and audio message handler for the Telegram bot.
 *
 * Handles `voice` (Telegram voice notes, ogg/opus) and `audio` (music /
 * arbitrary audio files) messages by:
 *   1. Downloading the file via the shared bounded pipeline (SSRF guard,
 *      size cap, redirect rejection) in media-download.ts.
 *   2. Transcribing the bytes via a pluggable AudioTranscriber.
 *   3. Dispatching the transcript as the user's message so the agent sees it
 *      exactly as if the user had typed it, plus an echo reply so the operator
 *      can verify what was heard.
 *
 * When no transcriber is configured (AFK_TRANSCRIBE_API_URL unset) the
 * handler replies with a clear message naming the env var rather than the old
 * "Voice and video support is not yet available." refusal.
 *
 * The audio bytes are never written to disk; the Buffer is passed directly to
 * the transcriber and discarded once the call returns.
 *
 * Size cap: 20 MB — Telegram's own limit for voice/audio files sent via bots
 * is 20 MB; we mirror that rather than capping lower.
 *
 * @module telegram/handlers/voice
 */

import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { downloadTelegramFile } from '../media-download.js';
import type { AudioTranscriber } from '../audio-transcriber.js';
import { errorMessage } from '../../utils/errors.js';

/** 20 MB — mirrors Telegram's own bot API upload ceiling for voice/audio. */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** Env var name users must set to enable transcription. */
export const TRANSCRIBE_URL_ENV = 'AFK_TRANSCRIBE_API_URL';

/** Reply sent when no transcriber is configured. */
export const NO_TRANSCRIBER_REPLY =
  `🎙️ Voice transcription is not configured. ` +
  `Set ${TRANSCRIBE_URL_ENV} to an OpenAI-compatible /audio/transcriptions endpoint ` +
  `(e.g. https://api.openai.com/v1/audio/transcriptions or a local Whisper server) to enable it.`;

type LogFn = (...args: unknown[]) => void;

/**
 * Compute a sensible filename for the multipart upload from Telegram message
 * metadata.  The extension helps the Whisper server pick the right decoder.
 */
function audioFileName(
  ctx: Context,
  type: 'voice' | 'audio',
): string {
  if (type === 'audio') {
    const msg = ctx.message as Message.AudioMessage | undefined;
    const fileName = msg?.audio?.file_name;
    if (fileName) return fileName;
    const mime = msg?.audio?.mime_type ?? '';
    const ext = mime.includes('mpeg') ? 'mp3'
      : mime.includes('mp3') ? 'mp3'
      : mime.includes('mp4') || mime.includes('m4a') ? 'm4a'
      : mime.includes('ogg') ? 'ogg'
      : mime.includes('wav') ? 'wav'
      : 'audio';
    return `audio.${ext}`;
  }
  // Telegram voice notes are always ogg/opus.
  return 'voice.ogg';
}

/**
 * Process an inbound voice or audio message.
 *
 * @param ctx        Telegraf context for the update.
 * @param type       'voice' or 'audio' — selects which message field to read.
 * @param transcriber  A configured AudioTranscriber, or null when none is set.
 * @param log        Logger callback (same signature as the bot's this.log).
 * @returns The transcript string to dispatch as a user message, or null when
 *          the handler already replied with an error / refusal and the caller
 *          should not dispatch anything.
 */
export async function handleVoiceOrAudio(
  ctx: Context,
  type: 'voice' | 'audio',
  transcriber: AudioTranscriber | null,
  log: LogFn,
): Promise<string | null> {
  const chatId = ctx.chat?.id ?? '(unknown)';

  // Opt-in gate: no transcriber → named refusal instead of silent drop.
  if (!transcriber) {
    await ctx.reply(NO_TRANSCRIBER_REPLY).catch((e) =>
      log('Failed to send no-transcriber reply:', e),
    );
    return null;
  }

  // Extract the Telegram file descriptor from the relevant message field.
  const msg = ctx.message as
    | Message.VoiceMessage
    | Message.AudioMessage
    | undefined;

  const fileDesc =
    type === 'voice'
      ? (msg as Message.VoiceMessage | undefined)?.voice
      : (msg as Message.AudioMessage | undefined)?.audio;

  if (!msg || !fileDesc) {
    log(`Voice/audio handling: missing message or ${type} field for chat ${chatId}`);
    await ctx.reply('❌ Could not read the audio message. Please try resending.').catch(() => {});
    return null;
  }

  // Pre-download size check (Telegram metadata may include file_size).
  const declaredSize = fileDesc.file_size;
  if (declaredSize != null && declaredSize > MAX_AUDIO_BYTES) {
    log(`Voice/audio handling: oversized file (${declaredSize} bytes) for chat ${chatId}`);
    await ctx
      .reply(`❌ Audio file is too large (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB).`)
      .catch(() => {});
    return null;
  }

  // Download via the shared bounded pipeline.
  let fileUrlRaw: URL | string;
  try {
    fileUrlRaw = await ctx.telegram.getFileLink(fileDesc.file_id);
  } catch (err) {
    log('Voice/audio handling: getFileLink failed:', errorMessage(err));
    await ctx.reply("❌ Couldn't download the audio. Please try resending.").catch(() => {});
    return null;
  }

  const dlResult = await downloadTelegramFile(fileUrlRaw, { maxBytes: MAX_AUDIO_BYTES });

  switch (dlResult.status) {
    case 'malformed-url':
      log(`Voice/audio handling: malformed file URL for chat ${chatId}`);
      await ctx.reply("❌ Couldn't download the audio. Please try resending.").catch(() => {});
      return null;

    case 'ssrf-rejected':
      log(
        `Voice/audio handling: SSRF-rejected URL ` +
          `(protocol=${dlResult.protocol} hostname=${dlResult.hostname}) for chat ${chatId}`,
      );
      await ctx.reply("❌ Couldn't download the audio. Please try resending.").catch(() => {});
      return null;

    case 'fetch-failed':
      log(`Voice/audio handling: fetch failed status=${dlResult.httpStatus} for chat ${chatId}`);
      await ctx.reply("❌ Couldn't download the audio. Please try resending.").catch(() => {});
      return null;

    case 'too-large':
      log(
        `Voice/audio handling: downloaded file (${dlResult.bytesRead} bytes) exceeds limit for chat ${chatId}`,
      );
      await ctx
        .reply(`❌ Audio file is too large (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB).`)
        .catch(() => {});
      return null;

    case 'missing-body':
      log(`Voice/audio handling: fetch response had no body for chat ${chatId}`);
      await ctx.reply("❌ Couldn't download the audio. Please try resending.").catch(() => {});
      return null;

    case 'network-error':
      log('Voice/audio handling download error:', dlResult.safeMessage);
      await ctx.reply("❌ Couldn't download the audio. Please try resending.").catch(() => {});
      return null;

    case 'ok':
      break;
  }

  // Transcribe.
  const fileName = audioFileName(ctx, type);
  const trResult = await transcriber.transcribe(dlResult.bytes, fileName, MAX_AUDIO_BYTES);

  switch (trResult.status) {
    case 'too-large':
      log(`Voice/audio handling: transcriber rejected oversized buffer for chat ${chatId}`);
      await ctx
        .reply(`❌ Audio file is too large (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB).`)
        .catch(() => {});
      return null;

    case 'api-error':
      log(`Voice/audio handling: transcription API error ${trResult.safeMessage} for chat ${chatId}`);
      await ctx
        .reply(`❌ Transcription failed (${trResult.safeMessage}). Please try again.`)
        .catch(() => {});
      return null;

    case 'network-error':
      log('Voice/audio handling: transcription network error:', trResult.safeMessage);
      await ctx.reply('❌ Transcription failed (network error). Please try again.').catch(() => {});
      return null;

    case 'parse-error':
      log('Voice/audio handling: transcription parse error:', trResult.safeMessage);
      await ctx.reply('❌ Transcription failed (unexpected response). Please try again.').catch(() => {});
      return null;

    case 'empty':
      log(`Voice/audio handling: empty transcript for chat ${chatId}`);
      await ctx
        .reply("🎙️ The audio didn't contain recognisable speech. Please try again.")
        .catch(() => {});
      return null;

    case 'ok':
      break;
  }

  const transcript = trResult.text;

  // Echo the transcript so the operator can verify what was heard.
  await ctx
    .reply(`🎙️ *Transcript:* ${transcript}`, { parse_mode: 'Markdown' })
    .catch(() =>
      // Fallback: plain text if Markdown parse fails.
      ctx.reply(`🎙️ Transcript: ${transcript}`).catch(() => {}),
    );

  // Return only the raw transcript — handle() in message.ts adds its own
  // attribution (senderPrefix, replyContext, forwardProvenance) from the
  // synthesised context.  Returning attribution here would duplicate it.
  return transcript;
}
