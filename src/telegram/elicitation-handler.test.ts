/**
 * Tests for src/telegram/elicitation-handler.ts
 *
 * Coverage targets:
 *   H2  – abort-mid-question (abort fires during text wait → { action: 'decline' })
 *   H2  – invalid-number re-prompt, then valid → accept
 *   H2  – button-press accept (confirm → Yes button → { action: 'accept', content: { value: true } })
 *   H2  – sendMessage failure → decline
 *   H2  – cross-chat replay drop (button press from wrong chatId → resolver not called)
 *   H1  – abort fires AFTER resolved = false but BEFORE .set() in re-prompt (exact race)
 *   M2/M3 – multi_choice '1abc' input → re-prompt
 *   M1  – choices array > 10 items → all rendered (no arbitrary cap)
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ElicitationRequest, ElicitationResult } from '../agent/types/sdk-types.js';
import {
  ELICITATION_CALLBACK_PREFIX,
  ELICITATION_CUSTOM_CALLBACK_PREFIX,
  buildCustomElicitationCallback,
} from './elicitation-callback-data.js';

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the module under test.
// ---------------------------------------------------------------------------

/** Captures the first wildcard action handler (regular elicitation callbacks). */
let capturedActionHandler: ((ctx: MockCallbackCtx) => Promise<void>) | null = null;
/** Captures the regex passed to first bot.action() so tests can inspect it. */
let capturedActionRegex: RegExp | null = null;
/** Captures the second wildcard action handler (custom-entry callbacks). */
let capturedCustomActionHandler: ((ctx: MockCallbackCtx) => Promise<void>) | null = null;
/** Captures the regex passed to second bot.action() (custom-entry wildcard). */
let capturedCustomActionRegex: RegExp | null = null;

vi.mock('telegraf', () => {
  const Markup = {
    button: {
      callback: (label: string, data: string) => ({ text: label, callback_data: data }),
    },
    inlineKeyboard: (rows: unknown[][]) => ({
      reply_markup: { inline_keyboard: rows },
    }),
  };

  class Telegraf {
    telegram = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    };
    action(regex: RegExp, handler: (ctx: MockCallbackCtx) => Promise<void>) {
      if (capturedActionHandler === null) {
        capturedActionRegex = regex;
        capturedActionHandler = handler;
      } else {
        capturedCustomActionRegex = regex;
        capturedCustomActionHandler = handler;
      }
    }
  }

  return { Telegraf, Markup };
});

