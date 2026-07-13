/**
 * End-to-end seam test for two-way AFK comms.
 *
 * The component tests cover each end of the cross-process hop in isolation:
 *   - `afk-ledger-channel.test.ts` exercises the REPL side (resolves on a
 *     verified response, ignores forged ones, abort-watcher matrix);
 *   - `watch.test.ts` exercises the daemon side (`_run` intercepts an
 *     elicitation, renders it, and writes back a HMAC-signed response).
 * Both ends meet at the `afk-channel.ts` canonical signing form — but no single
 * test wires the REAL daemon `SessionWatchManager._run` to the REAL REPL
 * `makeLedgerChannelHandler`/`makeAbortWatcher` over one shared ledger + key.
 * This file closes that seam: it proves the full round-trip settles, end to end,
 * with production components on both sides and nothing hand-signed in between.
 *
 * Temp AFK_HOME set before import so no real ~/.afk/state is touched (the ledger
 * path is derived from AFK_HOME at import time).
 */

import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-twoway-e2e-'));
process.env['AFK_HOME'] = tmpDir;

import { SessionWatchManager } from './watch.js';
import { makeLedgerChannelHandler, makeAbortWatcher } from '../agent/afk-ledger-channel.js';
import { SessionLedgerWriter } from '../agent/session-ledger.js';
import { ensureSessionKey, signAbortRequest, freshChannelId } from '../agent/afk-channel.js';
import type { ElicitationRequest, ElicitationResult } from '../agent/types/sdk-types.js';
import type { MessageHandler } from './handlers/message.js';

let seq = 0;
function freshId(): string {
  return `twoway-e2e-${Date.now()}-${seq++}`;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Minimal Telegraf bot + MessageHandler stub sufficient for the elicitation
 * path in `_run` — mirrors `makeElicitStubs` in watch.test.ts. The bot stub
 * only needs `sendMessage` + `action`; the MessageHandler stub only needs the
 * two pending-resolver maps `makeTelegramElicitationHandler` populates.
 */
function makeElicitStubs(chatId: number) {
  const pendingElicitations = new Map<string, (text: string) => void>();
  const ledgerOriginatedPendingChats = new Set<string>();
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
  const messageHandler = {
    pendingElicitations,
    ledgerOriginatedPendingChats,
  } as unknown as MessageHandler;
  return { bot, messageHandler, sentMessages, pendingElicitations, chatId };
}

describe('two-way AFK round-trip (real daemon ↔ real REPL over one ledger)', () => {
  it('elicitation: REPL handler emits → daemon renders+signs+writes-back → REPL handler resolves with the operator answer', async () => {
    const id = freshId();
    const chatId = 7;
    const key = ensureSessionKey(id); // written by /afk on in production
    expect(key).toBeTruthy();

    // The REPL session's ledger writer — emitElicitation appends through this.
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('setup'); // touch the ledger so the daemon tail has a file
    await sleep(50);

    // --- DAEMON SIDE: the real SessionWatchManager._run loop ---
    const { bot, messageHandler, pendingElicitations } = makeElicitStubs(chatId);
    const pushed: string[] = [];
    const manager = new SessionWatchManager(
      () => {},
      bot as unknown as import('telegraf').Telegraf,
      messageHandler,
    );
    manager.start(chatId, id, async (text) => { pushed.push(text); });
    await sleep(100);

    // --- REPL SIDE: the real ledger ElicitationChannel handler ---
    // The keyboard fallback never settles, so ONLY the verified phone reply can
    // resolve the handler — proving the cross-process write-back is what won.
    const neverFallback = (): Promise<ElicitationResult> =>
      new Promise<ElicitationResult>(() => { /* pending forever */ });
    const handler = makeLedgerChannelHandler({
      sessionId: id,
      key,
      emitElicitation: (record) => writer.record(record),
      fallback: neverFallback,
      newReqId: () => 'req-e2e',
    });

    // The agent asks a question while AFK.
    const request: ElicitationRequest = { type: 'text', message: 'What is your name?' };
    const answerP = handler(request, { signal: new AbortController().signal });

    // The daemon tail should observe the elicitation and install the resolver.
    await sleep(300);
    const resolver = pendingElicitations.get(String(chatId));
    expect(resolver).toBeDefined();

    // Operator answers on the phone. The daemon signs + writes back the response;
    // the REPL handler verifies the HMAC and resolves.
    resolver!('Alice');

    const result = await answerP;
    expect(result.action).toBe('accept'); // resolved by the phone, not declined
    expect(JSON.stringify(result)).toContain('Alice'); // the answer round-tripped

    manager.stop(chatId);
    await writer.close();
  }, 15_000);

  it('abort: a daemon /abort-style signed write fires the REPL abort-watcher exactly once', async () => {
    const id = freshId();
    const key = ensureSessionKey(id);
    expect(key).toBeTruthy();

    const writer = new SessionLedgerWriter(id);
    writer.recordUser('setup');
    await sleep(50);

    // --- REPL SIDE: the real abort-watcher ---
    const reasons: string[] = [];
    const watcher = makeAbortWatcher({
      sessionId: id,
      key,
      onAbort: (reason) => reasons.push(reason),
    });
    await sleep(80);

    // --- DAEMON SIDE: write an abort_request exactly as bot.ts's /abort does
    // (fresh nonce + signAbortRequest + a single-record SessionLedgerWriter). ---
    const nonce = freshChannelId();
    const hmac = signAbortRequest(key!, id, nonce);
    new SessionLedgerWriter(id).record({ kind: 'abort_request', nonce, hmac });

    await sleep(300);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('abort');

    watcher.stop();
    await writer.close();
  }, 15_000);
});
