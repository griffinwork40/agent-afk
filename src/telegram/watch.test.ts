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

// realpathSync normalizes Windows 8.3 short paths (e.g. RUNNER~1) to their
// long form so session-store's own realpathSync call matches AFK_HOME.
const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'afk-watch-test-')));
process.env['AFK_HOME'] = tmpDir;
// Windows: os.homedir() reads USERPROFILE, not HOME. Isolate both so any
// code that calls os.homedir() sees the same sentinel dir on all platforms.
process.env['HOME'] = tmpDir;
process.env['USERPROFILE'] = tmpDir;

import { SessionWatchManager, renderLedgerRecord, resolveWatchTarget } from './watch.js';
import { SessionLedgerWriter, type LedgerRecord } from '../agent/session-ledger.js';
import { getSessionsDir } from '../paths.js';
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
    // vi.waitFor instead of a fixed sleep(600): on slow Windows runners the
    // debounce + tail flush can take longer than a fixed budget.
    await vi.waitFor(() => {
      expect(sent.join('\n')).toContain('watch ended');
    }, { timeout: 2000 });

    const all = sent.join('\n');
    expect(all).toContain('👤 hello from CLI');
    expect(all).toContain('🤖 on it');
    expect(all).toContain('watch ended');
    // Watch ended → registry cleaned up, but not in the same tick as the final
    // send. On `closed`, _run queues the send and breaks out of the tail, which
    // awaits the ledger file handle's close() before _run's finally deletes the
    // registry entry. The send lands during that await, so polling for the
    // message and then asserting synchronously raced the cleanup.
    await vi.waitFor(() => {
      expect(manager.watching(7)).toBeUndefined();
    }, { timeout: 2000 });
    // Batching: the user+assistant records (written within one debounce
    // window) must arrive in a single message, not one send per record.
    expect(sent.some((m) => m.includes('hello from CLI') && m.includes('on it'))).toBe(true);
  });

  it('relays pre-tool assistant text (segmented ledger) and keeps the 700-char preview for uncapped answers', async () => {
    const id = freshId();
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('pre');
    await sleep(50);
    const sent: string[] = [];
    const manager = new SessionWatchManager();
    manager.start(9, id, async (text) => { sent.push(text); });
    await sleep(100);
    writer.recordUser('run it');
    writer.recordEvent({ type: 'chunk', chunk: { type: 'content', content: 'checking first' } });
    writer.recordEvent({ type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 't', toolName: 'bash', toolInput: 'ls' } } as never);
    const long = 'z'.repeat(20_000);
    writer.recordEvent({ type: 'message', message: { role: 'assistant', content: long, timestamp: new Date() } });
    await sleep(300);
    await writer.close('close');
    await vi.waitFor(() => { expect(sent.join('\n')).toContain('watch ended'); }, { timeout: 2000 });
    const all = sent.join('\n');
    expect(all.indexOf('🤖 checking first')).toBeGreaterThan(-1);
    expect(all.indexOf('🤖 checking first')).toBeLessThan(all.indexOf('🔧 bash'));
    const answer = all.split('\n').find((l) => l.startsWith('🤖 zzz'))!;
    expect(answer.length).toBeLessThan(800);
    expect(answer.endsWith('…')).toBe(true);
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

    // First batch send threw; later batches must still be delivered.
    // Use vi.waitFor instead of a fixed sleep: on slow Windows runners the
    // tailLedger poll (250ms) plus the sending Promise chain settling may
    // take longer than a fixed budget.  vi.waitFor polls until the assertion
    // passes or the timeout expires, eliminating the race against sleep(600).
    await vi.waitFor(() => {
      expect(sent.join('\n')).toContain('second-batch');
    }, { timeout: 4_000 });
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: elicitation intercept (C1+C2)
// The write-back path (HMAC-signed elicitation_response over the ledger) was
// removed with the /afk toggle in #5165/#5189. These tests cover the remaining
// behaviour: normal records are still relayed as push lines, and elicitation
// records are intercepted and rendered to the phone (answer not written back).
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

  // A minimal MessageHandler-shaped object. We only need the two maps.
  const messageHandler = {
    pendingElicitations,
    ledgerOriginatedPendingChats,
  } as unknown as MessageHandler;

  return { bot, messageHandler, sentMessages, pendingElicitations, ledgerOriginatedPendingChats, chatId };
}

describe('SessionWatchManager — elicitation intercept (criterion 3)', () => {
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
    // vi.waitFor instead of a fixed sleep(600): on slow Windows runners the
    // debounce + tail flush can take longer than a fixed budget.
    await vi.waitFor(() => {
      expect(sent.join('\n')).toContain('normal record');
    }, { timeout: 2000 });

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

describe('SessionWatchManager — keep-alive heartbeat for a pending elicitation', () => {
  it('re-nudges (capped) while pending without cutting off the wait, and stops after the answer', async () => {
    const id = freshId();
    const chatId = 88;
    // No session key needed — write-back path removed in #5165/#5189.

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
      request: { serverName: 'agent-afk', type: 'text', message: 'name?' },
    });

    const nudges = () => sent.filter((t) => /still waiting/i.test(t)).length;
    // Wait for at least one nudge instead of a fixed sleep — eliminates the
    // flake where event-loop jitter on slow CI runners caused the poll cycle to
    // not fire within the old 800ms budget (#3701 converted siblings the same way).
    await vi.waitFor(() => {
      expect(nudges()).toBeGreaterThanOrEqual(1);
    }, { timeout: 3000 });
    // Capped — never spams forever (MAX_ELICIT_NUDGES = 4).
    expect(nudges()).toBeLessThanOrEqual(4);
    // ... and the wait is STILL open — answer whenever (resolver live, NOT cut off).
    const resolver = pendingElicitations.get(String(chatId));
    expect(resolver).toBeDefined();

    // Answer → the wait resolves, the heartbeat is cleared, nudges stop.
    const beforeAnswer = nudges();
    resolver!('Alice');
    await sleep(300);
    expect(nudges()).toBe(beforeAnswer);

    await writer.close();
    manager.stop(chatId);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: getWatched() getter
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