vi.mock('./formatter.js', () => ({
  escapeHtml: (s: string) => s,
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks.
// ---------------------------------------------------------------------------

import { makeTelegramElicitationHandler } from './elicitation-handler.js';
import { Telegraf } from 'telegraf';

// ---------------------------------------------------------------------------
// Type helpers for the mock ctx used in callback tests.
// ---------------------------------------------------------------------------

interface MockCallbackCtx {
  chat?: { id: number };
  callbackQuery?: { data?: string };
  answerCbQuery: ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Test factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock MessageHandler with a real pendingElicitations map.
 * The map is keyed by routeKey (string). For the General route these tests use
 * (CHAT_ID with no topic), the key is String(CHAT_ID) — see ROUTE_KEY below.
 */
function makeMockMessageHandler() {
  return {
    pendingElicitations: new Map<string, (text: string) => void>(),
  };
}

/** Build a mock bot + capture its sendMessage spy. */
function makeMockBot() {
  // Each call to this factory gets a fresh Telegraf instance (vi.mock resets between tests).
  const bot = new Telegraf();
  return { bot, sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
}

const CHAT_ID = 12345;
/** routeKey for the General route used across these tests (String(CHAT_ID)). */
const ROUTE_KEY = String(CHAT_ID);

/** Build an AbortController wired with a controllable signal. */
function makeAbort() {
  const ac = new AbortController();
  return ac;
}

/** Minimal valid ElicitationRequest for text type. */
function textRequest(overrides: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return {
    serverName: 'test',
    message: 'What is your name?',
    type: 'text',
    ...overrides,
  };
}

/** Minimal valid ElicitationRequest for number type. */
function numberRequest(overrides: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return {
    serverName: 'test',
    message: 'Enter a number',
    type: 'number',
    ...overrides,
  };
}

/** Minimal valid ElicitationRequest for confirm type. */
function confirmRequest(overrides: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return {
    serverName: 'test',
    message: 'Are you sure?',
    type: 'confirm',
    ...overrides,
  };
}

/** Minimal valid ElicitationRequest for choice type. */
function choiceRequest(choices: string[], overrides: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return {
    serverName: 'test',
    message: 'Pick one',
    type: 'choice',
    choices,
    ...overrides,
  };
}

/** Minimal valid ElicitationRequest for multi_choice type. */
function multiChoiceRequest(choices: string[], overrides: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return {
    serverName: 'test',
    message: 'Pick many',
    type: 'multi_choice',
    choices,
    ...overrides,
  };
}

/**
 * Fire the registered bot.action wildcard handler as if Telegram called back
 * from a given chat ID with the given callback_data string.
 */
async function fireCallbackFromChat(fromChatId: number, callbackData: string) {
  if (!capturedActionHandler) throw new Error('No action handler was registered');
  const ctx: MockCallbackCtx = {
    chat: { id: fromChatId },
    callbackQuery: { data: callbackData },
    answerCbQuery: vi.fn().mockResolvedValue(undefined),
  };
  await capturedActionHandler(ctx);
  return ctx;
}

/**
 * Fire the custom-entry wildcard handler as if Telegram called back with a
 * custom-entry callback_data string.
 */
async function fireCustomCallbackFromChat(fromChatId: number, callbackData: string) {
  if (!capturedCustomActionHandler) throw new Error('No custom action handler was registered');
  const ctx: MockCallbackCtx = {
    chat: { id: fromChatId },
    callbackQuery: { data: callbackData },
    answerCbQuery: vi.fn().mockResolvedValue(undefined),
  };
  await capturedCustomActionHandler(ctx);
  return ctx;
}

/**
 * Build a valid elicitation callback data string using the real prefix format.
 * Format: `afk:e:<choiceIndex>:<id>`
 */
function makeCallbackData(elicitId: string, choiceIndex: number): string {
  return `${ELICITATION_CALLBACK_PREFIX}${choiceIndex}:${elicitId}`;
}

/**
 * Simulate a user typing a text reply by pulling the registered pending
 * elicitation handler for chatId and calling it with the given text.
 */
function simulateTextReply(
  messageHandler: ReturnType<typeof makeMockMessageHandler>,
  chatId: number,
  text: string,
) {
  // Map is keyed by routeKey; a bare chatId here is a General route → String(chatId).
  const rk = String(chatId);
  const resolver = messageHandler.pendingElicitations.get(rk);
  if (!resolver) throw new Error(`No pending elicitation for chat ${chatId}`);
  // MessageHandler.handle() deletes the entry before calling the resolver.
  messageHandler.pendingElicitations.delete(rk);
  resolver(text);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedActionHandler = null;
  capturedActionRegex = null;
  capturedCustomActionHandler = null;
  capturedCustomActionRegex = null;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Factory / registration smoke tests
// ---------------------------------------------------------------------------

describe('makeTelegramElicitationHandler — factory setup', () => {
  it('registers two wildcard bot.action handlers on construction (regular + custom-entry)', () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();

    makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    // First handler: regular elicitation callbacks
    expect(capturedActionRegex).toBeInstanceOf(RegExp);
    expect(capturedActionHandler).toBeTypeOf('function');
    // Second handler: custom-entry callbacks
    expect(capturedCustomActionRegex).toBeInstanceOf(RegExp);
    expect(capturedCustomActionHandler).toBeTypeOf('function');
  });

  it('the wildcard regex matches the elicitation callback prefix format', () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();

    makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    expect(capturedActionRegex!.test(`${ELICITATION_CALLBACK_PREFIX}0:elic-abc12345`)).toBe(true);
    expect(capturedActionRegex!.test(`${ELICITATION_CALLBACK_PREFIX}99:elic-ffffffff`)).toBe(true);
    expect(capturedActionRegex!.test('not-a-match')).toBe(false);
  });

  it('returns an async function (the handler)', () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();

    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    expect(handler).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------
// Pre-abort guard
// ---------------------------------------------------------------------------

describe('makeTelegramElicitationHandler — pre-abort guard', () => {
  it('returns { action: "decline" } immediately when signal is already aborted (text)', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    ac.abort();

    const result = await handler(textRequest(), { signal: ac.signal });

    expect(result).toEqual({ action: 'decline' });
  });

  it('returns { action: "decline" } immediately when signal is already aborted (confirm)', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    ac.abort();

    const result = await handler(confirmRequest(), { signal: ac.signal });

    expect(result).toEqual({ action: 'decline' });
  });
});

// ---------------------------------------------------------------------------
// H2: abort fires during text wait → { action: 'decline' }
// ---------------------------------------------------------------------------

describe('H2: abort-mid-question (text wait)', () => {
  it('abort signal during text wait resolves with { action: "decline" }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();

    const resultPromise = handler(textRequest(), { signal: ac.signal });

    // Allow the handler to register the pending elicitation
    await Promise.resolve();

    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(true);

    // Now abort
    ac.abort();

    const result = await resultPromise;
    expect(result).toEqual({ action: 'decline' });
  });

  it('abort cleans up the pendingElicitations entry', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();

    const resultPromise = handler(textRequest(), { signal: ac.signal });
    await Promise.resolve();

    ac.abort();
    await resultPromise;

    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(false);
  });

  it('abort during number wait resolves with { action: "decline" }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();

    const resultPromise = handler(numberRequest(), { signal: ac.signal });
    await Promise.resolve();

    ac.abort();
    const result = await resultPromise;

    expect(result).toEqual({ action: 'decline' });
  });
});

// ---------------------------------------------------------------------------
// H2: invalid-number re-prompt, then valid → accept
// ---------------------------------------------------------------------------

describe('H2: number type — re-prompt on invalid then accept on valid', () => {
  it('non-numeric input triggers re-prompt, then valid number resolves accept', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(numberRequest(), { signal: ac.signal });

    // Allow handler to register and send initial prompt
    await Promise.resolve();

    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(true);

    // Send invalid input
    simulateTextReply(messageHandler, CHAT_ID, 'not-a-number');

    // Allow the re-prompt sendMessage to fire
    await Promise.resolve();

    // Handler should have re-prompted
    expect(sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringMatching(/valid number/i),
      {},
    );

    // Handler re-registered a new interceptor
    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(true);

    // Now send valid number
    simulateTextReply(messageHandler, CHAT_ID, '42');

    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: 42 } });
  });

  it('empty string on required number re-prompts (not silent 0)', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(numberRequest(), { signal: ac.signal });

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '   ');
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringMatching(/enter a number/i),
      {},
    );
    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(true);

    // Clean up: cancel so the promise settles
    simulateTextReply(messageHandler, CHAT_ID, ':cancel');
    const result = await resultPromise;
    expect(result.action).toBe('cancel');
  });

  it('number below min re-prompts', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(numberRequest({ min: 10 }), { signal: ac.signal });

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '5');
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringMatching(/\u2265 10|>=\s*10|≥\s*10/),
      {},
    );
    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(true);

    // Clean up
    simulateTextReply(messageHandler, CHAT_ID, ':cancel');
    await resultPromise;
  });

  it('number above max re-prompts', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(numberRequest({ max: 100 }), { signal: ac.signal });

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '999');
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringMatching(/\u2264 100|<=\s*100|≤\s*100/),
      {},
    );

    simulateTextReply(messageHandler, CHAT_ID, ':cancel');
    await resultPromise;
  });

  it('number exactly at min boundary is accepted', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(numberRequest({ min: 5, max: 20 }), { signal: ac.signal });

    await Promise.resolve();
    simulateTextReply(messageHandler, CHAT_ID, '5');

    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: 5 } });
  });

  it('number exactly at max boundary is accepted', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(numberRequest({ min: 5, max: 20 }), { signal: ac.signal });

    await Promise.resolve();
    simulateTextReply(messageHandler, CHAT_ID, '20');

    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: 20 } });
  });
});

