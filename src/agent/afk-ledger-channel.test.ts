/**
 * Tests for the REPL-side ledger ElicitationChannel handler.
 *
 * The load-bearing assertion is Invariant #4: an `elicitation_response` whose
 * per-session HMAC does NOT verify is ignored — it can never resolve the
 * question. The additive-racing behaviour (phone vs. keyboard vs. abort) is
 * exercised in all four directions.
 *
 * Temp AFK_HOME set before import so no real ~/.afk/state is touched.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ledgerchan-test-'));
process.env['AFK_HOME'] = tmpDir;

import { makeLedgerChannelHandler, makeAbortWatcher } from './afk-ledger-channel.js';
import { SessionLedgerWriter } from './session-ledger.js';
import { ensureSessionKey, signElicitationResponse, signAbortRequest } from './afk-channel.js';
import type { ElicitationRequest, ElicitationResult } from './types/sdk-types.js';

let seq = 0;
function freshId(): string {
  return `ledgerchan-${Date.now()}-${seq++}`;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
const REQUEST: ElicitationRequest = { serverName: 'agent', origin: 'agent', message: 'Proceed?' };
/** A fallback that never resolves — so the ledger/abort branch decides. */
const neverFallback = () => new Promise<ElicitationResult>(() => { /* pending forever */ });

describe('makeLedgerChannelHandler', () => {
  it('resolves from a VERIFIED ledger response (phone answers)', async () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const writer = new SessionLedgerWriter(id);
    const handler = makeLedgerChannelHandler({
      sessionId: id,
      key,
      emitElicitation: (rec) => writer.record(rec),
      fallback: neverFallback,
      newReqId: () => 'rX',
    });

    const p = handler(REQUEST, { signal: new AbortController().signal });
    await sleep(80);
    const result: ElicitationResult = { action: 'accept', content: { value: 'yes' } };
    const hmac = signElicitationResponse(key, id, 'rX', result);
    writer.record({ kind: 'elicitation_response', reqId: 'rX', result, hmac });

    await expect(p).resolves.toEqual(result);
    await writer.close();
  });

  it('IGNORES a forged (bad-HMAC) response, then the keyboard fallback wins', async () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const writer = new SessionLedgerWriter(id);
    let resolveKbd!: (r: ElicitationResult) => void;
    const kbdResult: ElicitationResult = { action: 'accept', content: { value: 'from-keyboard' } };
    const handler = makeLedgerChannelHandler({
      sessionId: id,
      key,
      emitElicitation: (rec) => writer.record(rec),
      fallback: () => new Promise<ElicitationResult>((res) => { resolveKbd = res; }),
      newReqId: () => 'rY',
    });

    const p = handler(REQUEST, { signal: new AbortController().signal });
    await sleep(80);
    // Daemon (or a stray writer) emits a FORGED response — wrong signature.
    writer.record({
      kind: 'elicitation_response',
      reqId: 'rY',
      result: { action: 'accept', content: { value: 'EVIL' } },
      hmac: 'deadbeefdeadbeef',
    });
    await sleep(350); // give the tail time to see + reject it

    // The forged reply must NOT have resolved the handler. Now the keyboard answers.
    resolveKbd(kbdResult);
    await expect(p).resolves.toEqual(kbdResult);
    await writer.close();
  });

  it('resolves from the keyboard fallback when it answers first', async () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const writer = new SessionLedgerWriter(id);
    const kbdResult: ElicitationResult = { action: 'accept', content: { value: 'kbd' } };
    const handler = makeLedgerChannelHandler({
      sessionId: id,
      key,
      emitElicitation: (rec) => writer.record(rec),
      fallback: async () => kbdResult,
      newReqId: () => 'rZ',
    });
    await expect(handler(REQUEST, { signal: new AbortController().signal })).resolves.toEqual(kbdResult);
    await writer.close();
  });

  it('declines on abort', async () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const writer = new SessionLedgerWriter(id);
    const ac = new AbortController();
    const handler = makeLedgerChannelHandler({
      sessionId: id,
      key,
      emitElicitation: (rec) => writer.record(rec),
      fallback: neverFallback,
      newReqId: () => 'rA',
    });
    const p = handler(REQUEST, { signal: ac.signal });
    await sleep(50);
    ac.abort();
    await expect(p).resolves.toEqual({ action: 'decline' });
    await writer.close();
  });

  it('declines immediately when the signal is already aborted', async () => {
    const id = freshId();
    const ac = new AbortController();
    ac.abort();
    const handler = makeLedgerChannelHandler({
      sessionId: id,
      key: ensureSessionKey(id)!,
      emitElicitation: () => { throw new Error('should not emit when pre-aborted'); },
      fallback: neverFallback,
    });
    await expect(handler(REQUEST, { signal: ac.signal })).resolves.toEqual({ action: 'decline' });
  });

  it('with no key, ignores even a validly-signed response (cannot verify) and uses the keyboard', async () => {
    const id = freshId();
    const key = ensureSessionKey(id)!; // a real key exists on disk...
    const writer = new SessionLedgerWriter(id);
    const kbdResult: ElicitationResult = { action: 'accept', content: { value: 'kbd-only' } };
    let resolveKbd!: (r: ElicitationResult) => void;
    const handler = makeLedgerChannelHandler({
      sessionId: id,
      key: null, // ...but the handler was given no key → ledger branch disabled
      emitElicitation: (rec) => writer.record(rec),
      fallback: () => new Promise<ElicitationResult>((res) => { resolveKbd = res; }),
      newReqId: () => 'rN',
    });
    const p = handler(REQUEST, { signal: new AbortController().signal });
    await sleep(60);
    const result: ElicitationResult = { action: 'accept', content: { value: 'signed-but-ignored' } };
    writer.record({
      kind: 'elicitation_response',
      reqId: 'rN',
      result,
      hmac: signElicitationResponse(key, id, 'rN', result),
    });
    await sleep(300);
    resolveKbd(kbdResult);
    await expect(p).resolves.toEqual(kbdResult);
    await writer.close();
  });
});

