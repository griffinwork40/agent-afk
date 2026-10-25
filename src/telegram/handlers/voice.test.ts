/**
 * Unit tests for src/telegram/handlers/voice.ts
 *
 * Covers: no-transcriber refusal, download errors, transcription errors,
 * empty transcript, and happy-path transcript echo + text dispatch.
 *
 * Both the Telegram file-download pipeline (media-download.ts) and the
 * transcriber interface are stubbed — no real HTTP calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import type { AudioTranscriber } from '../audio-transcriber.js';

// ---------------------------------------------------------------------------
// Module mocks — must precede imports of the modules under test.
// ---------------------------------------------------------------------------

const { mockDownload } = vi.hoisted(() => ({
  mockDownload: vi.fn<
    [URL | string, { maxBytes: number }],
    Promise<import('../media-download.js').DownloadResult>
  >(async () => ({ status: 'ok', bytes: Buffer.from('fake-audio') })),
}));

vi.mock('../media-download.js', () => ({
  downloadTelegramFile: mockDownload,
}));

// ---------------------------------------------------------------------------
// Import after mocks.
// ---------------------------------------------------------------------------

import {
  handleVoiceOrAudio,
  NO_TRANSCRIBER_REPLY,
  TRANSCRIBE_URL_ENV,
} from './voice.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRANSCRIPT = 'hello world';
const FAKE_FILE_ID = 'file123';

/** Minimal stub AudioTranscriber that returns a successful transcript. */
function makeTranscriber(result?: Partial<Awaited<ReturnType<AudioTranscriber['transcribe']>>>): AudioTranscriber {
  return {
    transcribe: vi.fn(async () => ({
      status: 'ok' as const,
      text: TRANSCRIPT,
      ...result,
    })),
  };
}

/** Build a minimal Telegraf Context for a voice or audio message. */
function makeCtx(
  type: 'voice' | 'audio',
  overrides: {
    fileSize?: number;
    fileName?: string;
    mimeType?: string;
    getFileLinkThrows?: boolean;
  } = {},
): Context {
  const fileDesc =
    type === 'voice'
      ? { file_id: FAKE_FILE_ID, file_size: overrides.fileSize, duration: 3 }
      : {
          file_id: FAKE_FILE_ID,
          file_size: overrides.fileSize,
          file_name: overrides.fileName ?? 'audio.mp3',
          mime_type: overrides.mimeType ?? 'audio/mpeg',
          duration: 5,
        };

  const msg: Partial<Message.VoiceMessage & Message.AudioMessage> = {
    message_id: 1,
    date: 0,
    chat: { id: 42, type: 'private' } as Message.VoiceMessage['chat'],
    from: { id: 99, first_name: 'User', is_bot: false, language_code: 'en' },
    ...(type === 'voice' ? { voice: fileDesc as Message.VoiceMessage['voice'] } : { audio: fileDesc as Message.AudioMessage['audio'] }),
  };

  const replySpy = vi.fn(async () => ({ message_id: 2 } as Message.TextMessage));

  return {
    chat: { id: 42, type: 'private' },
    message: msg,
    botInfo: { id: 1, first_name: 'Bot', is_bot: true, username: 'testbot' },
    telegram: {
      getFileLink: overrides.getFileLinkThrows
        ? vi.fn(async () => { throw new Error('getFileLink failed'); })
        : vi.fn(async () => new URL(`https://api.telegram.org/file/botTOKEN/${FAKE_FILE_ID}`)),
    },
    reply: replySpy,
    react: vi.fn(async () => {}),
  } as unknown as Context;
}

const log = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Default: download succeeds
  mockDownload.mockResolvedValue({ status: 'ok', bytes: Buffer.from('fake-audio') });
});

// ---------------------------------------------------------------------------
// No transcriber configured
// ---------------------------------------------------------------------------

describe('handleVoiceOrAudio: no transcriber', () => {
  it('replies with the named-env-var refusal and returns null (voice)', async () => {
    const ctx = makeCtx('voice');
    const result = await handleVoiceOrAudio(ctx, 'voice', null, log);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(NO_TRANSCRIBER_REPLY);
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(TRANSCRIBE_URL_ENV);
  });

  it('replies with the named-env-var refusal and returns null (audio)', async () => {
    const ctx = makeCtx('audio');
    const result = await handleVoiceOrAudio(ctx, 'audio', null, log);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(NO_TRANSCRIBER_REPLY);
  });
});

// ---------------------------------------------------------------------------
// Download errors
// ---------------------------------------------------------------------------