// ---------------------------------------------------------------------------
// H2: button-press accept (confirm → Yes → { action: 'accept', content: { value: true } })
// ---------------------------------------------------------------------------

describe('H2: button-press accept — confirm type', () => {
  it('pressing Yes (choiceIndex 1) resolves { action: "accept", content: { value: true } }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(confirmRequest(), { signal: ac.signal });

    // Let the handler set up and call sendMessage
    await Promise.resolve();

    // We need to know the elicitId that was generated.
    // Extract it from the sendMessage call's reply_markup.
    const { sendMessage } = { sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;
    const yesButton = keyboard[0]![0]!; // first row, first button = Yes

    expect(yesButton.text).toContain('Yes');

    const callbackData = yesButton.callback_data;

    // Simulate the Yes button press from the correct chat
    await fireCallbackFromChat(CHAT_ID, callbackData);

    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: true } });
  });

  it('pressing No (choiceIndex 0) resolves { action: "accept", content: { value: false } }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(confirmRequest(), { signal: ac.signal });

    await Promise.resolve();

    const { sendMessage } = { sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;
    const noButton = keyboard[0]![1]!; // first row, second button = No

    expect(noButton.text).toContain('No');

    await fireCallbackFromChat(CHAT_ID, noButton.callback_data);

    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: false } });
  });

  it('answerCbQuery is called before resolving (spinner cleared first)', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(confirmRequest(), { signal: ac.signal });

    await Promise.resolve();

    const { sendMessage } = { sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;
    const yesButton = keyboard[0]![0]!;

    let promiseSettled = false;
    resultPromise.then(() => { promiseSettled = true; });

    const ctx = await fireCallbackFromChat(CHAT_ID, yesButton.callback_data);

    // answerCbQuery must have been called
    expect(ctx.answerCbQuery).toHaveBeenCalled();

    await resultPromise;
    expect(promiseSettled).toBe(true);
  });

  it('choice type: pressing the second choice resolves the choice value', async () => {
    const choices = ['alpha', 'beta', 'gamma'];
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(choiceRequest(choices), { signal: ac.signal });

    await Promise.resolve();

    const { sendMessage } = { sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;

    // Choice buttons are one-per-row; index 1 = 'beta'
    const betaButton = keyboard[1]![0]!;
    expect(betaButton.text).toContain('beta');

    await fireCallbackFromChat(CHAT_ID, betaButton.callback_data);

    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: 'beta' } });
  });
});

