/**
 * Tests for the Telegram-backed elicitation handler — inline-keyboard
 * prompt for path-approval + MCP elicitations.
 *
 * Covers:
 *   - Sends the message + inline keyboard to every allowlisted chat.
 *   - Callback resolves the pending promise with the chosen enum value.
 *   - Out-of-band (stale ULID) callbacks ack with "no longer active" and do
 *     NOT resolve any pending promise.
 *   - Unknown choice → answerCbQuery says so + does not resolve.
 *   - Abort signal aborts the pending promise as decline.
 *   - Form-mode requests with a 4-value enum render as 2×2 keyboard.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  createTelegramElicitationHandler,
  composeTelegramElicitation,
  _resetPendingForTests,
  ELICITATION_CALLBACK_PREFIX,
} from './elicitation-telegram.js';
import { ELICITATION_CALLBACK_PREFIX as ASK_QUESTION_PREFIX } from './elicitation-callback-data.js';
import type { ElicitationHandler } from '../agent/elicitation-router.js';
import type { ElicitationRequest, ElicitationResult } from '../agent/types/sdk-types.js';

interface SentMessage {
  chatId: number;
  text: string;
  reply_markup?: unknown;
}

function makeStubBot(): {
  bot: any;
  sent: SentMessage[];
  actionRegex?: RegExp;
  actionHandler?: (ctx: any) => Promise<void>;
} {
  const sent: SentMessage[] = [];
  let actionRegex: RegExp | undefined;
  let actionHandler: ((ctx: any) => Promise<void>) | undefined;
  const bot: any = {
    telegram: {
      sendMessage: async (chatId: number, text: string, opts: Record<string, unknown>) => {
        sent.push({ chatId, text, reply_markup: opts['reply_markup'] });
      },
    },
    action: (re: RegExp, handler: (ctx: any) => Promise<void>) => {
      actionRegex = re;
      actionHandler = handler;
    },
  };
  return {
    bot,
    sent,
    get actionRegex() { return actionRegex; },
    get actionHandler() { return actionHandler; },
  } as any;
}

function pathApprovalRequest(): ElicitationRequest {
  return {
    serverName: 'agent-afk',
    message: 'Tool `read_file` wants to read /etc/hosts',
    mode: 'form',
    title: 'Path access approval',
    requestedSchema: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          enum: ['once', 'session', 'persist', 'deny'],
        },
      },
      required: ['choice'],
    },
  };
}

beforeEach(() => {
  _resetPendingForTests();
});

describe('createTelegramElicitationHandler — broadcast', () => {
  it('sends one message per allowlisted chat with a 2x2 keyboard for 4-enum', async () => {
    const stub = makeStubBot();
    const handler = createTelegramElicitationHandler(stub.bot, new Set([111, 222]));
    const controller = new AbortController();

    const p = handler(pathApprovalRequest(), { signal: controller.signal });

    // Give the microtask queue a chance to fire the broadcast.
    await new Promise((r) => setImmediate(r));

    expect(stub.sent).toHaveLength(2);
    expect(stub.sent.map((m) => m.chatId).sort()).toEqual([111, 222]);

    // 2x2 inline keyboard.
    const markup = stub.sent[0]?.reply_markup as
      | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
      | undefined;
    expect(markup?.inline_keyboard).toHaveLength(2);
    expect(markup?.inline_keyboard[0]).toHaveLength(2);
    expect(markup?.inline_keyboard[1]).toHaveLength(2);

    // Buttons reference the path-approval enum values.
    const callbacks = markup?.inline_keyboard.flat().map((b) => b.callback_data) ?? [];
    expect(callbacks.every((c) => c.startsWith(ELICITATION_CALLBACK_PREFIX))).toBe(true);
    expect(callbacks.some((c) => c.endsWith(':once'))).toBe(true);
    expect(callbacks.some((c) => c.endsWith(':session'))).toBe(true);
    expect(callbacks.some((c) => c.endsWith(':persist'))).toBe(true);
    expect(callbacks.some((c) => c.endsWith(':deny'))).toBe(true);

    // Abort to GC the pending entry so the test doesn't leak.
    controller.abort();
    await p;
  });
});

describe('createTelegramElicitationHandler — callback resolution', () => {
  it('callback resolves the promise with the chosen enum value', async () => {
    const stub = makeStubBot();
    const handler = createTelegramElicitationHandler(stub.bot, new Set([111]));
    const controller = new AbortController();

    const promise = handler(pathApprovalRequest(), { signal: controller.signal });
    await new Promise((r) => setImmediate(r));

    // Extract the ULID from the first button's callback_data.
    const markup = stub.sent[0]?.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const sampleCb = markup.inline_keyboard[0]?.[0]?.callback_data;
    expect(sampleCb).toBeDefined();
    const ulid = sampleCb!.slice(ELICITATION_CALLBACK_PREFIX.length).split(':')[0]!;

    // Fire the simulated tap.
    const answerCbQuery = vi.fn(async () => {});
    await stub.actionHandler?.({
      callbackQuery: { data: `${ELICITATION_CALLBACK_PREFIX}${ulid}:session` },
      answerCbQuery,
    });

    const result = await promise;
    expect(result.action).toBe('accept');
    expect(result.content?.['choice']).toBe('session');
    expect(answerCbQuery).toHaveBeenCalled();
  });

  it('stale ULID callback does not resolve any pending promise', async () => {
    const stub = makeStubBot();
    createTelegramElicitationHandler(stub.bot, new Set([111]));

    const answerCbQuery = vi.fn(async () => {});
    await stub.actionHandler?.({
      callbackQuery: { data: `${ELICITATION_CALLBACK_PREFIX}NONEXISTENT26CHARSULID01234:session` },
      answerCbQuery,
    });

    expect(answerCbQuery).toHaveBeenCalledWith(expect.stringMatching(/no longer active/i));
  });

  it('unknown choice (not in enum) replies with "Unknown choice"', async () => {
    const stub = makeStubBot();
    const handler = createTelegramElicitationHandler(stub.bot, new Set([111]));
    const controller = new AbortController();
    const promise = handler(pathApprovalRequest(), { signal: controller.signal });
    await new Promise((r) => setImmediate(r));

    const markup = stub.sent[0]?.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const ulid = markup.inline_keyboard[0]?.[0]?.callback_data!
      .slice(ELICITATION_CALLBACK_PREFIX.length)
      .split(':')[0]!;

    const answerCbQuery = vi.fn(async () => {});
    await stub.actionHandler?.({
      callbackQuery: { data: `${ELICITATION_CALLBACK_PREFIX}${ulid}:rogue_choice` },
      answerCbQuery,
    });

    expect(answerCbQuery).toHaveBeenCalledWith('Unknown choice');

    // Abort so the test doesn't leak the pending promise.
    controller.abort();
    await promise;
  });
});

describe('createTelegramElicitationHandler — abort path', () => {
  it('abort signal resolves the pending promise as decline', async () => {
    const stub = makeStubBot();
    const handler = createTelegramElicitationHandler(stub.bot, new Set([111]));
    const controller = new AbortController();

    const promise = handler(pathApprovalRequest(), { signal: controller.signal });
    await new Promise((r) => setImmediate(r));

    controller.abort();
    const result = await promise;
    expect(result.action).toBe('decline');
  });

  it('pre-aborted signal returns decline without sending any message', async () => {
    const stub = makeStubBot();
    const handler = createTelegramElicitationHandler(stub.bot, new Set([111]));
    const controller = new AbortController();
    controller.abort();

    const result = await handler(pathApprovalRequest(), { signal: controller.signal });
    expect(result.action).toBe('decline');
    expect(stub.sent).toHaveLength(0);
  });
});

/**
 * Regression for PR #477 review findings B1 + B2: the path-approval and
 * ask_question Telegram elicitation systems must COEXIST.
 *   - B1: composeTelegramElicitation routes BOTH request kinds through one
 *     installed handler, so neither clobbers the other on
 *     elicitationRouter.install (last-wins). Routed by `request.type`:
 *     set → ask_question (old afk:e: handler); absent → form/url (new afk:pa:).
 *   - B2: the two callback prefixes are DISJOINT, so the new handler's
 *     bot.action matcher can never intercept an ask_question button tap.
 */
