/**
 * Regression tests for provider-turn ownership: the abandoned-turn desync
 * ("ESC, send a message, it looks sent but nothing runs, then every reply is
 * one message behind") and the stray interrupt ("ESC, send, ESC again: the
 * session never answers again").
 *
 * Contract: one send owns one provider turn. A consumer that stops reading a
 * turn before its terminal event (the REPL soft-stop loop breaks on the first
 * event after ESC) must not leave that turn's tail for the NEXT send to read,
 * and an interrupt must never reach the provider when it has no turn to stop.
 *
 * Field evidence this reproduces (session 830f0aa1, 2026-11-13): after ESC
 * during a tool round the next user message received the interrupted turn's
 * own `done` 128 ms later and was never run; each later send then answered the
 * previous message.
 *
 * @module agent/session/turn-stream-runner.abandoned-turn.test
 */

// Ledger writes are isolated by the global setup file
// src/__test-utils__/redirect-paths-env.ts (per-file AFK_HOME sentinel).
import { describe, it, expect } from 'vitest';
import { AgentSession } from './agent-session.js';
import { createHookRegistry } from '../hooks.js';
import { AbortCoordinator } from '../providers/shared/abort-coordinator.js';
import { readLedger, type LedgerRecord } from '../session-ledger.js';
import type {
  ModelProvider,
  ProviderEvent,
  ProviderQuery,
  ProviderQueryArgs,
  ProviderUserTurn,
} from '../provider.js';
import type { OutputEvent } from '../types.js';

interface ScriptedProvider extends ModelProvider {
  interruptCalls: number;
  /** User-turn contents in the order the provider actually started them. */
  startedTurns: string[];
  /** Number of `query()` calls, i.e. provider lifecycles (a reset adds one). */
  queryCount: number;
  /** Let a "gated" turn emit its post-abort tail. */
  releaseTail: () => void;
}

function completed(sessionId: string, stopReason: 'end_turn' | 'interrupted'): ProviderEvent {
  return {
    type: 'turn.completed',
    usage: {
      resultSubtype: stopReason === 'interrupted' ? 'interrupted' : 'success',
      stopReason,
      durationMs: 5,
      totalCostUsd: 0.001,
      inputTokens: 10,
      outputTokens: 2,
      raw: { input_tokens: 10, output_tokens: 2 },
    },
    sessionId,
  };
}

/**
 * A provider shaped like the real ones where it matters here: ONE generator is
 * shared across turns, each turn gets its abort scope from the real
 * {@link AbortCoordinator} (so a redundant interrupt parks and pre-aborts the
 * next turn), a turn that starts pre-aborted ENDS the generator as the real
 * driver does (anthropic-direct/query-turn-driver.ts, the early return after
 * `abort.begin()`), and a "long" turn emits a
 * non-terminal event AFTER the abort before its terminal `turn.completed`,
 * as a tool round does when its aborted results are flushed. A "gated" long
 * turn additionally holds that tail until `releaseTail()` (a tool that is slow
 * to die), so a test can close or reset the session mid-settlement.
 */