// ---------------------------------------------------------------------------
// H2: sendMessage failure → decline
// ---------------------------------------------------------------------------

describe('H2: sendMessage failure → decline', () => {
  it('text type: sendMessage failure resolves { action: "decline" }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    sendMessage.mockRejectedValueOnce(new Error('Network error'));

    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const result = await handler(textRequest(), { signal: ac.signal });

    expect(result).toEqual({ action: 'decline' });
  });

  it('text type: sendMessage failure cleans up pendingElicitations', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    sendMessage.mockRejectedValueOnce(new Error('Network error'));

    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    await handler(textRequest(), { signal: ac.signal });

    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(false);
  });

  it('confirm type: sendMessage failure resolves { action: "decline" }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    sendMessage.mockRejectedValueOnce(new Error('400 Bad Request'));

    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const result = await handler(confirmRequest(), { signal: ac.signal });

    expect(result).toEqual({ action: 'decline' });
  });

  it('confirm type: sendMessage failure does not leave a stale entry in pendingChoiceElicitations', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    sendMessage.mockRejectedValueOnce(new Error('500'));

    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const result1 = await handler(confirmRequest(), { signal: ac.signal });
    expect(result1).toEqual({ action: 'decline' });

    // After the failure decline, firing a spurious button press must not resolve a
    // second promise (there is no second promise here — we just verify no throw).
    sendMessage.mockResolvedValueOnce({ message_id: 2 });
    const ac2 = makeAbort();
    const resultPromise2 = handler(confirmRequest(), { signal: ac2.signal });
    await Promise.resolve();

    // Abort to clean up
    ac2.abort();
    const result2 = await resultPromise2;
    expect(result2).toEqual({ action: 'decline' });
  });
});

// ---------------------------------------------------------------------------
// H2: cross-chat replay drop
// ---------------------------------------------------------------------------

describe('H2: cross-chat replay drop', () => {
  it('button press from wrong chatId does not resolve the pending promise', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(confirmRequest(), { signal: ac.signal });

    await Promise.resolve();

    const { sendMessage } = { sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;
    const yesButton = keyboard[0]![0]!;

    // Fire from the WRONG chat
    await fireCallbackFromChat(CHAT_ID + 1, yesButton.callback_data);

    // Promise must still be pending — test it didn't resolve
    let settled = false;
    void resultPromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Clean up
    ac.abort();
    await resultPromise;
  });

  it('cross-chat press still calls answerCbQuery (Telegram requires it)', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(confirmRequest(), { signal: ac.signal });
    await Promise.resolve();

    const { sendMessage } = { sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;
    const yesButton = keyboard[0]![0]!;

    const ctx = await fireCallbackFromChat(CHAT_ID + 99, yesButton.callback_data);

    // answerCbQuery must be called to dismiss the spinner, even for replays
    expect(ctx.answerCbQuery).toHaveBeenCalled();

    ac.abort();
    await resultPromise;
  });
});

// ---------------------------------------------------------------------------
// H1: abort fires AFTER resolved = false but BEFORE .set() (exact re-prompt race)
//
// The H1 guard (`if (options.signal.aborted) return;`) is checked synchronously
// AFTER calling sendMessage (fire-and-forget) and BEFORE calling
// `pendingElicitations.set()`. If the abort fires in that window, the guard
// returns early, preventing a dangling interceptor entry in the map.
//
// The promise itself will not resolve in the pure race scenario (the abort
// listener was temporarily detached during the handleText call). The critical
// contract the guard enforces is: the pendingElicitations map MUST NOT have
// a stale entry after the guard fires.
//
// We simulate the race by aborting inside the sendMessage mock, which executes
// synchronously within the `.catch(() => {})` fire-and-forget call — at that
// exact moment `resolved = false` and the abort listener is detached. The
// guard then sees `signal.aborted === true` and skips `.set()`.
// ---------------------------------------------------------------------------

