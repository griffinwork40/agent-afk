import { describe, it, expect } from 'vitest';
import {
  GENERAL_TOPIC_ID,
  isGeneral,
  routeKey,
  sendOptions,
  routeFromCtx,
  type TelegramRoute,
} from './route.js';

// ---------------------------------------------------------------------------
// isGeneral()
// ---------------------------------------------------------------------------
describe('isGeneral()', () => {
  it('returns true when threadId is undefined', () => {
    const route: TelegramRoute = { chatId: 100 };
    expect(isGeneral(route)).toBe(true);
  });

  it('returns true when threadId is 0 (Telegram edge-case)', () => {
    const route: TelegramRoute = { chatId: 100, threadId: 0 };
    expect(isGeneral(route)).toBe(true);
  });

  it('returns true when threadId equals GENERAL_TOPIC_ID (1)', () => {
    const route: TelegramRoute = { chatId: 100, threadId: GENERAL_TOPIC_ID };
    expect(isGeneral(route)).toBe(true);
  });

  it('returns false for a real topic id (42)', () => {
    const route: TelegramRoute = { chatId: 100, threadId: 42 };
    expect(isGeneral(route)).toBe(false);
  });

  it('returns false for other non-General thread ids', () => {
    expect(isGeneral({ chatId: 1, threadId: 2 })).toBe(false);
    expect(isGeneral({ chatId: 1, threadId: 999 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// routeKey()
// ---------------------------------------------------------------------------
describe('routeKey()', () => {
  it('returns bare chatId string for General route (no threadId)', () => {
    expect(routeKey({ chatId: 12345 })).toBe('12345');
  });

  it('returns bare chatId string when threadId is 0', () => {
    expect(routeKey({ chatId: 12345, threadId: 0 })).toBe('12345');
  });

  it('returns bare chatId string when threadId is GENERAL_TOPIC_ID (1)', () => {
    expect(routeKey({ chatId: 12345, threadId: 1 })).toBe('12345');
  });

  it('returns chatId:threadId for a real topic', () => {
    expect(routeKey({ chatId: 12345, threadId: 42 })).toBe('12345:42');
  });

  it('preserves back-compat key format for pre-registry single-session users', () => {
    // The bare-chatId key must be String(chatId) — no colon, no suffix.
    const key = routeKey({ chatId: 999888 });
    expect(key).toBe('999888');
    expect(key.includes(':')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendOptions()
// ---------------------------------------------------------------------------
describe('sendOptions()', () => {
  it('returns empty object for General route (no threadId)', () => {
    expect(sendOptions({ chatId: 1 })).toEqual({});
  });

  it('returns empty object when threadId is 0', () => {
    expect(sendOptions({ chatId: 1, threadId: 0 })).toEqual({});
  });

  it('returns empty object when threadId is GENERAL_TOPIC_ID (1)', () => {
    expect(sendOptions({ chatId: 1, threadId: 1 })).toEqual({});
  });

  it('includes message_thread_id for a real topic', () => {
    expect(sendOptions({ chatId: 1, threadId: 42 })).toEqual({ message_thread_id: 42 });
  });

  it('does NOT include message_thread_id key at all for General (byte-identical legacy sends)', () => {
    const opts = sendOptions({ chatId: 1 });
    expect('message_thread_id' in opts).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// routeFromCtx() — threadId normalization
// ---------------------------------------------------------------------------

/** Minimal Telegraf Context stub. */
function makeCtx(opts: {
  chatId?: number;
  threadId?: number;
  isTopic?: boolean;
  source?: 'message' | 'editedMessage' | 'callbackQuery';
}): Parameters<typeof routeFromCtx>[0] {
  const { chatId, threadId, isTopic, source = 'message' } = opts;

  const msgPayload: Record<string, unknown> = {};
  if (threadId !== undefined) msgPayload['message_thread_id'] = threadId;
  if (isTopic) msgPayload['is_topic_message'] = true;

  const chat = chatId !== undefined ? { id: chatId } : undefined;

  switch (source) {
    case 'editedMessage':
      return { chat, editedMessage: msgPayload } as unknown as Parameters<typeof routeFromCtx>[0];
    case 'callbackQuery':
      return {
        chat,
        callbackQuery: { message: msgPayload },
      } as unknown as Parameters<typeof routeFromCtx>[0];
    default:
      return { chat, message: msgPayload } as unknown as Parameters<typeof routeFromCtx>[0];
  }
}

describe('routeFromCtx()', () => {
  it('returns undefined when ctx has no chat', () => {
    const ctx = { chat: undefined } as unknown as Parameters<typeof routeFromCtx>[0];
    expect(routeFromCtx(ctx)).toBeUndefined();
  });

  it('returns route with no threadId for a normal message (no thread)', () => {
    const route = routeFromCtx(makeCtx({ chatId: 777 }));
    expect(route).toBeDefined();
    expect(route!.chatId).toBe(777);
    expect(route!.threadId).toBeUndefined();
  });

  it('normalizes threadId=0 to no threadId on the returned route', () => {
    const route = routeFromCtx(makeCtx({ chatId: 777, threadId: 0 }));
    expect(route).toBeDefined();
    expect(route!.threadId).toBeUndefined();
  });

  it('preserves a real topic threadId', () => {
    const route = routeFromCtx(makeCtx({ chatId: 777, threadId: 42 }));
    expect(route!.threadId).toBe(42);
  });

  it('preserves GENERAL_TOPIC_ID (1) as-is (isGeneral() handles it downstream)', () => {
    // threadId=1 is a valid value to store; isGeneral() treats it as General.
    const route = routeFromCtx(makeCtx({ chatId: 777, threadId: 1 }));
    expect(route!.threadId).toBe(1);
  });

  it('reads threadId from editedMessage when message is absent', () => {
    const route = routeFromCtx(makeCtx({ chatId: 777, threadId: 42, source: 'editedMessage' }));
    expect(route!.threadId).toBe(42);
  });

  it('reads threadId from callbackQuery.message when message is absent', () => {
    const route = routeFromCtx(makeCtx({ chatId: 777, threadId: 42, source: 'callbackQuery' }));
    expect(route!.threadId).toBe(42);
  });

  it('normalizes threadId=0 from editedMessage to no threadId', () => {
    const route = routeFromCtx(makeCtx({ chatId: 777, threadId: 0, source: 'editedMessage' }));
    expect(route!.threadId).toBeUndefined();
  });

  it('normalizes threadId=0 from callbackQuery.message to no threadId', () => {
    const route = routeFromCtx(makeCtx({ chatId: 777, threadId: 0, source: 'callbackQuery' }));
    expect(route!.threadId).toBeUndefined();
  });

  it('sets isTopicMessage when is_topic_message is true', () => {
    const route = routeFromCtx(makeCtx({ chatId: 777, threadId: 42, isTopic: true }));
    expect(route!.isTopicMessage).toBe(true);
  });

  it('does not set isTopicMessage when flag is absent', () => {
    const route = routeFromCtx(makeCtx({ chatId: 777, threadId: 42 }));
    expect(route!.isTopicMessage).toBeUndefined();
  });
});