function createScriptedProvider(sessionId: string): ScriptedProvider {
  let release: () => void = () => {};
  const tailGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: ScriptedProvider = {
    name: 'scripted-provider',
    interruptCalls: 0,
    startedTurns: [],
    queryCount: 0,
    releaseTail: () => release(),
    query(args: ProviderQueryArgs): ProviderQuery {
      provider.queryCount++;
      const promptIter = args.prompt[Symbol.asyncIterator]();
      const abort = new AbortCoordinator();
      let closed = false;

      const q: ProviderQuery = {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield {
            type: 'session.init',
            info: {
              sessionId,
              model: 'claude-sonnet-5',
              permissionMode: 'bypassPermissions',
              cwd: process.cwd(),
              tools: [],
              slashCommands: [],
              skills: [],
              plugins: [],
              mcpServers: [],
              apiKeySource: 'api-key',
              version: 'scripted-v1',
            },
          };
          while (!closed) {
            const next = await Promise.race([promptIter.next(), abort.closedPromise]);
            if (typeof next === 'string') break;
            const turnResult = next as IteratorResult<ProviderUserTurn>;
            if (turnResult.done) break;
            const content =
              typeof turnResult.value.content === 'string' ? turnResult.value.content : '[blocks]';
            provider.startedTurns.push(content);
            const controller = abort.begin();
            try {
              if (controller.signal.aborted) {
                // A parked interrupt reached this turn: the stream ends for
                // good and every later send gets nothing.
                abort.clear(controller);
                return;
              }
              if (!content.includes('long')) {
                yield { type: 'assistant.message', text: `Echo: ${content}`, sessionId };
                // Like the real driver, the abort scope is released BEFORE the
                // terminal is published, so a later interrupt finds no turn.
                abort.clear(controller);
                yield completed(sessionId, 'end_turn');
                continue;
              }
              yield { type: 'delta.text', text: `start:${content}`, sessionId };
              // The "tool in flight": settles only once the turn is aborted.
              if (!controller.signal.aborted) {
                await new Promise<void>((resolve) => {
                  controller.signal.addEventListener('abort', () => resolve(), { once: true });
                });
              }
              if (content.includes('gated')) {
                // First aborted result is flushed (the consumer breaks on it),
                // then a slow-to-die tool holds the rest of the turn until it
                // is released or the provider closes.
                yield { type: 'delta.text', text: `aborting:${content}`, sessionId };
                const gate = await Promise.race([tailGate, abort.closedPromise]);
                if (typeof gate === 'string') {
                  // Like the real providers: a turn cut short by close still
                  // yields its terminal before the generator returns.
                  yield completed(sessionId, 'interrupted');
                  return;
                }
              }
              yield { type: 'delta.text', text: `tail:${content}`, sessionId };
              yield completed(sessionId, 'interrupted');
            } finally {
              abort.clear(controller);
            }
          }
        },
        async interrupt(reason = 'interrupted') {
          provider.interruptCalls++;
          abort.requestAbort(reason);
        },
        async setModel() {},
        async setPermissionMode() {},
        async supportedCommands() { return []; },
        async supportedModels() { return []; },
        async supportedAgents() { return []; },
        async getContextUsage() {
          return { tools: [], agents: [], isAutoCompactEnabled: false, apiUsage: null };
        },
        async mcpServerStatus() { return []; },
        async accountInfo() { return { subscriptionType: 'api-key' }; },
        async rewindFiles() { return { canRewind: false }; },
        close() {
          closed = true;
          abort.markClosed();
        },
      };
      return q;
    },
  };
  return provider;
}

async function collect(session: AgentSession, message: string): Promise<OutputEvent[]> {
  const events: OutputEvent[] = [];
  for await (const event of session.sendMessageStream(message)) events.push(event);
  return events;
}

function messageTexts(events: OutputEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === 'message' && typeof e.message.content === 'string' ? [e.message.content] : [],
  );
}

function chunkTexts(events: OutputEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'chunk' ? [e.chunk.content] : []));
}

function stopReasonOf(events: OutputEvent[]): string | null | undefined {
  const done = events.find((e) => e.type === 'done') as
    | Extract<OutputEvent, { type: 'done' }>
    | undefined;
  return done?.metadata?.stopReason;
}

/**
 * Mirror of the REPL soft-stop loop (turn-handler.ts): ESC interrupts from a
 * key handler, then the stream loop breaks at the top of its NEXT iteration,
 * i.e. on the first event that arrives after ESC, without reading further.
 */
async function sendThenEscAndBreak(session: AgentSession, message: string): Promise<void> {
  let escPressed = false;
  for await (const _event of session.sendMessageStream(message)) {
    if (escPressed) break;
    await session.interrupt();
    escPressed = true;
  }
}

async function ledgerOf(sessionId: string): Promise<LedgerRecord[]> {
  const out: LedgerRecord[] = [];
  for await (const r of readLedger(sessionId)) out.push(r);
  return out;
}