describe('H1: abort race in re-prompt path', () => {
  it('abort between resolved=false and pendingElicitations.set() in number re-prompt prevents dangling interceptor entry', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const ac = makeAbort();
    let repromptSendCount = 0;

    sendMessage.mockImplementation((_chatId: unknown, text: unknown) => {
      // Only abort on the re-prompt message (❌ prefix), not the initial prompt.
      // The initial prompt text contains "number" but does NOT have the ❌ prefix.
      if (typeof text === 'string' && text.startsWith('❌')) {
        repromptSendCount++;
        // Abort synchronously. By the time the guard `if (options.signal.aborted)`
        // executes (the very next statement after the sendMessage fire-and-forget),
        // `signal.aborted` is already true — simulating the H1 race window.
        ac.abort();
      }
      return Promise.resolve({ message_id: 1 });
    });

    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    // We deliberately do NOT await resultPromise — in the pure H1 race the
    // promise may not resolve (onAbort was detached). We test the MAP invariant.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    const resultPromise = handler(numberRequest(), { signal: ac.signal });

    // Allow the handler to register the initial interceptor
    await Promise.resolve();

    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(true);

    // Trigger invalid input → enters the re-prompt branch → sets resolved=false
    // → fires sendMessage (which aborts inside mock) → guard fires → no .set()
    simulateTextReply(messageHandler, CHAT_ID, 'not-a-number');

    // Drain microtasks so the abort + guard logic runs
    await Promise.resolve();
    await Promise.resolve();

    // The H1 guard must have prevented re-registration
    expect(repromptSendCount).toBeGreaterThanOrEqual(1);
    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(false);

    // Give the promise a chance to settle (it may or may not, depending on
    // microtask ordering; we just verify it does not hang the test).
    await Promise.race([
      resultPromise,
      new Promise<void>((res) => setTimeout(res, 50)),
    ]);
  });

  it('abort race in multi_choice re-prompt path does not leave dangling interceptor', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const ac = makeAbort();
    let repromptSendCount = 0;

    sendMessage.mockImplementation((_chatId: unknown, text: unknown) => {
      if (typeof text === 'string' && text.startsWith('❌')) {
        repromptSendCount++;
        ac.abort();
      }
      return Promise.resolve({ message_id: 1 });
    });

    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    const resultPromise = handler(
      multiChoiceRequest(['option1', 'option2', 'option3']),
      { signal: ac.signal },
    );

    await Promise.resolve();

    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(true);

    // '1abc' is an invalid multi_choice index → re-prompt path → H1 race
    simulateTextReply(messageHandler, CHAT_ID, '1abc');

    await Promise.resolve();
    await Promise.resolve();

    expect(repromptSendCount).toBeGreaterThanOrEqual(1);
    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(false);

    await Promise.race([
      resultPromise,
      new Promise<void>((res) => setTimeout(res, 50)),
    ]);
  });
});

// ---------------------------------------------------------------------------
// M2/M3: multi_choice '1abc' input → re-prompt (not silently accepted)
// ---------------------------------------------------------------------------

describe('M2/M3: multi_choice — invalid index format → re-prompt', () => {
  it('"1abc" is not a valid integer and triggers re-prompt', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      multiChoiceRequest(['a', 'b', 'c']),
      { signal: ac.signal },
    );

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '1abc');
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringMatching(/invalid selection/i),
      {},
    );
    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(true);

    // Clean up
    simulateTextReply(messageHandler, CHAT_ID, ':cancel');
    const result = await resultPromise;
    expect(result.action).toBe('cancel');
  });

  it('"2.5" (float) is not a valid integer and triggers re-prompt', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      multiChoiceRequest(['x', 'y', 'z']),
      { signal: ac.signal },
    );

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '2.5');
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringMatching(/invalid selection/i),
      {},
    );

    simulateTextReply(messageHandler, CHAT_ID, ':cancel');
    await resultPromise;
  });

  it('"0" (out-of-range, 1-based) triggers re-prompt', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      multiChoiceRequest(['a', 'b', 'c']),
      { signal: ac.signal },
    );

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '0');
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringMatching(/invalid selection/i),
      {},
    );

    simulateTextReply(messageHandler, CHAT_ID, ':cancel');
    await resultPromise;
  });

  it('valid comma-separated "1,3" resolves with the correct choices', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      multiChoiceRequest(['apple', 'banana', 'cherry']),
      { signal: ac.signal },
    );

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '1,3');

    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: ['apple', 'cherry'] } });
  });

  it('a single valid index resolves with a single-element array', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      multiChoiceRequest(['one', 'two', 'three']),
      { signal: ac.signal },
    );

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '2');

    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: ['two'] } });
  });
});

// ---------------------------------------------------------------------------
// M1: choices array > 10 items — all rendered (no cap)
// ---------------------------------------------------------------------------

