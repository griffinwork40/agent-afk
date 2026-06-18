/**
 * AFK remote-control: REPL-side ledger ElicitationChannel.
 *
 * Invariant: in AFK mode the REPL swaps its stdin elicitation handler for the
 * one this factory returns. When the agent asks a question, the handler:
 *   1. opens a tail on its OWN session ledger (at EOF, before emitting) looking
 *      for a VERIFIED `elicitation_response` correlated by `reqId`;
 *   2. emits an `elicitation` record (a watching Telegram daemon renders it to
 *      the operator's phone);
 *   3. races [verified ledger reply, stdin keyboard fallback, abort] and returns
 *      whichever settles first, cancelling the losers via a child AbortSignal.
 *
 * Invariant (scope.lock #4): a ledger reply is acted on ONLY if its per-session
 * HMAC verifies. An unverified/forged `elicitation_response` is ignored, never
 * resolved. With no key the ledger branch is disabled and the handler degrades
 * to the keyboard fallback.
 *
 * Invariant (#3): the channel is ADDITIVE — the stdin `fallback` always races
 * alongside the phone, so the keyboard never stops working and there is no
 * daemon-liveness dependency.
 *
 * Invariant (#5): the only cross-process hop is the ledger file; this module
 * opens no socket and starts no poller.
 *
 * @module agent/afk-ledger-channel
 */

import { tailLedger } from './session-ledger.js';
import { verifyElicitationResponse, freshChannelId } from './afk-channel.js';
import type { ElicitationHandler } from './elicitation-router.js';
import type { ElicitationRequest, ElicitationResult } from './types/sdk-types.js';

const DECLINE: ElicitationResult = { action: 'decline' };

export interface LedgerChannelDeps {
  /** Session id whose ledger carries the channel (the REPL's own session). */
  sessionId: string;
  /**
   * Per-session HMAC key (from `ensureSessionKey`). When null, the ledger reply
   * branch is disabled (cannot verify → must ignore) and only the keyboard
   * fallback + abort race — the safe degrade.
   */
  key: string | null;
  /**
   * Append the `elicitation` request record to the session's ledger. Injected
   * so this module never owns a `SessionLedgerWriter` lifecycle — the caller
   * passes its session writer's `record`, avoiding fd leaks and spurious
   * `closed` records.
   */
  emitElicitation: (record: {
    kind: 'elicitation';
    reqId: string;
    request: ElicitationRequest;
  }) => void;
  /** Keyboard fallback — the existing stdin elicitation handler. */
  fallback: ElicitationHandler;
  /** Correlation-id generator; injectable for tests. */
  newReqId?: () => string;
}

/**
 * Build the REPL-side ledger ElicitationChannel handler. See module docs.
 */
export function makeLedgerChannelHandler(deps: LedgerChannelDeps): ElicitationHandler {
  const { sessionId, key, emitElicitation, fallback } = deps;
  const newReqId = deps.newReqId ?? freshChannelId;

  return function ledgerChannelHandler(
    request: ElicitationRequest,
    options: { signal: AbortSignal },
  ): Promise<ElicitationResult> {
    const outer = options.signal;
    if (outer.aborted) return Promise.resolve(DECLINE);

    const reqId = newReqId();

    let settle!: (r: ElicitationResult) => void;
    const winner = new Promise<ElicitationResult>((resolve) => {
      settle = resolve;
    });

    // Child signal cancels the losing branches once a winner settles (or the
    // outer turn aborts). It never auto-aborts the outer signal.
    const child = new AbortController();
    const onOuterAbort = (): void => {
      child.abort();
      settle(DECLINE);
    };
    outer.addEventListener('abort', onOuterAbort, { once: true });

    // Ledger branch — only when we can verify (Invariant #4). Armed before the
    // emit so the response can never be missed.
    if (key) {
      void (async () => {
        try {
          for await (const rec of tailLedger(sessionId, {
            fromStart: false,
            signal: child.signal,
          })) {
            if (rec.kind === 'elicitation_response' && rec.reqId === reqId) {
              if (verifyElicitationResponse(key, sessionId, reqId, rec.result, rec.hmac)) {
                settle(rec.result);
                return;
              }
              // Unverified/forged response — ignore and keep waiting. This is
              // the security boundary: a stray write cannot drive the agent.
            }
          }
        } catch {
          // Tail error → the ledger branch yields to fallback/abort.
        }
      })();
    }

    // Emit the question for a watching daemon to render (after the tail is armed).
    try {
      emitElicitation({ kind: 'elicitation', reqId, request });
    } catch {
      // If the emit fails the ledger branch is moot; fallback/abort still race.
    }

    // Keyboard fallback — always live (Invariant #3).
    void Promise.resolve(fallback(request, { signal: child.signal }))
      .then((r) => settle(r))
      .catch(() => {
        /* fallback failure yields to the ledger/abort branches */
      });

    return winner.finally(() => {
      child.abort();
      outer.removeEventListener('abort', onOuterAbort);
    });
  };
}
