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

import { makeLedgerChannelHandler } from './afk-ledger-channel.js';
import { SessionLedgerWriter } from './session-ledger.js';
import { ensureSessionKey, signElicitationResponse } from './afk-channel.js';
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