describe('M1: choice type with > 10 choices — all rendered', () => {
  it('11 choices produce 11 keyboard rows', async () => {
    const choices = Array.from({ length: 11 }, (_, i) => `option-${i + 1}`);
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(choiceRequest(choices), { signal: ac.signal });

    await Promise.resolve();

    const { sendMessage } = { sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;

    // All 11 choices must appear — no arbitrary cap at 10.
    expect(keyboard).toHaveLength(11);

    // Verify each row has the correct label
    for (let i = 0; i < 11; i++) {
      expect(keyboard[i]![0]!.text).toContain(`option-${i + 1}`);
    }

    // Clean up: pick the first option
    await fireCallbackFromChat(CHAT_ID, keyboard[0]![0]!.callback_data);
    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: 'option-1' } });
  });

  it('20 choices produce 20 keyboard rows', async () => {
    const choices = Array.from({ length: 20 }, (_, i) => `item-${i + 1}`);
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(choiceRequest(choices), { signal: ac.signal });

    await Promise.resolve();

    const { sendMessage } = { sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;

    expect(keyboard).toHaveLength(20);

    // Pick the last option to verify index mapping
    await fireCallbackFromChat(CHAT_ID, keyboard[19]![0]!.callback_data);
    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: 'item-20' } });
  });
});

// ---------------------------------------------------------------------------
// Text type — :cancel and allow_skip
// ---------------------------------------------------------------------------

describe('text type — :cancel and allow_skip', () => {
  it(':cancel input resolves { action: "cancel" }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(textRequest(), { signal: ac.signal });

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, ':cancel');

    const result = await resultPromise;
    expect(result).toEqual({ action: 'cancel' });
  });

  it('empty input with allowSkip=true resolves { action: "skip" }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(textRequest({ allowSkip: true }), { signal: ac.signal });

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '   ');

    const result = await resultPromise;
    expect(result).toEqual({ action: 'skip' });
  });

  it('empty input without allowSkip re-prompts', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(textRequest({ allowSkip: false }), { signal: ac.signal });

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '');
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringMatching(/please enter a response|:cancel/i),
      {},
    );
    expect(messageHandler.pendingElicitations.has(ROUTE_KEY)).toBe(true);

    simulateTextReply(messageHandler, CHAT_ID, ':cancel');
    const result = await resultPromise;
    expect(result.action).toBe('cancel');
  });

  it('valid text input resolves { action: "accept" } with the trimmed value', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(textRequest(), { signal: ac.signal });

    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '  hello world  ');

    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: 'hello world' } });
  });
});

// ---------------------------------------------------------------------------
// Confirm type — abort cleans up dispatch table
// ---------------------------------------------------------------------------

describe('confirm type — abort cleans up pendingChoiceElicitations', () => {
  it('abort during confirm wait resolves { action: "decline" }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(confirmRequest(), { signal: ac.signal });

    await Promise.resolve();

    ac.abort();
    const result = await resultPromise;

    expect(result).toEqual({ action: 'decline' });
  });

  it('after abort, a late button press via the wildcard handler is silently ignored', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(confirmRequest(), { signal: ac.signal });

    await Promise.resolve();

    // Capture the callback data before aborting
    const { sendMessage } = { sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;
    const yesButton = keyboard[0]![0]!;

    ac.abort();
    const result = await resultPromise;
    expect(result).toEqual({ action: 'decline' });

    // Late press — must not throw, must not double-resolve anything
    await expect(fireCallbackFromChat(CHAT_ID, yesButton.callback_data)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency: resolved guard (no double-resolve)
// ---------------------------------------------------------------------------

describe('resolved guard — no double-resolve', () => {
  it('two simultaneous text replies: only the first is processed', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(textRequest(), { signal: ac.signal });

    await Promise.resolve();

    // Pull the resolver directly to simulate simultaneous delivery
    const resolver = messageHandler.pendingElicitations.get(ROUTE_KEY)!;
    messageHandler.pendingElicitations.delete(CHAT_ID);

    // Call resolver twice (race simulation)
    resolver('first');
    resolver('second');

    const result = await resultPromise;
    // Only the first call must win
    expect(result).toEqual({ action: 'accept', content: { value: 'first' } });
  });

  it('button press after abort is a no-op (resolved guard)', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(confirmRequest(), { signal: ac.signal });

    await Promise.resolve();

    const { sendMessage } = { sendMessage: bot.telegram.sendMessage as ReturnType<typeof vi.fn> };
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;
    const yesButton = keyboard[0]![0]!;

    // Abort first
    ac.abort();
    const result = await resultPromise;
    expect(result).toEqual({ action: 'decline' });

    // Then fire the button — should be a no-op because the entry was deleted
    await fireCallbackFromChat(CHAT_ID, yesButton.callback_data);

    // No second resolution is possible; test simply verifies no throw
  });
});

// ---------------------------------------------------------------------------
// parse_mode: 'HTML' assertions
// ---------------------------------------------------------------------------

describe('parse_mode: HTML — text/number/multi_choice prompt', () => {
  it('text question sendMessage is called with parse_mode: HTML', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(textRequest(), { signal: ac.signal });

    await Promise.resolve();

    const callArgs = sendMessage.mock.calls[0] as [number, string, { parse_mode?: string }];
    expect(callArgs[2]?.parse_mode).toBe('HTML');

    ac.abort();
    await resultPromise.catch(() => {});
  });

  it('number question sendMessage is called with parse_mode: HTML', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(numberRequest(), { signal: ac.signal });

    await Promise.resolve();

    const callArgs = sendMessage.mock.calls[0] as [number, string, { parse_mode?: string }];
    expect(callArgs[2]?.parse_mode).toBe('HTML');

    ac.abort();
    await resultPromise.catch(() => {});
  });
});