describe('handleVoiceOrAudio: download errors', () => {
  it('returns null and replies on getFileLink failure', async () => {
    const ctx = makeCtx('voice', { getFileLinkThrows: true });
    const result = await handleVoiceOrAudio(ctx, 'voice', makeTranscriber(), log);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Couldn't download"));
  });

  it('returns null and replies on too-large download', async () => {
    mockDownload.mockResolvedValue({ status: 'too-large', bytesRead: 999 });
    const ctx = makeCtx('voice');
    const result = await handleVoiceOrAudio(ctx, 'voice', makeTranscriber(), log);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('too large'));
  });

  it('returns null and replies on network-error download', async () => {
    mockDownload.mockResolvedValue({ status: 'network-error', safeMessage: 'ECONNREFUSED' });
    const ctx = makeCtx('voice');
    const result = await handleVoiceOrAudio(ctx, 'voice', makeTranscriber(), log);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Couldn't download"));
  });

  it('returns null on pre-download size cap (declaredSize > MAX)', async () => {
    const OVER = 21 * 1024 * 1024;
    const ctx = makeCtx('voice', { fileSize: OVER });
    const result = await handleVoiceOrAudio(ctx, 'voice', makeTranscriber(), log);
    expect(result).toBeNull();
    expect(mockDownload).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('too large'));
  });
});

// ---------------------------------------------------------------------------
// Transcription errors
// ---------------------------------------------------------------------------

describe('handleVoiceOrAudio: transcription errors', () => {
  it('returns null and replies on api-error', async () => {
    const ctx = makeCtx('voice');
    const t = makeTranscriber();
    (t.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'api-error', httpStatus: 500, safeMessage: 'HTTP 500' });
    const result = await handleVoiceOrAudio(ctx, 'voice', t, log);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Transcription failed'));
  });

  it('returns null and replies on network-error from transcriber', async () => {
    const ctx = makeCtx('voice');
    const t = makeTranscriber();
    (t.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'network-error', safeMessage: 'timeout' });
    const result = await handleVoiceOrAudio(ctx, 'voice', t, log);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('network error'));
  });

  it('returns null and replies on empty transcript', async () => {
    const ctx = makeCtx('voice');
    const t = makeTranscriber();
    (t.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'empty' });
    const result = await handleVoiceOrAudio(ctx, 'voice', t, log);
    expect(result).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("didn't contain recognisable speech"));
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('handleVoiceOrAudio: success', () => {
  it('returns the transcript string for a voice message', async () => {
    const ctx = makeCtx('voice');
    const result = await handleVoiceOrAudio(ctx, 'voice', makeTranscriber(), log);
    expect(typeof result).toBe('string');
    expect(result).toContain(TRANSCRIPT);
  });

  it('returns the transcript string for an audio message', async () => {
    const ctx = makeCtx('audio');
    const result = await handleVoiceOrAudio(ctx, 'audio', makeTranscriber(), log);
    expect(typeof result).toBe('string');
    expect(result).toContain(TRANSCRIPT);
  });

  it('echoes the transcript back to the user', async () => {
    const ctx = makeCtx('voice');
    await handleVoiceOrAudio(ctx, 'voice', makeTranscriber(), log);
    const calls = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls as [string, ...unknown[]][];
    const echoCall = calls.find(([text]) => text.includes(TRANSCRIPT));
    expect(echoCall).toBeDefined();
  });

  it('passes audio bytes to the transcriber', async () => {
    const fakeBytes = Buffer.from('audio-bytes');
    mockDownload.mockResolvedValue({ status: 'ok', bytes: fakeBytes });
    const ctx = makeCtx('voice');
    const t = makeTranscriber();
    await handleVoiceOrAudio(ctx, 'voice', t, log);
    expect(t.transcribe).toHaveBeenCalledWith(fakeBytes, expect.any(String), expect.any(Number));
  });

  it('uses voice.ogg filename for voice messages', async () => {
    const ctx = makeCtx('voice');
    const t = makeTranscriber();
    await handleVoiceOrAudio(ctx, 'voice', t, log);
    expect(t.transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'voice.ogg', expect.any(Number));
  });

  it('uses the audio file_name when available', async () => {
    const ctx = makeCtx('audio', { fileName: 'my-recording.mp3' });
    const t = makeTranscriber();
    await handleVoiceOrAudio(ctx, 'audio', t, log);
    expect(t.transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'my-recording.mp3', expect.any(Number));
  });
});