// ---------------------------------------------------------------------------
// makeAbortWatcher — criterion 4
// ---------------------------------------------------------------------------

describe('makeAbortWatcher (criterion 4)', () => {
  it('fires onAbort ONLY on a VERIFIED abort_request, not on a forged one', async () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const writer = new SessionLedgerWriter(id);
    const abortReasons: string[] = [];

    const watcher = makeAbortWatcher({
      sessionId: id,
      key,
      onAbort: (reason) => abortReasons.push(reason),
    });

    await sleep(80);

    // Write a FORGED abort_request (bad HMAC). Must be IGNORED.
    writer.record({ kind: 'abort_request', nonce: 'bad-nonce', hmac: 'deadbeefdeadbeef' });
    await sleep(200);
    expect(abortReasons).toHaveLength(0);

    // Write a VERIFIED abort_request. Must fire onAbort exactly once.
    const nonce = 'valid-nonce-001';
    const hmac = signAbortRequest(key, id, nonce);
    writer.record({ kind: 'abort_request', nonce, hmac });
    await sleep(200);

    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toContain('abort');

    watcher.stop();
    await writer.close();
  });

  it('key=null → never calls onAbort, even for a validly-signed record', async () => {
    const id = freshId();
    const key = ensureSessionKey(id)!; // a real key exists on disk…
    const writer = new SessionLedgerWriter(id);
    const abortReasons: string[] = [];

    // …but the watcher is given no key → ledger branch disabled.
    const watcher = makeAbortWatcher({
      sessionId: id,
      key: null,
      onAbort: (reason) => abortReasons.push(reason),
    });

    await sleep(60);
    const nonce = 'valid-nonce-002';
    const hmac = signAbortRequest(key, id, nonce);
    writer.record({ kind: 'abort_request', nonce, hmac });
    await sleep(300);

    expect(abortReasons).toHaveLength(0);

    watcher.stop();
    await writer.close();
  });

  it('stop() ends the watcher — no further onAbort calls after stop', async () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const writer = new SessionLedgerWriter(id);
    const abortReasons: string[] = [];

    const watcher = makeAbortWatcher({
      sessionId: id,
      key,
      onAbort: (reason) => abortReasons.push(reason),
    });

    await sleep(60);
    // Stop the watcher before any record arrives.
    watcher.stop();
    await sleep(60);

    // A valid abort_request arrives AFTER stop → must NOT trigger onAbort.
    const nonce = 'post-stop-nonce';
    const hmac = signAbortRequest(key, id, nonce);
    writer.record({ kind: 'abort_request', nonce, hmac });
    await sleep(200);

    expect(abortReasons).toHaveLength(0);

    await writer.close();
  });

  it('stop() is idempotent — calling it multiple times does not throw', async () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const writer = new SessionLedgerWriter(id);
    const watcher = makeAbortWatcher({
      sessionId: id,
      key,
      onAbort: () => {},
    });
    watcher.stop();
    watcher.stop();
    watcher.stop(); // must not throw
    await writer.close();
  });
});