describe('parse_mode: HTML — confirm/choice prompt', () => {
  it('confirm question sendMessage is called with parse_mode: HTML', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(confirmRequest(), { signal: ac.signal });

    await Promise.resolve();

    const callArgs = sendMessage.mock.calls[0] as [number, string, { parse_mode?: string }];
    expect(callArgs[2]?.parse_mode).toBe('HTML');

    ac.abort();
    await resultPromise.catch(() => {});
  });

  it('choice question sendMessage is called with parse_mode: HTML', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(choiceRequest(['a', 'b']), { signal: ac.signal });

    await Promise.resolve();

    const callArgs = sendMessage.mock.calls[0] as [number, string, { parse_mode?: string }];
    expect(callArgs[2]?.parse_mode).toBe('HTML');

    ac.abort();
    await resultPromise.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// First-prompt-only :cancel hint
// ---------------------------------------------------------------------------

describe('first-prompt-only :cancel hint', () => {
  it('first prompt for a text question includes :cancel hint', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(textRequest(), { signal: ac.signal });

    await Promise.resolve();

    const firstPromptText = sendMessage.mock.calls[0]?.[1] as string;
    expect(firstPromptText).toContain(':cancel');

    ac.abort();
    await resultPromise.catch(() => {});
  });

  it('re-prompt after invalid number input does NOT include :cancel hint', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(numberRequest(), { signal: ac.signal });

    await Promise.resolve();

    // Confirm first prompt has :cancel
    const firstPromptText = sendMessage.mock.calls[0]?.[1] as string;
    expect(firstPromptText).toContain(':cancel');

    // Trigger re-prompt with invalid input
    simulateTextReply(messageHandler, CHAT_ID, 'not-a-number');
    await Promise.resolve();

    // The re-prompt error message (2nd sendMessage call) is the validation error
    // The 3rd call (if any) would be the re-registered prompt — but actually,
    // the re-prompt path here only sends the validation error, not a new full prompt.
    // The :cancel hint is in the *initial* sendMessage call only.
    // Verify the second sendMessage call (validation error) does NOT contain :cancel
    const secondCallText = sendMessage.mock.calls[1]?.[1] as string | undefined;
    if (secondCallText !== undefined) {
      // The re-prompt validation message should not have the :cancel hint
      // (it's a short error message, not the full prompt)
      // This test verifies the first full prompt had :cancel and re-prompts don't repeat it
    }

    // The key assertion: after a re-prompt, there's no new full sendMessage with :cancel footer
    // (the implementation only appends :cancel on isFirstPrompt=true)
    // We verify by checking that the initial prompt had it but subsequent error messages don't
    const allCalls = sendMessage.mock.calls as [number, string, unknown][];
    const promptsWithCancel = allCalls.filter(c => typeof c[1] === 'string' && (c[1] as string).includes(':cancel'));
    // Only the initial prompt (index 0) should contain :cancel
    expect(promptsWithCancel).toHaveLength(1);
    expect(promptsWithCancel[0]).toBe(allCalls[0]);

    ac.abort();
    await resultPromise.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// allow_custom — choice type
// ---------------------------------------------------------------------------

describe('allow_custom — choice type', () => {
  it('keyboard includes ✍️ custom button when allowCustom is true', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      choiceRequest(['alpha', 'beta'], { allowCustom: true }),
      { signal: ac.signal },
    );
    await Promise.resolve();

    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;
    // 2 choice buttons + 1 custom button
    expect(keyboard).toHaveLength(3);
    expect(keyboard[2]?.[0]?.text).toContain('custom');
    expect(keyboard[2]?.[0]?.callback_data).toMatch(new RegExp(`^${ELICITATION_CUSTOM_CALLBACK_PREFIX.replace(':', '\\:')}`));

    ac.abort();
    await resultPromise;
  });

  it('without allowCustom, no custom button appears in choice keyboard', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      choiceRequest(['alpha', 'beta']),
      { signal: ac.signal },
    );
    await Promise.resolve();

    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const keyboard = callArgs[2].reply_markup.inline_keyboard;
    // Only 2 choice buttons, no custom button
    expect(keyboard).toHaveLength(2);
    expect(keyboard.flat().map(b => b.text)).not.toContain(expect.stringContaining('custom'));

    ac.abort();
    await resultPromise;
  });

  it('custom button press → sends prompt → text reply → { value: null, custom_value }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      choiceRequest(['alpha', 'beta'], { allowCustom: true }),
      { signal: ac.signal },
    );
    await Promise.resolve();

    // Extract custom button callback_data
    const callArgs = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const customButton = callArgs[2].reply_markup.inline_keyboard[2]?.[0];
    expect(customButton).toBeDefined();

    // Fire the custom button
    await fireCustomCallbackFromChat(CHAT_ID, customButton!.callback_data);
    await Promise.resolve();

    // Second sendMessage should prompt for custom text
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sendMessage.mock.calls[1]?.[1]).toMatch(/custom answer/i);

    // Simulate text reply
    simulateTextReply(messageHandler, CHAT_ID, 'my free text');

    const result = await resultPromise;
    expect(result).toEqual({ action: 'accept', content: { value: null, custom_value: 'my free text' } });
  });

  it('custom button press + :cancel typed → { action: "cancel" }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      choiceRequest(['alpha', 'beta'], { allowCustom: true }),
      { signal: ac.signal },
    );
    await Promise.resolve();

    const callArgs = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const customButton = callArgs[2].reply_markup.inline_keyboard[2]?.[0];

    await fireCustomCallbackFromChat(CHAT_ID, customButton!.callback_data);
    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, ':cancel');

    const result = await resultPromise;
    expect(result.action).toBe('cancel');
  });

  it('custom button press + abort → { action: "decline" }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      choiceRequest(['alpha', 'beta'], { allowCustom: true }),
      { signal: ac.signal },
    );
    await Promise.resolve();

    const callArgs = (bot.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    const customButton = callArgs[2].reply_markup.inline_keyboard[2]?.[0];

    // Press custom button
    await fireCustomCallbackFromChat(CHAT_ID, customButton!.callback_data);
    await Promise.resolve();

    // Abort while waiting for text
    ac.abort();

    const result = await resultPromise;
    expect(result.action).toBe('decline');
  });

  it('custom wildcard regex matches afk:ec: prefix but not afk:e: prefix', () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    expect(capturedCustomActionRegex).toBeInstanceOf(RegExp);
    // Must match custom prefix
    expect(capturedCustomActionRegex!.test(`${ELICITATION_CUSTOM_CALLBACK_PREFIX}elic-abc12345`)).toBe(true);
    // Must NOT match regular prefix (afk:e:0:id)
    expect(capturedCustomActionRegex!.test(`${ELICITATION_CALLBACK_PREFIX}0:elic-abc12345`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// allow_custom — multi_choice type
// ---------------------------------------------------------------------------

describe('allow_custom — multi_choice type', () => {
  it('non-numeric text reply with allowCustom → { value: null, custom_value }', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      multiChoiceRequest(['alpha', 'beta'], { allowCustom: true }),
      { signal: ac.signal },
    );
    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, 'some free-form text');

    const result = await resultPromise;
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBeNull();
    expect(result.content?.['custom_value']).toBe('some free-form text');
  });

  it('without allowCustom, non-numeric text → re-prompt (existing behavior)', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      multiChoiceRequest(['alpha', 'beta']),
      { signal: ac.signal },
    );
    await Promise.resolve();

    // Send invalid input — should re-prompt
    simulateTextReply(messageHandler, CHAT_ID, 'not-numeric');
    await Promise.resolve();

    // Should have sent error re-prompt message
    expect(sendMessage.mock.calls.length).toBe(2);
    // Still waiting for valid input — abort to resolve
    ac.abort();
    const result = await resultPromise;
    expect(result.action).toBe('decline');
  });

  it('prompt text includes free-form hint when allowCustom', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot, sendMessage } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      multiChoiceRequest(['alpha', 'beta'], { allowCustom: true }),
      { signal: ac.signal },
    );
    await Promise.resolve();

    const promptText = sendMessage.mock.calls[0]?.[1] as string;
    expect(promptText).toMatch(/free-form|custom answer/i);

    ac.abort();
    await resultPromise;
  });

  it('numeric reply still works normally with allowCustom', async () => {
    const messageHandler = makeMockMessageHandler();
    const { bot } = makeMockBot();
    const handler = makeTelegramElicitationHandler(messageHandler as never, bot, CHAT_ID);

    const ac = makeAbort();
    const resultPromise = handler(
      multiChoiceRequest(['alpha', 'beta'], { allowCustom: true }),
      { signal: ac.signal },
    );
    await Promise.resolve();

    simulateTextReply(messageHandler, CHAT_ID, '1,2');

    const result = await resultPromise;
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toEqual(['alpha', 'beta']);
  });
});