describe('elicitation coexistence (PR #477 B1/B2)', () => {
  it('B1: composeTelegramElicitation routes ask_question (type set) to the ask handler', async () => {
    const calls: string[] = [];
    const askHandler: ElicitationHandler = async () => {
      calls.push('ask');
      return { action: 'accept', content: { value: 'beta' } } as ElicitationResult;
    };
    const formHandler: ElicitationHandler = async () => {
      calls.push('form');
      return { action: 'accept', content: { choice: 'once' } } as ElicitationResult;
    };
    const composed = composeTelegramElicitation(askHandler, formHandler);

    const req: ElicitationRequest = {
      serverName: 'agent-afk',
      message: 'Pick one',
      type: 'choice',
      choices: ['alpha', 'beta'],
    };
    const result = await composed(req, { signal: new AbortController().signal });
    expect(calls).toEqual(['ask']);
    expect(result.content?.['value']).toBe('beta');
  });

  it('B1: composeTelegramElicitation routes form/path-approval (no type) to the form handler', async () => {
    const calls: string[] = [];
    const askHandler: ElicitationHandler = async () => {
      calls.push('ask');
      return { action: 'accept' } as ElicitationResult;
    };
    const formHandler: ElicitationHandler = async () => {
      calls.push('form');
      return { action: 'accept', content: { choice: 'once' } } as ElicitationResult;
    };
    const composed = composeTelegramElicitation(askHandler, formHandler);

    // Path-approval request: mode 'form', NO `type` field.
    const result = await composed(pathApprovalRequest(), { signal: new AbortController().signal });
    expect(calls).toEqual(['form']);
    expect(result.content?.['choice']).toBe('once');
  });

  it('B2: the two callback prefixes are disjoint (no cross-interception)', () => {
    // The new handler registers bot.action(/^afk:pa:/); the old one registers
    // /^afk:e:\d+:.+$/. A tap on either must match exactly one.
    const askTap = `${ASK_QUESTION_PREFIX}0:elic-deadbeef`; // afk:e:0:...
    const paTap = `${ELICITATION_CALLBACK_PREFIX}01ARZ3NDEKTSV4RRFFQ69G5FAV:once`; // afk:pa:<ulid>:once

    const paMatcher = new RegExp(`^${ELICITATION_CALLBACK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const askMatcher = /^afk:e:\d+:.+$/;

    // New (path-approval) matcher must NOT swallow ask_question taps.
    expect(paMatcher.test(askTap)).toBe(false);
    expect(paMatcher.test(paTap)).toBe(true);
    // Old (ask_question) matcher must NOT swallow path-approval taps.
    expect(askMatcher.test(paTap)).toBe(false);
    expect(askMatcher.test(askTap)).toBe(true);
    // And the constants themselves differ.
    expect(ELICITATION_CALLBACK_PREFIX).not.toBe(ASK_QUESTION_PREFIX);
  });
});
