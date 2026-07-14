/**
 * Tests for Telegram session watching (/watch, /unwatch).
 *
 * Uses a temp AFK_HOME so ledgers and session sidecars live in a temp dir
 * (env must be set before importing modules that resolve paths).
 */

import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-watch-test-'));
process.env['AFK_HOME'] = tmpDir;

import { SessionWatchManager, renderLedgerRecord, resolveWatchTarget } from './watch.js';
import { SessionLedgerWriter, type LedgerRecord } from '../agent/session-ledger.js';
import { getSessionsDir } from '../paths.js';
import {
  ensureSessionKey,
  readSessionKey,
  signAbortRequest,
  verifyAbortRequest,
  verifyElicitationResponse,
  freshChannelId,
} from '../agent/afk-channel.js';
import type { ElicitationResult } from '../agent/types/sdk-types.js';
import type { MessageHandler } from './handlers/message.js';

let seq = 0;
function freshId(): string {
  return `watch-test-${Date.now()}-${seq++}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rec(payload: Omit<LedgerRecord, 'v' | 'ts'>): LedgerRecord {
  return { v: 1, ts: 1718000000000, ...payload } as LedgerRecord;
}

// ---------------------------------------------------------------------------
// renderLedgerRecord
// ---------------------------------------------------------------------------

describe('renderLedgerRecord', () => {
  it('renders each record kind compactly', () => {
    expect(renderLedgerRecord(rec({ kind: 'meta', sessionId: 's1', model: 'sonnet', cwd: '/x' })))
      .toContain('s1');
    expect(renderLedgerRecord(rec({ kind: 'user', text: 'hi there' }))).toBe('👤 hi there');
    expect(renderLedgerRecord(rec({ kind: 'assistant', text: 'sure' }))).toBe('🤖 sure');
    expect(renderLedgerRecord(rec({ kind: 'tool', toolName: 'bash', input: 'ls' }))).toBe('🔧 bash(ls)');
    expect(renderLedgerRecord(rec({ kind: 'tool_error', content: 'ENOENT' }))).toContain('ENOENT');
    expect(renderLedgerRecord(rec({ kind: 'done', costUsd: 0.01, durationMs: 1500 })))
      .toBe('✅ turn done (1.5s, $0.0100)');
    expect(renderLedgerRecord(rec({ kind: 'done' }))).toBe('✅ turn done');
    expect(renderLedgerRecord(rec({ kind: 'error', message: 'boom' }))).toContain('boom');
    expect(renderLedgerRecord(rec({ kind: 'paused' }))).toContain('paused');
    expect(renderLedgerRecord(rec({ kind: 'resumed' }))).toBe('▶️ resumed');
    expect(renderLedgerRecord(rec({ kind: 'closed', reason: 'close' }))).toContain('closed');
  });

  it('collapses whitespace and clips long text', () => {
    const text = `line1\nline2\t${'x'.repeat(2000)}`;
    const rendered = renderLedgerRecord(rec({ kind: 'assistant', text }));
    expect(rendered).not.toContain('\n');
    expect(rendered!.length).toBeLessThan(800);
    expect(rendered).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// resolveWatchTarget
// ---------------------------------------------------------------------------

describe('resolveWatchTarget', () => {
  it('resolves a raw session id that has a ledger', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('x');
    await writer.close();
    expect(await resolveWatchTarget(id)).toBe(id);
  });

  it('resolves a session-store name to its SDK session id', async () => {
    const sdkId = freshId();
    const writer = new SessionLedgerWriter(sdkId);
    writer.recordUser('x');
    await writer.close();

    // Write a session-store sidecar pointing at the SDK id.
    const sidecar = {
      sessionId: sdkId,
      name: 'my-named-session',
      model: 'sonnet',
      startedAt: Date.now(),
      savedAt: Date.now(),
      totalTurns: 1,
      totalCostUsd: 0,
      totalTokens: { input: 0, output: 0 },
      totalDurationMs: 0,
      turns: [],
    };
    fs.mkdirSync(getSessionsDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getSessionsDir(), `${sdkId}.json`),
      JSON.stringify(sidecar),
    );

    expect(await resolveWatchTarget('my-named-session')).toBe(sdkId);
  });

  it('returns null for unknown targets and traversal attempts', async () => {
    expect(await resolveWatchTarget('definitely-not-a-session')).toBeNull();
    expect(await resolveWatchTarget('../../etc/passwd')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SessionWatchManager
// ---------------------------------------------------------------------------

describe('SessionWatchManager', () => {
  it('streams batched records to the send fn and ends on closed', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('pre');
    await sleep(50);

    const sent: string[] = [];
    const manager = new SessionWatchManager();
    manager.start(7, id, async (text) => {
      sent.push(text);
    });
    expect(manager.watching(7)).toBe(id);

    await sleep(100);
    writer.recordUser('hello from CLI');
    writer.recordEvent({
      type: 'message',
      message: { role: 'assistant', content: 'on it', timestamp: new Date() },
    });
    await sleep(300);
    await writer.close('close');
    await sleep(600);

    const all = sent.join('\n');
    expect(all).toContain('👤 hello from CLI');
    expect(all).toContain('🤖 on it');
    expect(all).toContain('watch ended');
    // Watch ended → registry cleaned up.
    expect(manager.watching(7)).toBeUndefined();
    // Batching: the user+assistant records (written within one debounce
    // window) must arrive in a single message, not one send per record.
    expect(sent.some((m) => m.includes('hello from CLI') && m.includes('on it'))).toBe(true);
  });

  it('stop aborts the tail and reports the watched id', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('x');
    await sleep(50);

    const manager = new SessionWatchManager();
    manager.start(9, id, async () => {});
    expect(manager.stop(9)).toBe(id);
    expect(manager.watching(9)).toBeUndefined();
    expect(manager.stop(9)).toBeUndefined();
    await writer.close();
  });

  it('starting a new watch replaces the previous one', async () => {
    const idA = freshId();
    const idB = freshId();
    const wA = new SessionLedgerWriter(idA);
    const wB = new SessionLedgerWriter(idB);
    wA.recordUser('a');
    wB.recordUser('b');
    await sleep(50);

    const manager = new SessionWatchManager();
    manager.start(11, idA, async () => {});
    manager.start(11, idB, async () => {});
    expect(manager.watching(11)).toBe(idB);
    await manager.stopAll();
    expect(manager.watching(11)).toBeUndefined();
    await wA.close();
    await wB.close();
  });

  it('send failures do not kill the watch', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('x');
    await sleep(50);

    const sent: string[] = [];
    let failNext = true;
    const manager = new SessionWatchManager();
    manager.start(13, id, async (text) => {
      if (failNext) {
        failNext = false;
        throw new Error('telegram 429');
      }
      sent.push(text);
    });

    await sleep(100);
    writer.recordUser('first-batch');
    // Wait past the debounce window so the first batch flushes (and throws)
    // before the second batch is written.
    await sleep(1_800);
    writer.recordUser('second-batch');
    await sleep(300);
    await writer.close('close');
    await sleep(600);

    // First batch send threw; later batches must still be delivered.
    expect(sent.join('\n')).toContain('second-batch');
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: elicitation intercept + signed write-back (C1+C2)
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub of the Telegraf bot + MessageHandler sufficient for the
 * elicitation path in _run. The bot stub only needs sendMessage (for the text
 * prompt) and action registration (no-op here). The MessageHandler stub only
 * needs pendingElicitations and ledgerOriginatedPendingChats maps plus enough
 * surface for makeTelegramElicitationHandler to function.
 */
function makeElicitStubs(chatId: number) {
  // Track the pending resolver installed by the elicitation handler.
  const pendingElicitations = new Map<number, (text: string) => void>();
  const ledgerOriginatedPendingChats = new Set<number>();

  const sentMessages: string[] = [];
  const bot = {
    action: vi.fn(),
    telegram: {
      sendMessage: vi.fn().mockImplementation((_chatId: number, text: string) => {
        sentMessages.push(text);
        return Promise.resolve({ message_id: 1 });
      }),
    },
  };

  // A minimal MessageHandler-shaped object. We only need the two maps.
  const messageHandler = {
    pendingElicitations,
    ledgerOriginatedPendingChats,
  } as unknown as MessageHandler;

  return { bot, messageHandler, sentMessages, pendingElicitations, ledgerOriginatedPendingChats, chatId };
}

describe('SessionWatchManager — elicitation intercept + signed write-back (criterion 3)', () => {
  it('intercepts an elicitation record, renders via telegram handler, writes back a HMAC-signed response', async () => {
    const id = freshId();
    const chatId = 42;

    // Write the REPL-side session key (normally written by /afk on).
    const key = ensureSessionKey(id);
    expect(key).toBeTruthy();

    const { bot, messageHandler, pendingElicitations } = makeElicitStubs(chatId);

    const writer = new SessionLedgerWriter(id);
    writer.recordUser('setup');
    await sleep(50);

    const sent: string[] = [];
    const manager = new SessionWatchManager(
      () => {},
      bot as unknown as import('telegraf').Telegraf,
      messageHandler,
    );
    manager.start(chatId, id, async (text) => { sent.push(text); });

    await sleep(100);

    // Write an elicitation record into the ledger (as the REPL would).
    const reqId = 'req-123';
    writer.record({
      kind: 'elicitation',
      reqId,
      request: { type: 'text', message: 'What is your name?' },
    });

    // Give the tail loop time to process the record and install the interceptor.
    await sleep(200);

    // Simulate the operator typing an answer into Telegram (the message handler
    // fires the resolver, which is what handle() would do when it sees a text).
    const resolver = pendingElicitations.get(chatId);
    expect(resolver).toBeDefined();
    resolver!('Alice');

    // Give _run time to receive the result and write back the response.
    await sleep(200);

    // The elicitation_response record must be in the ledger and HMAC-verified.
    const ledgerPath = path.join(
      tmpDir, 'state', 'sessions', id, 'events.jsonl',
    );
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
    const responseRecord = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((r) => r?.kind === 'elicitation_response');

    expect(responseRecord).toBeDefined();
    expect(responseRecord.reqId).toBe(reqId);
    const result: ElicitationResult = responseRecord.result;
    expect(result.action).toBe('accept');

    // Verify the HMAC using the real verifyElicitationResponse.
    const readKey = readSessionKey(id);
    expect(readKey).toBeTruthy();
    const valid = verifyElicitationResponse(readKey!, id, reqId, result, responseRecord.hmac);
    expect(valid).toBe(true);

    await writer.close();
    manager.stop(chatId);
  });

  it('skips the write-back when no session key is present', async () => {
    const id = freshId();
    const chatId = 43;
    // Deliberately do NOT call ensureSessionKey — no key on disk.

    const { bot, messageHandler, pendingElicitations } = makeElicitStubs(chatId);

    const writer = new SessionLedgerWriter(id);
    writer.recordUser('setup');
    await sleep(50);

    const manager = new SessionWatchManager(
      () => {},
      bot as unknown as import('telegraf').Telegraf,
      messageHandler,
    );
    manager.start(chatId, id, async () => {});

    await sleep(100);

    writer.record({
      kind: 'elicitation',
      reqId: 'req-no-key',
      request: { type: 'text', message: 'Skip?' },
    });

    await sleep(200);

    // Answer the pending resolver.
    const resolver = pendingElicitations.get(chatId);
    expect(resolver).toBeDefined();
    resolver!('any answer');

    await sleep(200);

    // No elicitation_response should be in the ledger.
    const ledgerPath = path.join(tmpDir, 'state', 'sessions', id, 'events.jsonl');
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
    const responseRecord = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((r) => r?.kind === 'elicitation_response');

    expect(responseRecord).toBeUndefined();

    await writer.close();
    manager.stop(chatId);
  });

  it('still relays normal (non-elicitation) records as push lines', async () => {
    const id = freshId();
    const chatId = 44;

    const { bot, messageHandler } = makeElicitStubs(chatId);

    const writer = new SessionLedgerWriter(id);
    writer.recordUser('hello');
    await sleep(50);

    const sent: string[] = [];
    const manager = new SessionWatchManager(
      () => {},
      bot as unknown as import('telegraf').Telegraf,
      messageHandler,
    );
    manager.start(chatId, id, async (text) => { sent.push(text); });

    await sleep(100);
    writer.recordUser('normal record');
    await sleep(300);
    await writer.close();
    await sleep(600);

    expect(sent.join('\n')).toContain('normal record');

    manager.stop(chatId);
  });

  it('renderLedgerRecord returns null for elicitation kinds (no push line)', () => {
    expect(renderLedgerRecord(rec({
      kind: 'elicitation',
      reqId: 'r1',
      request: { type: 'text', message: 'Q?' },
    }))).toBeNull();
    expect(renderLedgerRecord(rec({
      kind: 'elicitation_response',
      reqId: 'r1',
      result: { action: 'accept', content: { value: 'A' } },
      hmac: 'abc',
    }))).toBeNull();
    expect(renderLedgerRecord(rec({
      kind: 'abort_request',
      nonce: 'n1',
      hmac: 'abc',
    }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F1 regression: high-risk approval FORM must render as buttons over the relay
// ---------------------------------------------------------------------------

/**
 * Like makeElicitStubs, but also captures sendMessage OPTIONS (reply_markup) and
 * the bot.action registrations, so a form-mode elicitation's inline keyboard and
 * its button-tap round-trip can be asserted.
 *
 * Regression guard: the ledger relay (watch.ts) once installed the ask-ONLY
 * handler. An untyped `mode:'form'` request (what afk-mode-gate.buildApprovalRequest
 * emits) then defaulted to a plain text prompt (NO buttons) and returned
 * content.value, which the afk-mode-gate consumer (reads content.choice) rejected
 * as 'unrecognised' — so an away operator could not approve a high-risk op from
 * Telegram. The relay must install the COMPOSED handler (like bot.ts) so form
 * requests render via the afk:pa: enum keyboard and return content.choice.
 */
function makeFormElicitStubs(chatId: number) {
  const pendingElicitations = new Map<number, (text: string) => void>();
  const ledgerOriginatedPendingChats = new Set<number>();
  const sent: Array<{ text: string; options?: { reply_markup?: unknown } }> = [];
  const actions: Array<{ matcher: unknown; handler: (ctx: unknown) => unknown }> = [];
  const bot = {
    action: vi.fn().mockImplementation((matcher: unknown, handler: (ctx: unknown) => unknown) => {
      actions.push({ matcher, handler });
    }),
    telegram: {
      sendMessage: vi.fn().mockImplementation(
        (_chatId: number, text: string, options?: { reply_markup?: unknown }) => {
          sent.push({ text, options });
          return Promise.resolve({ message_id: sent.length });
        },
      ),
    },
  };
  const messageHandler = {
    pendingElicitations,
    ledgerOriginatedPendingChats,
  } as unknown as MessageHandler;
  return { bot, messageHandler, sent, actions, chatId };
}

interface InlineButton { text: string; callback_data: string }

describe('SessionWatchManager — F1 regression: form-mode approval renders buttons', () => {
  it('renders a mode:form approval as an inline keyboard and writes back content.choice', async () => {
    const id = freshId();
    const chatId = 77;
    const key = ensureSessionKey(id);
    expect(key).toBeTruthy();

    const { bot, messageHandler, sent, actions } = makeFormElicitStubs(chatId);

    const writer = new SessionLedgerWriter(id);
    writer.recordUser('setup');
    await sleep(50);

    const manager = new SessionWatchManager(
      () => {},
      bot as unknown as import('telegraf').Telegraf,
      messageHandler,
    );
    manager.start(chatId, id, async () => {});
    await sleep(100);

    // The exact shape afk-mode-gate.buildApprovalRequest emits: mode:'form',
    // enum approve/deny, NO `type`.
    const reqId = freshChannelId();
    writer.record({
      kind: 'elicitation',
      reqId,
      request: {
        serverName: 'agent-afk',
        message: 'AFK: `bash` is high-risk / irreversible. Approve this single call?',
        mode: 'form',
        title: 'AFK high-risk approval',
        requestedSchema: {
          type: 'object',
          properties: {
            choice: { type: 'string', title: 'Approve?', enum: ['approve', 'deny'] },
          },
          required: ['choice'],
        },
      },
    });

    await sleep(250);

    // ASSERTION 1: the prompt rendered with an inline keyboard whose buttons carry
    // afk:pa: callback_data. The ask-only handler would send a plain text prompt
    // with NO reply_markup — this find() would be undefined and the test fails.
    const formMsg = sent.find((m) => m.options?.reply_markup !== undefined);
    expect(formMsg, 'form-mode approval must render with an inline keyboard (buttons)').toBeDefined();
    const keyboard = (formMsg!.options!.reply_markup as { inline_keyboard: InlineButton[][] }).inline_keyboard;
    const buttons = keyboard.flat();
    const approveBtn = buttons.find((b) => b.callback_data.endsWith(':approve'));
    expect(approveBtn, 'must offer an Approve button').toBeDefined();
    expect(approveBtn!.callback_data.startsWith('afk:pa:')).toBe(true);

    // Simulate the operator tapping "Approve": invoke the afk:pa: action handler.
    const paAction = actions.find(
      (a) => a.matcher instanceof RegExp && (a.matcher as RegExp).test('afk:pa:x:approve'),
    );
    expect(paAction, 'the afk:pa: action handler must be registered').toBeDefined();
    const answerCbQuery = vi.fn().mockResolvedValue(undefined);
    await paAction!.handler({ callbackQuery: { data: approveBtn!.callback_data }, answerCbQuery });

    await sleep(200);

    // ASSERTION 2: the written-back response carries content.choice (what
    // afk-mode-gate reads) — NOT content.value. Under the ask-only handler this
    // would be content.value and the gate would refuse the op.
    const ledgerPath = path.join(tmpDir, 'state', 'sessions', id, 'events.jsonl');
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
    const responseRecord = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((r) => r?.kind === 'elicitation_response');
    expect(responseRecord).toBeDefined();
    expect(responseRecord.reqId).toBe(reqId);
    const result: ElicitationResult = responseRecord.result;
    expect(result.action).toBe('accept');
    expect((result.content as { choice?: string } | undefined)?.choice).toBe('approve');

    // HMAC verifies with the real verifier.
    const readKey = readSessionKey(id);
    expect(readKey).toBeTruthy();
    const valid = verifyElicitationResponse(readKey!, id, reqId, result, responseRecord.hmac);
    expect(valid).toBe(true);

    await writer.close();
    manager.stop(chatId);
  });
});

// ---------------------------------------------------------------------------
// Keep-alive: heartbeat for a pending elicitation (answer-whenever, no cutoff)
// ---------------------------------------------------------------------------

describe('SessionWatchManager — keep-alive heartbeat for a pending elicitation', () => {
  it('re-nudges (capped) while pending without cutting off the wait, and stops after the answer', async () => {
    const id = freshId();
    const chatId = 88;
    ensureSessionKey(id);

    const { bot, messageHandler, pendingElicitations } = makeElicitStubs(chatId);

    const writer = new SessionLedgerWriter(id);
    writer.recordUser('setup');
    await sleep(50);

    const sent: string[] = [];
    // Tiny heartbeat interval (25ms) so the test doesn't wait 15 minutes.
    const manager = new SessionWatchManager(
      () => {},
      bot as unknown as import('telegraf').Telegraf,
      messageHandler,
      25,
    );
    manager.start(chatId, id, async (text) => { sent.push(text); });
    await sleep(100);

    writer.record({
      kind: 'elicitation',
      reqId: 'req-hb',
      request: { type: 'text', message: 'name?' },
    });

    // Wait through many heartbeat intervals WITHOUT answering.
    await sleep(400);
    const nudges = () => sent.filter((t) => /still waiting/i.test(t)).length;
    // Fired at least once, but capped (MAX_ELICIT_NUDGES = 4) — never spams forever ...
    expect(nudges()).toBeGreaterThanOrEqual(1);
    expect(nudges()).toBeLessThanOrEqual(4);
    // ... and the wait is STILL open — answer whenever (resolver live, NOT cut off).
    const resolver = pendingElicitations.get(chatId);
    expect(resolver).toBeDefined();

    // Answer → the wait resolves, the heartbeat is cleared, nudges stop.
    const beforeAnswer = nudges();
    resolver!('Alice');
    await sleep(150);
    expect(nudges()).toBe(beforeAnswer);

    await writer.close();
    manager.stop(chatId);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: getWatched() getter + daemon abort-record signing
// ---------------------------------------------------------------------------

describe('SessionWatchManager — getWatched (criterion 4)', () => {
  it('getWatched returns the watched session id and undefined when not watching', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('x');
    await sleep(50);

    const manager = new SessionWatchManager();
    expect(manager.getWatched(20)).toBeUndefined();

    manager.start(20, id, async () => {});
    expect(manager.getWatched(20)).toBe(id);

    manager.stop(20);
    expect(manager.getWatched(20)).toBeUndefined();

    await writer.close();
  });
});

describe('Criterion 4: daemon /abort writes a HMAC-signed abort_request', () => {
  it('a signed abort_request written like the daemon /abort handler does verifies correctly', () => {
    // This test simulates what bot.ts /abort does: read the key, sign, and write.
    // Verifying the record with the real verifyAbortRequest confirms the
    // REPL abort-watcher would accept it (Invariant #4).
    const id = freshId();
    const key = ensureSessionKey(id)!;
    expect(key).toBeTruthy();

    // Simulate the /abort command path: sign a nonce exactly as bot.ts does.
    const nonce = freshChannelId();
    const hmac = signAbortRequest(key, id, nonce);

    // The record is what SessionLedgerWriter.record() would emit.
    const record = { kind: 'abort_request' as const, nonce, hmac };

    // The REPL abort-watcher calls verifyAbortRequest before acting.
    const valid = verifyAbortRequest(key, id, record.nonce, record.hmac);
    expect(valid).toBe(true);
  });

  it('an abort_request with a forged HMAC does NOT verify (REPL would ignore it)', () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const nonce = freshChannelId();
    // Daemon signs with a DIFFERENT key (simulating a cross-session stray write).
    const wrongKey = ensureSessionKey(freshId())!;
    const forgedHmac = signAbortRequest(wrongKey, id, nonce);

    const valid = verifyAbortRequest(key, id, nonce, forgedHmac);
    expect(valid).toBe(false);
  });
});