describe('abandoned turn: ESC then send', () => {
  it('runs the next message as its own turn instead of handing it the interrupted turn tail', async () => {
    const provider = createScriptedProvider(`abandoned-next-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    await sendThenEscAndBreak(session, 'long task');
    const events = await collect(session, 'real message');
    await session.close();

    // Pre-fix: this send read `tail:long task` + the interrupted `done` and
    // ended without ever running "real message".
    expect(chunkTexts(events)).not.toContain('tail:long task');
    expect(messageTexts(events)).toEqual(['Echo: real message']);
    expect(stopReasonOf(events)).toBe('end_turn');
  });

  it('does not leave later replies one message behind', async () => {
    const provider = createScriptedProvider(`abandoned-lag-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    await sendThenEscAndBreak(session, 'long task');
    const first = await collect(session, 'first');
    const second = await collect(session, 'second');
    const third = await collect(session, 'third');
    await session.close();

    expect(messageTexts(first)).toEqual(['Echo: first']);
    expect(messageTexts(second)).toEqual(['Echo: second']);
    expect(messageTexts(third)).toEqual(['Echo: third']);
    expect(provider.startedTurns).toEqual(['long task', 'first', 'second', 'third']);
  });

  it('records exactly one done for the interrupted turn, carrying the real stop reason', async () => {
    const sessionId = `abandoned-ledger-${Date.now()}`;
    const provider = createScriptedProvider(sessionId);
    const session = new AgentSession({ model: 'sonnet', provider });

    await sendThenEscAndBreak(session, 'long task');
    await collect(session, 'real message');
    await session.close();

    const records = await ledgerOf(sessionId);
    const kinds = records.filter((r) => r.kind === 'user' || r.kind === 'done');
    // user(long) -> done(interrupted) -> user(real) -> done(end_turn): the
    // interrupted turn's terminal lands BEFORE the next user record, not after.
    expect(kinds.map((r) => r.kind)).toEqual(['user', 'done', 'user', 'done']);
    expect(kinds[1]!.stopReason).toBe('interrupted');
    expect(kinds[3]!.stopReason).toBe('end_turn');
  });

  it('does not issue a second provider interrupt that would pre-abort the next turn', async () => {
    const provider = createScriptedProvider(`abandoned-single-int-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    await sendThenEscAndBreak(session, 'long task');
    const events = await collect(session, 'real message');
    // Snapshot before close(): closing the session issues its own interrupt.
    const interruptsBeforeClose = provider.interruptCalls;
    await session.close();

    expect(interruptsBeforeClose).toBe(1);
    expect(stopReasonOf(events)).toBe('end_turn');
  });
});

describe('abandoned turn: consumer stops reading without interrupting', () => {
  it('stops the unread turn and runs the next message as its own turn', async () => {
    const provider = createScriptedProvider(`abandoned-noint-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    // A consumer that bails (e.g. its event handler threw) with no interrupt.
    for await (const _event of session.sendMessageStream('long task')) break;

    const events = await collect(session, 'real message');
    const interruptsBeforeClose = provider.interruptCalls;
    await session.close();

    // The unread turn was stopped rather than left to run to completion
    // unobserved, and the new message got its own turn.
    expect(interruptsBeforeClose).toBe(1);
    expect(chunkTexts(events)).not.toContain('tail:long task');
    expect(messageTexts(events)).toEqual(['Echo: real message']);
    expect(stopReasonOf(events)).toBe('end_turn');
  });
});

describe('turns read to their terminal event are unaffected', () => {
  it('consecutive fully-read turns stay in order with no settlement interrupt', async () => {
    const provider = createScriptedProvider(`abandoned-clean-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    const first = await collect(session, 'hello');
    const second = await collect(session, 'again');
    const interruptsBeforeClose = provider.interruptCalls;
    await session.close();

    expect(messageTexts(first)).toEqual(['Echo: hello']);
    expect(messageTexts(second)).toEqual(['Echo: again']);
    expect(interruptsBeforeClose).toBe(0);
  });
});

describe('abandoned turn: ledger is sealed before settlement finishes', () => {
  /** `done` records between the first user record and the next one (or the end). */
  function donesOfFirstTurn(records: LedgerRecord[]): LedgerRecord[] {
    const users = records.flatMap((r, i) => (r.kind === 'user' ? [i] : []));
    const from = users[0] ?? 0;
    const to = users[1] ?? records.length;
    return records.slice(from, to).filter((r) => r.kind === 'done');
  }

  it('close() during settlement still leaves exactly one done for the interrupted turn', async () => {
    const sessionId = `abandoned-close-race-${Date.now()}`;
    const provider = createScriptedProvider(sessionId);
    const session = new AgentSession({ model: 'sonnet', provider });

    // ESC, then the tool is slow to die: settlement is parked on the tail.
    await sendThenEscAndBreak(session, 'long gated task');
    await session.close();
    provider.releaseTail();

    const records = await ledgerOf(sessionId);
    expect(records.filter((r) => r.kind === 'done')).toHaveLength(1);
  });

  it('close() during settlement delivers nothing from the old turn to output subscribers afterwards', async () => {
    const provider = createScriptedProvider(`abandoned-close-broadcast-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });
    // Subscribe but do not pull: everything pushed is buffered for inspection.
    const subscriber = session.getOutputStream()[Symbol.asyncIterator]();

    await sendThenEscAndBreak(session, 'long gated task');
    // Closing the provider makes the gated turn yield its terminal, which the
    // still-running settlement reads AFTER the session was sealed and closed.
    await session.close();
    provider.releaseTail();

    const delivered: OutputEvent[] = [];
    for (let r = await subscriber.next(); !r.done; r = await subscriber.next()) delivered.push(r.value);
    expect(delivered.map((e) => e.type)).not.toContain('done');
  });

  it('reset() during settlement keeps one done and the next conversation runs normally', async () => {
    const sessionId = `abandoned-reset-race-${Date.now()}`;
    const provider = createScriptedProvider(sessionId);
    const session = new AgentSession({ model: 'sonnet', provider });

    await sendThenEscAndBreak(session, 'long gated task');
    await session.reset();
    // The old turn's terminal arrives while the provider is being torn down.
    // It belongs to the sealed conversation and must not count as a turn of
    // the new one.
    const turnCountAfterReset = session.getTurnCount();
    const events = await collect(session, 'after reset');
    const turnCountAfterSend = session.getTurnCount();
    await session.close();
    provider.releaseTail();

    expect(turnCountAfterReset).toBe(0);
    expect(turnCountAfterSend).toBe(1);
    expect(provider.queryCount).toBe(2);
    expect(chunkTexts(events)).not.toContain('tail:long gated task');
    expect(messageTexts(events)).toEqual(['Echo: after reset']);
    expect(stopReasonOf(events)).toBe('end_turn');
    expect(donesOfFirstTurn(await ledgerOf(sessionId))).toHaveLength(1);
  });

  it('a turn nobody interrupted, then reset(): one done is kept and the next conversation runs', async () => {
    const sessionId = `abandoned-noint-reset-${Date.now()}`;
    const provider = createScriptedProvider(sessionId);
    const session = new AgentSession({ model: 'sonnet', provider });

    for await (const _event of session.sendMessageStream('long task')) break;
    await session.reset();
    const events = await collect(session, 'after reset');
    await session.close();

    expect(messageTexts(events)).toEqual(['Echo: after reset']);
    expect(stopReasonOf(events)).toBe('end_turn');
    expect(donesOfFirstTurn(await ledgerOf(sessionId))).toHaveLength(1);
  });
});

describe('interrupt with no provider turn to stop', () => {
  /** Start a send without awaiting it, and give it a moment to begin waiting. */
  async function startSend(
    session: AgentSession,
    message: string,
  ): Promise<{ events: OutputEvent[]; finished: Promise<void> }> {
    const events: OutputEvent[] = [];
    const finished = (async () => {
      for await (const e of session.sendMessageStream(message)) events.push(e);
    })();
    await new Promise((r) => setTimeout(r, 20));
    return { events, finished };
  }

  it('second ESC while the next send waits on the old turn: that send is cancelled and the session lives', async () => {
    const provider = createScriptedProvider(`stray-repeat-esc-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    // ESC #1 on a tool that is slow to die, then a new message that has to
    // wait for it, then ESC #2 because nothing visible is happening.
    await sendThenEscAndBreak(session, 'long gated task');
    const real = await startSend(session, 'real message');
    await session.interrupt();
    await real.finished;
    const interruptsAfterSecondEsc = provider.interruptCalls;
    provider.releaseTail();

    const after = await collect(session, 'after');
    const later = await collect(session, 'later');
    await session.close();

    // The cancelled send ends at once with a normal interrupted terminal and
    // never reaches the provider; the provider was interrupted exactly once.
    expect(real.events.map((e) => e.type)).toEqual(['done']);
    expect(stopReasonOf(real.events)).toBe('interrupted');
    expect(interruptsAfterSecondEsc).toBe(1);
    expect(messageTexts(after)).toEqual(['Echo: after']);
    expect(messageTexts(later)).toEqual(['Echo: later']);
    expect(provider.startedTurns).toEqual(['long gated task', 'after', 'later']);
  }, 5000);

  it('ESC before the first turn has started (session still initializing) cancels the send only', async () => {
    const provider = createScriptedProvider(`stray-init-esc-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    const stream = session.sendMessageStream('hello')[Symbol.asyncIterator]();
    const first = stream.next(); // the send is now waiting on initialization
    await session.interrupt();
    const cancelled = await first;
    await stream.return?.();
    const interruptsAfterEsc = provider.interruptCalls;

    const after = await collect(session, 'after');
    await session.close();

    expect(cancelled.done).toBe(false);
    expect(cancelled.value.type).toBe('done');
    expect(interruptsAfterEsc).toBe(0);
    expect(messageTexts(after)).toEqual(['Echo: after']);
    expect(provider.startedTurns).toEqual(['after']);
  }, 5000);

  it('ESC after the turn has produced its last event is not forwarded to the provider', async () => {
    const provider = createScriptedProvider(`stray-late-esc-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    // Hold the stream at its terminal: the provider turn is over but the send
    // has not finished (in production, end-of-turn hooks run in this window).
    const stream = session.sendMessageStream('hello')[Symbol.asyncIterator]();
    let r = await stream.next();
    while (!r.done && r.value.type !== 'done') r = await stream.next();
    await session.interrupt();
    await stream.return?.();
    const interruptsAfterEsc = provider.interruptCalls;

    const after = await collect(session, 'after');
    await session.close();

    expect(interruptsAfterEsc).toBe(0);
    expect(messageTexts(after)).toEqual(['Echo: after']);
  }, 5000);

  it('a send accepted while the interrupted turn still has its reader waits for that turn to end', async () => {
    const provider = createScriptedProvider(`stray-live-reader-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    // The first consumer is interrupted but keeps its stream open.
    const first = session.sendMessageStream('long gated task')[Symbol.asyncIterator]();
    const firstEvents: OutputEvent[] = [];
    const opening = await first.next();
    if (!opening.done) firstEvents.push(opening.value);
    await session.interrupt();

    const real = await startSend(session, 'real message');
    provider.releaseTail();
    for (let r = await first.next(); !r.done; r = await first.next()) firstEvents.push(r.value);
    await real.finished;
    await session.close();

    // Each consumer saw only its own turn, in order.
    expect(chunkTexts(firstEvents)).toEqual([
      'start:long gated task',
      'aborting:long gated task',
      'tail:long gated task',
    ]);
    expect(stopReasonOf(firstEvents)).toBe('interrupted');
    expect(chunkTexts(real.events)).toEqual([]);
    expect(messageTexts(real.events)).toEqual(['Echo: real message']);
    expect(provider.startedTurns).toEqual(['long gated task', 'real message']);
  }, 5000);

  it('the earlier reader letting go does not mark the session idle under the newer turn', async () => {
    const provider = createScriptedProvider(`stray-state-owner-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    const first = session.sendMessageStream('long gated task')[Symbol.asyncIterator]();
    await first.next();
    await session.interrupt(); // interrupt #1, for the first turn
    const second = session.sendMessageStream('long second')[Symbol.asyncIterator]();
    const secondOpening = second.next(); // waits behind the first turn
    provider.releaseTail();
    for (let r = await first.next(); !r.done && r.value.type !== 'done'; r = await first.next()) {
      // read the first turn up to its terminal, keeping the stream open
    }
    await secondOpening; // the second turn is now running
    await first.return?.(); // the earlier reader finally lets go
    const stateAfterFirstLetGo = session.state;

    await session.interrupt(); // must reach the SECOND turn
    const interrupts = provider.interruptCalls;
    await second.return?.();
    await session.close();

    expect(stateAfterFirstLetGo).toBe('streaming');
    expect(interrupts).toBe(2);
  }, 5000);

  it('close() cancels a send that is still waiting to start', async () => {
    const provider = createScriptedProvider(`stray-close-waiter-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    const first = session.sendMessageStream('long gated task')[Symbol.asyncIterator]();
    await first.next();
    await session.interrupt();
    const second = session.sendMessageStream('real message')[Symbol.asyncIterator]();
    const opening = second.next(); // waits behind the first turn
    await session.close();

    // Decided before the first reader lets go: the waiter must not hang on it.
    const outcome = await Promise.race([
      opening.then((r) => (r.done ? 'ended' : r.value.type)),
      new Promise<string>((r) => setTimeout(() => r('hung'), 200)),
    ]);
    await first.return?.();
    provider.releaseTail();

    expect(outcome).toBe('done');
    expect(session.getHistory().map((m) => m.content)).toEqual(['long gated task']);
    expect(provider.startedTurns).toEqual(['long gated task']);
  }, 5000);
});

describe('end-of-turn work finishes before the turn is released', () => {
  /**
   * A session whose FIRST Stop hook blocks until `releaseStop()`: the window in
   * which the provider turn is over but the session is still finishing it
   * (Stop hooks, then the ledger `done`).
   */
  function sessionWithSlowStop(sessionId: string): {
    session: AgentSession;
    provider: ScriptedProvider;
    stopEntered: Promise<void>;
    releaseStop: () => void;
  } {
    let entered: () => void = () => {};
    const stopEntered = new Promise<void>((r) => {
      entered = r;
    });
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((r) => {
      releaseStop = r;
    });
    let calls = 0;
    const registry = createHookRegistry();
    registry.register('Stop', async () => {
      if (calls++ === 0) {
        entered();
        await stopGate;
      }
      return {};
    });
    const provider = createScriptedProvider(sessionId);
    const session = new AgentSession({ model: 'sonnet', provider, hookRegistry: registry });
    session.wireStopHook({ getHasNextTurn: () => true });
    return { session, provider, stopEntered, releaseStop };
  }

  it('a waiting send starts only after the previous turn has run its Stop hook and recorded its done', async () => {
    const sessionId = `eot-order-${Date.now()}`;
    const { session, provider, stopEntered, releaseStop } = sessionWithSlowStop(sessionId);

    // Interrupted turn whose reader stays attached, and a send waiting behind it.
    const first = session.sendMessageStream('long gated task')[Symbol.asyncIterator]();
    await first.next();
    await session.interrupt();
    const realEvents: OutputEvent[] = [];
    const realFinished = (async () => {
      for await (const e of session.sendMessageStream('real message')) realEvents.push(e);
    })();
    provider.releaseTail();
    const firstFinished = (async () => {
      for (let r = await first.next(); !r.done; r = await first.next()) {
        // read the first turn to its end
      }
    })();

    // The old turn's last event has been pulled; its Stop hook is running.
    await stopEntered;
    await new Promise((r) => setTimeout(r, 30));
    const startedDuringStop = [...provider.startedTurns];
    const historyDuringStop = session.getHistory().map((m) => m.content);

    releaseStop();
    await firstFinished;
    await realFinished;
    await session.close();

    expect(startedDuringStop).toEqual(['long gated task']);
    expect(historyDuringStop).not.toContain('real message');
    const kinds = (await ledgerOf(sessionId)).filter((r) => r.kind === 'user' || r.kind === 'done');
    expect(kinds.map((r) => r.kind)).toEqual(['user', 'done', 'user', 'done']);
    expect(kinds[1]!.stopReason).toBe('interrupted');
    expect(messageTexts(realEvents)).toEqual(['Echo: real message']);
  }, 5000);

  it('an interrupt while a finished turn is still running its Stop hook is not forwarded', async () => {
    const { session, provider, stopEntered, releaseStop } = sessionWithSlowStop(`eot-esc-${Date.now()}`);

    const helloFinished = collect(session, 'hello');
    await stopEntered; // provider turn is over; the session is in its Stop hook
    await session.interrupt();
    const interruptsDuringStop = provider.interruptCalls;
    releaseStop();
    const hello = await helloFinished;

    const after = await collect(session, 'after');
    await session.close();

    expect(interruptsDuringStop).toBe(0);
    expect(messageTexts(hello)).toEqual(['Echo: hello']);
    expect(messageTexts(after)).toEqual(['Echo: after']);
  }, 5000);
});
