/**
 * Tests for streaming.draft — sendOrEditDraft, finalizeDraft, DraftState lifecycle.
 *
 * Covers:
 * - Draft lifecycle: create (first call generates integer draft_id) → update → finalize
 * - Throttle gate: calls within DRAFT_THROTTLE_MS are skipped
 * - force=true bypasses the throttle
 * - 429 retry: honors retry_after, retries once, then silently gives up
 * - Group-chat fallback: streamResponse uses sendOrEdit (not callApi) for groups
 * - finalizeDraft: sends sendMessage replacing the draft, falls back to plain text
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramError } from 'telegraf';
import type { Context } from 'telegraf';
import {
  DRAFT_THROTTLE_MS,
  makeDraftState,
  sendOrEditDraft,
  finalizeDraft,
  type DraftState,
} from './streaming.draft.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Context mock whose `telegram.callApi` and
 * `telegram.sendMessage` are vi.fn() spies.
 */
function makeCtx(): {
  ctx: Context;
  callApi: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const callApi = vi.fn().mockResolvedValue({});
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

  const ctx = {
    chat: { id: 100, type: 'private' as const },
    telegram: {
      callApi,
      sendMessage,
    },
  } as unknown as Context;

  return { ctx, callApi, sendMessage };
}

function make429(retryAfterSecs = 1): TelegramError {
  return new TelegramError({
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfterSecs}`,
    parameters: { retry_after: retryAfterSecs },
  });
}

// ---------------------------------------------------------------------------
// makeDraftState
// ---------------------------------------------------------------------------

describe('makeDraftState', () => {
  it('returns a zeroed DraftState', () => {
    const s = makeDraftState();
    expect(s.draftId).toBeNull();
    expect(s.lastDraftAt).toBe(0);
    expect(s.isDraftMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendOrEditDraft — first call generates draft_id
// ---------------------------------------------------------------------------

describe('sendOrEditDraft — first call', () => {
  it('generates an integer draftId and sets isDraftMode on the first call', async () => {
    const { ctx } = makeCtx();
    const state: DraftState = makeDraftState();
    await sendOrEditDraft(state, ctx, 100, 'Hello');
    expect(state.draftId).not.toBeNull();
    expect(typeof state.draftId).toBe('number');
    expect(state.draftId!).toBeGreaterThan(0);
    expect(state.isDraftMode).toBe(true);
  });

  it('calls callApi("sendMessageDraft") with the generated draft_id', async () => {
    const { ctx, callApi } = makeCtx();
    const state: DraftState = makeDraftState();
    await sendOrEditDraft(state, ctx, 100, 'Hello');
    expect(callApi).toHaveBeenCalledOnce();
    const [method, params] = callApi.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe('sendMessageDraft');
    expect(params['chat_id']).toBe(100);
    expect(params['draft_id']).toBe(state.draftId);
    expect(typeof params['text']).toBe('string');
  });

  it('updates lastDraftAt after a successful call', async () => {
    const { ctx } = makeCtx();
    const state: DraftState = makeDraftState();
    const before = Date.now();
    await sendOrEditDraft(state, ctx, 100, 'Hello');
    expect(state.lastDraftAt).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// sendOrEditDraft — reuses the same draft_id on subsequent calls
// ---------------------------------------------------------------------------

describe('sendOrEditDraft — stable draft_id across updates', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reuses the same draft_id for every update in a turn', async () => {
    const { ctx, callApi } = makeCtx();
    const state: DraftState = makeDraftState();

    await sendOrEditDraft(state, ctx, 100, 'chunk 1');
    const firstId = state.draftId;

    // Advance past throttle so the second call goes through.
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS + 10);
    await sendOrEditDraft(state, ctx, 100, 'chunk 2');

    expect(callApi).toHaveBeenCalledTimes(2);
    const secondParams = callApi.mock.calls[1]![1] as Record<string, unknown>;
    expect(secondParams['draft_id']).toBe(firstId);
  });
});

// ---------------------------------------------------------------------------
// sendOrEditDraft — throttle gate
// ---------------------------------------------------------------------------

describe('sendOrEditDraft — throttle gate', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('skips a call when within DRAFT_THROTTLE_MS', async () => {
    const { ctx, callApi } = makeCtx();
    const state: DraftState = makeDraftState();

    await sendOrEditDraft(state, ctx, 100, 'first');
    // Immediately call again without advancing time.
    await sendOrEditDraft(state, ctx, 100, 'second');

    // Only the first call should have gone through.
    expect(callApi).toHaveBeenCalledOnce();
  });

  it('allows a call after DRAFT_THROTTLE_MS has elapsed', async () => {
    const { ctx, callApi } = makeCtx();
    const state: DraftState = makeDraftState();

    await sendOrEditDraft(state, ctx, 100, 'first');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS + 10);
    await sendOrEditDraft(state, ctx, 100, 'second');

    expect(callApi).toHaveBeenCalledTimes(2);
  });

  it('bypasses the throttle when force=true', async () => {
    const { ctx, callApi } = makeCtx();
    const state: DraftState = makeDraftState();

    await sendOrEditDraft(state, ctx, 100, 'first');
    // Don't advance time — force should bypass the gate.
    await sendOrEditDraft(state, ctx, 100, 'forced', true);

    expect(callApi).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// sendOrEditDraft — 429 retry
// ---------------------------------------------------------------------------

describe('sendOrEditDraft — 429 retry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('retries once after retry_after on a 429 and succeeds', async () => {
    const { ctx, callApi } = makeCtx();
    const state: DraftState = makeDraftState();
    let attempt = 0;

    callApi.mockImplementation(async () => {
      attempt++;
      if (attempt === 1) throw make429(1);
      return {};
    });

    const p = sendOrEditDraft(state, ctx, 100, 'text');
    await vi.advanceTimersByTimeAsync(1100);
    await p;

    expect(attempt).toBe(2);
    expect(state.lastDraftAt).toBeGreaterThan(0);
  }, 15_000);

  it('silently gives up after the retry also fails', async () => {
    const { ctx, callApi } = makeCtx();
    const state: DraftState = makeDraftState();

    callApi.mockRejectedValue(make429(1));

    const p = sendOrEditDraft(state, ctx, 100, 'text');
    await vi.advanceTimersByTimeAsync(1100);
    // Must not throw.
    await expect(p).resolves.toBeUndefined();
  }, 15_000);

  it('silently ignores non-429 errors', async () => {
    const { ctx, callApi } = makeCtx();
    const state: DraftState = makeDraftState();

    callApi.mockRejectedValue(new TelegramError({
      error_code: 400,
      description: 'Bad Request: chat not found',
    }));

    // Must not throw.
    await expect(sendOrEditDraft(state, ctx, 100, 'text')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// finalizeDraft
// ---------------------------------------------------------------------------

describe('finalizeDraft', () => {
  it('sends a sendMessage with HTML parse_mode to replace the draft', async () => {
    const { ctx, sendMessage } = makeCtx();
    const state: DraftState = { draftId: 42, lastDraftAt: Date.now(), isDraftMode: true };
    await finalizeDraft(state, ctx, 100, 'Final answer');
    expect(sendMessage).toHaveBeenCalledOnce();
    const [chatId, _text, extra] = sendMessage.mock.calls[0] as [number, string, { parse_mode?: string }];
    expect(chatId).toBe(100);
    expect(extra?.parse_mode).toBe('HTML');
  });

  it('clears isDraftMode and draftId after finalizing', async () => {
    const { ctx } = makeCtx();
    const state: DraftState = { draftId: 42, lastDraftAt: Date.now(), isDraftMode: true };
    await finalizeDraft(state, ctx, 100, 'Final answer');
    expect(state.isDraftMode).toBe(false);
    expect(state.draftId).toBeNull();
  });

  it('is a no-op when isDraftMode is false', async () => {
    const { ctx, sendMessage } = makeCtx();
    const state: DraftState = makeDraftState(); // isDraftMode = false
    await finalizeDraft(state, ctx, 100, 'text');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to plain text on a 400 entity-parse error', async () => {
    const { ctx, sendMessage } = makeCtx();
    const state: DraftState = { draftId: 42, lastDraftAt: Date.now(), isDraftMode: true };
    let attempt = 0;
    sendMessage.mockImplementation(async (_cid: number, _text: string, extra?: { parse_mode?: string }) => {
      attempt++;
      if (extra?.parse_mode === 'HTML') throw new TelegramError({ error_code: 400, description: "can't parse entities: unclosed tag" });
      return { message_id: 1 };
    });
    await finalizeDraft(state, ctx, 100, 'Final answer');
    expect(attempt).toBe(2);
    // Second call must have no parse_mode.
    const secondExtra = sendMessage.mock.calls[1]![2] as { parse_mode?: string } | undefined;
    expect(secondExtra?.parse_mode).toBeUndefined();
  });

  it('rethrows non-parse Telegram errors from finalizeDraft', async () => {
    const { ctx, sendMessage } = makeCtx();
    const state: DraftState = { draftId: 42, lastDraftAt: Date.now(), isDraftMode: true };
    const err = new TelegramError({ error_code: 403, description: 'Forbidden: bot was blocked by the user' });
    sendMessage.mockRejectedValue(err);
    await expect(finalizeDraft(state, ctx, 100, 'text')).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// Group chat fallback: streamResponse uses editMessageText, not callApi
// ---------------------------------------------------------------------------

describe('streamResponse — group chat uses editMessageText fallback', () => {
  it('calls editMessageText (not callApi) in a group chat', async () => {
    const { streamResponse } = await import('./streaming.js');
    const callApi = vi.fn().mockResolvedValue({});
    const editMessageText = vi.fn().mockResolvedValue(true);
    const replies: string[] = [];

    const ctx = {
      chat: { id: 200, type: 'group' as const },
      reply: vi.fn(async (text: string) => {
        replies.push(text);
        return { message_id: replies.length, text, chat: { id: 200, type: 'group' as const }, date: 0 };
      }),
      telegram: { callApi, editMessageText, deleteMessage: vi.fn().mockResolvedValue(true) },
    } as unknown as Context;

    const session = {
      state: 'idle',
      sendMessage: vi.fn(),
      sendMessageStream: async function* () {
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'Hi from group' } };
        yield { type: 'done' as const, metadata: undefined };
      },
      getOutputStream: vi.fn(),
      close: vi.fn(),
      waitForInitialization: vi.fn().mockResolvedValue({}),
      getSessionIdentity: vi.fn().mockReturnValue({}),
      getSessionMetadata: vi.fn().mockReturnValue({}),
      getQuery: vi.fn(),
      getLastResponseMetadata: vi.fn().mockReturnValue(null),
      interrupt: vi.fn(),
      setModel: vi.fn(),
      setPermissionMode: vi.fn(),
      supportedCommands: vi.fn().mockResolvedValue([]),
      supportedModels: vi.fn().mockResolvedValue([]),
      supportedAgents: vi.fn().mockResolvedValue([]),
      getContextUsage: vi.fn().mockResolvedValue({}),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      accountInfo: vi.fn().mockResolvedValue({}),
    } as unknown as import('../agent/types.js').IAgentSession;

    await streamResponse(ctx, session, 'hello group');

    // Group path: edit preview was used, draft callApi was NOT.
    expect(callApi).not.toHaveBeenCalledWith('sendMessageDraft', expect.anything());
    expect(editMessageText).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Private chat: streamResponse uses sendMessageDraft, not editMessageText
// ---------------------------------------------------------------------------

describe('streamResponse — private chat uses sendMessageDraft', () => {
  it('calls callApi("sendMessageDraft") and does NOT call editMessageText', async () => {
    const { streamResponse } = await import('./streaming.js');
    const callApi = vi.fn().mockResolvedValue({});
    const editMessageText = vi.fn().mockResolvedValue(true);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });

    const ctx = {
      chat: { id: 300, type: 'private' as const },
      reply: vi.fn().mockResolvedValue({ message_id: 1, text: '', chat: { id: 300 }, date: 0 }),
      telegram: { callApi, editMessageText, sendMessage, deleteMessage: vi.fn().mockResolvedValue(true) },
    } as unknown as Context;

    const session = {
      state: 'idle',
      sendMessage: vi.fn(),
      sendMessageStream: async function* () {
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'Draft answer' } };
        yield { type: 'done' as const, metadata: undefined };
      },
      getOutputStream: vi.fn(),
      close: vi.fn(),
      waitForInitialization: vi.fn().mockResolvedValue({}),
      getSessionIdentity: vi.fn().mockReturnValue({}),
      getSessionMetadata: vi.fn().mockReturnValue({}),
      getQuery: vi.fn(),
      getLastResponseMetadata: vi.fn().mockReturnValue(null),
      interrupt: vi.fn(),
      setModel: vi.fn(),
      setPermissionMode: vi.fn(),
      supportedCommands: vi.fn().mockResolvedValue([]),
      supportedModels: vi.fn().mockResolvedValue([]),
      supportedAgents: vi.fn().mockResolvedValue([]),
      getContextUsage: vi.fn().mockResolvedValue({}),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      accountInfo: vi.fn().mockResolvedValue({}),
    } as unknown as import('../agent/types.js').IAgentSession;

    await streamResponse(ctx, session, 'hello private');

    // Private path: draft API was used.
    expect(callApi).toHaveBeenCalledWith('sendMessageDraft', expect.objectContaining({ chat_id: 300 }));
    // The in-place edit path must NOT have been used.
    expect(editMessageText).not.toHaveBeenCalled();
    // Finalize: a plain sendMessage was sent to replace the draft.
    expect(sendMessage).toHaveBeenCalledWith(300, expect.any(String), expect.objectContaining({ parse_mode: 'HTML' }));
    // No separate placeholder reply (ctx.reply is for groups).
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
