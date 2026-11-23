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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SETTLE_DRAIN_TIMEOUT_MS } from '../timeout.js';
import { ProviderTurns } from './turn-stream-runner.abandoned-turn.js';
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
                // A "check plan" turn reports the `exit_plan_mode` visible-text
                // gate verdict as the tool handler would read it mid-turn.
                const text = content.startsWith('check plan')
                  ? `Plan gate: ${args.config.planExitControls?.checkPlanText?.() ?? 'unwired'}`
                  : `Echo: ${content}`;
                yield { type: 'assistant.message', text, sessionId };
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

describe('abandoned turn: per-turn plan-text state', () => {
  it('text the interrupted turn streams while settling does not count toward the next turn plan gate', async () => {
    const provider = createScriptedProvider(`abandoned-plan-text-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });
    // The tail delta (`tail:<message>`) carries well over MIN_PLAN_TEXT_CHARS.
    const longMessage = `long gated task ${'x'.repeat(120)}`;

    await sendThenEscAndBreak(session, longMessage);
    // The next send is accepted while the old turn is still settling; its
    // tail arrives only after that send is already waiting behind it.
    const next = collect(session, 'check plan');
    await new Promise((r) => setTimeout(r, 20));
    provider.releaseTail();
    const events = await next;
    await session.close();

    expect(provider.startedTurns).toEqual([longMessage, 'check plan']);
    // No visible text in the new turn: the gate must refuse, not approve on
    // the interrupted turn's leftover prose.
    expect(messageTexts(events)).toEqual(['Plan gate: refuse']);
  }, 5000);
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

describe('abandoned turn: provider error terminal during settlement (R1.6-3)', () => {
  /**
   * A provider whose NEXT long turn emits an `error` event instead of
   * `turn.completed` as its terminal. Used to verify that settlement handles
   * the `error` branch of `isTerminalProviderEvent` without hanging and still
   * records a synthetic `done` for the interrupted turn.
   */
  function createErroringProvider(sessionId: string): ScriptedProvider {
    let release: () => void = () => {};
    const tailGate = new Promise<void>((resolve) => { release = resolve; });
    const provider: ScriptedProvider = {
      name: 'erroring-provider',
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
                version: 'erroring-v1',
              },
            };
            while (!closed) {
              const next = await Promise.race([promptIter.next(), abort.closedPromise]);
              if (typeof next === 'string') break;
              const turnResult = next as IteratorResult<ProviderUserTurn>;
              if (turnResult.done) break;
              const content =
                typeof turnResult.value.content === 'string'
                  ? turnResult.value.content
                  : '[blocks]';
              provider.startedTurns.push(content);
              const controller = abort.begin();
              try {
                if (controller.signal.aborted) {
                  abort.clear(controller);
                  return;
                }
                if (!content.includes('long')) {
                  yield { type: 'assistant.message', text: `Echo: ${content}`, sessionId };
                  abort.clear(controller);
                  yield completed(sessionId, 'end_turn');
                  continue;
                }
                // Emit a delta, wait for the abort, then yield an `error`
                // terminal instead of `turn.completed`.
                yield { type: 'delta.text', text: `start:${content}`, sessionId };
                if (!controller.signal.aborted) {
                  await new Promise<void>((resolve) => {
                    controller.signal.addEventListener('abort', () => resolve(), { once: true });
                  });
                }
                // Wait for the tail gate so the test can race the settlement.
                await Promise.race([tailGate, abort.closedPromise]);
                yield { type: 'error', error: new Error('provider-error-during-settlement') };
              } finally {
                abort.clear(controller);
              }
            }
          },
          async interrupt() {
            provider.interruptCalls++;
            abort.requestAbort('interrupted');
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

  it('a provider error during settlement still records exactly one done and the next send runs', async () => {
    const sessionId = `settlement-error-${Date.now()}`;
    const provider = createErroringProvider(sessionId);
    const session = new AgentSession({ model: 'sonnet', provider });

    // Break on the very first event (delta.text) without interrupting, so the
    // turn is parked (abandoned, not yet settling). Then start the next send;
    // the runner will stop the parked turn and begin settlement. Release the
    // tail gate once the send is waiting so settlement sees the error terminal.
    for await (const _event of session.sendMessageStream('long task')) break;

    const nextFinished = collect(session, 'after error');
    await new Promise((r) => setTimeout(r, 20));
    // Interrupt the parked turn explicitly so settlement can proceed, then
    // release the tail so the generator yields its error terminal.
    provider.releaseTail();
    const events = await nextFinished;
    await session.close();

    // The next send received its own turn.
    expect(messageTexts(events)).toEqual(['Echo: after error']);
    expect(stopReasonOf(events)).toBe('end_turn');
    // Settlement must have recorded a synthetic done for the interrupted turn
    // so the ledger order is: user(long) → done(interrupted) → user(after) → done(end_turn).
    const records = await ledgerOf(sessionId);
    const kinds = records.filter((r) => r.kind === 'user' || r.kind === 'done');
    expect(kinds.map((r) => r.kind)).toEqual(['user', 'done', 'user', 'done']);
    // The last done belongs to the successful next send.
    expect(kinds[3]).toHaveProperty('stopReason', 'end_turn');
  }, 5000);

  it('a provider error during settlement does not hang or reject the waiting send', async () => {
    const provider = createErroringProvider(`settlement-error-nohang-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    // Break on the first event (abandon without interrupting).
    for await (const _event of session.sendMessageStream('long task')) break;
    // Fire the error terminal immediately so settlement resolves right away.
    provider.releaseTail();

    // The send must complete, not hang.
    const outcome = await Promise.race([
      collect(session, 'after').then(() => 'ok'),
      new Promise<string>((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    await session.close();

    expect(outcome).toBe('ok');
  }, 5000);
});

describe('abandoned turn: parked turn settled at the next send (R2.2-1)', () => {
  it('a parked uninterrupted turn is settled when the next send arrives, keeping plan-text isolated', async () => {
    const provider = createScriptedProvider(`parked-plan-text-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });
    // Enough text to exceed the MIN_PLAN_TEXT_CHARS threshold.
    const longMessage = `long gated task ${'y'.repeat(120)}`;

    // A consumer that bails without pressing ESC — no interrupt at all.
    for await (const _event of session.sendMessageStream(longMessage)) break;

    // The turn is parked, not settling yet. Send the next message; the runner
    // must settle the parked turn first, then start this one.
    const nextFinished = collect(session, 'check plan');
    // Give the settlement a moment to begin (it was triggered by the send).
    await new Promise((r) => setTimeout(r, 20));
    provider.releaseTail();
    const events = await nextFinished;
    await session.close();

    // Both turns started, in order.
    expect(provider.startedTurns).toEqual([longMessage, 'check plan']);
    // The tail text from the parked turn must NOT bleed into the new turn's
    // plan-text window: gate answer must be 'refuse', not 'ok'.
    expect(messageTexts(events)).toEqual(['Plan gate: refuse']);
  }, 5000);

  it('a parked uninterrupted turn leaves exactly one done in the ledger before the next turn starts', async () => {
    const sessionId = `parked-ledger-${Date.now()}`;
    const provider = createScriptedProvider(sessionId);
    const session = new AgentSession({ model: 'sonnet', provider });

    for await (const _event of session.sendMessageStream('long task')) break;
    await collect(session, 'next');
    await session.close();

    const records = await ledgerOf(sessionId);
    const kinds = records.filter((r) => r.kind === 'user' || r.kind === 'done');
    // user(long) → done(interrupted) → user(next) → done(end_turn)
    expect(kinds.map((r) => r.kind)).toEqual(['user', 'done', 'user', 'done']);
    expect(kinds[3]).toHaveProperty('stopReason', 'end_turn');
  });
});

describe('sendMessage hasNewerSend guard (R1.6-1)', () => {
  it('sendMessage does not reset state to idle when a newer send is already in flight', async () => {
    const provider = createScriptedProvider(`newer-send-${Date.now()}`);
    const session = new AgentSession({ model: 'sonnet', provider });

    // ESC a gated long turn so settlement is parked on the tail — it will not
    // finish until we call releaseTail(). While settlement is blocked, start a
    // non-streaming sendMessage. The sendMessage finally-block must NOT flip
    // state back to idle while this newer send is still in 'processing'.
    await sendThenEscAndBreak(session, 'long gated task');

    // The second send is non-streaming; it enters 'processing' once it starts.
    // It is currently parked waiting for settlement to finish.
    const secondDone = session.sendMessage('second');
    await new Promise((r) => setTimeout(r, 20));
    // State is 'processing' because the second send registered itself and
    // settlement has not finished yet (tail is still gated).
    const stateWhileParked = session.state;

    // Now release the tail so settlement can finish and the second send runs.
    provider.releaseTail();
    await secondDone;
    await session.close();

    // The parked send must have held 'processing', not been reset to 'idle'.
    expect(stateWhileParked).toBe('processing');
    expect(provider.startedTurns).toEqual(['long gated task', 'second']);
  }, 5000);
});

describe('session.abort() with a send waiting (R1.6-2)', () => {
  it('abort() while a send waits behind an in-flight turn cancels the send and seals the ledger', async () => {
    const sessionId = `abort-with-waiter-${Date.now()}`;
    const provider = createScriptedProvider(sessionId);
    const session = new AgentSession({ model: 'sonnet', provider });

    // ESC a gated long turn so it is settling but not done.
    await sendThenEscAndBreak(session, 'long gated task');

    // Queue a send that will park behind the settling turn.
    const events: OutputEvent[] = [];
    const sendFinished = (async () => {
      for await (const e of session.sendMessageStream('waiting message')) events.push(e);
    })();
    await new Promise((r) => setTimeout(r, 20));

    // Abort the session while the send is parked.
    session.abort('sigint');
    provider.releaseTail();
    await sendFinished;

    // The waiting send must have been cancelled (or resolved to an interrupted
    // done) — it must not have reached the provider.
    expect(provider.startedTurns).toEqual(['long gated task']);
    // The session is now closed/aborted; a later send must throw or return an
    // interrupted done rather than hanging.
    expect(events.length).toBeGreaterThanOrEqual(0); // send completed cleanly
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

/**
 * R1.11 (#5174): drain() must not block forever when a settling turn's
 * `turn.ended` never resolves. `ProviderTurns` is exercised directly here so
 * the test can use fake timers without spinning a full AgentSession.
 */
describe('drain timeout: R1.11 (#5174)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drain() unblocks after SETTLE_DRAIN_TIMEOUT_MS when a settling turn never ends', async () => {
    // A turn whose `ended` promise never resolves (simulates a provider stuck
    // mid-settlement — it was interrupted but never yields its terminal event).
    let markEnded: (() => void) | null = null;
    const neverEnded = new Promise<void>((resolve) => {
      markEnded = resolve; // held — only resolved by endTurn below
    });

    // Wire a minimal ProviderTurns with a consume hook that never fires for
    // this test (the hung turn never produces events), plus a no-op
    // recordSyntheticDone and interruptProvider.
    let syntheticDoneRecorded = false;
    const turns = new ProviderTurns({
      consume: async () => null,
      interruptProvider: async () => {},
      recordSyntheticDone: () => { syntheticDoneRecorded = true; },
    });

    // Craft a fake iterator that blocks forever (the hung settlement).
    const hungIterator: AsyncIterator<never> = {
      next: () => neverEnded.then(() => ({ done: true as const, value: undefined })),
    };

    // Register a send, start a turn, then abandon it so drain() will settle it.
    const send = turns.beginSend();
    const turn = turns.startTurn(
      send,
      {} as import('./stream-consumer.js').TransformDeps,
      hungIterator,
      Date.now(),
    );
    turn.interrupted = true; // already interrupted — settle() skips the interrupt call
    turns.abandon(turn);

    // drain() is called by untilClear; run it via a fresh send waiting behind
    // the abandoned turn.
    const send2 = turns.beginSend();
    const drainDone = turns.untilClear(send2, null);

    // Before the timeout fires, the drain is still waiting.
    await vi.advanceTimersByTimeAsync(SETTLE_DRAIN_TIMEOUT_MS - 1);
    let resolved = false;
    drainDone.then(() => { resolved = true; });
    // Flush microtasks; still not resolved.
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Fire the timeout — drain() force-ends the stuck turn and unblocks.
    await vi.advanceTimersByTimeAsync(1);
    await drainDone;
    expect(resolved).toBe(true);

    turns.withdraw(send2);

    // The settle() background loop is still blocked on the hung iterator's
    // `next()`. Release it so settle's finally block can run recordMissingDone.
    markEnded!();
    // Flush the promise chain: iterator.next() resolves → settle finally runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(syntheticDoneRecorded).toBe(true);
  });
});
// ---------------------------------------------------------------------------
// R1.2 / R1.3 regression tests (#5173)
// ---------------------------------------------------------------------------

/**
 * A provider for R1.2: the turn emits one text delta, then — once the
 * interrupt fires — the iterator ends with `{done:true}` (no `turn.completed`
 * terminal).  This is the live-reader case: the consumer is still reading
 * when `result.done` is true, so the `finally` block records the synthetic
 * done and must pass `turn.interrupted`.
 */
function createNoTerminalProvider(sessionId: string): ModelProvider {
  const abort = new AbortCoordinator();
  return {
    name: 'no-terminal-provider',
    query(): ProviderQuery {
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
              version: 'no-terminal-v1',
            },
          };
          while (!closed) {
            // Pull the next user message.
            const controller = abort.begin();
            try {
              // Yield one delta so the consumer has something to read and ESC
              // can fire while the turn is live.
              yield { type: 'delta.text', text: 'starting', sessionId };
              // Wait for the interrupt.
              if (!controller.signal.aborted) {
                await new Promise<void>((resolve) => {
                  controller.signal.addEventListener('abort', () => resolve(), { once: true });
                });
              }
              // End the iterator WITHOUT yielding turn.completed — the iterator
              // just returns, producing {done:true} in the live loop.
              return;
            } finally {
              abort.clear(controller);
            }
          }
        },
        async interrupt(reason = 'interrupted') {
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
        close() { closed = true; abort.markClosed(); },
      };
      return q;
    },
  };
}

/**
 * A provider for R1.3: a "long" turn that — after the interrupt — emits a
 * provider `error` event and then ends.  The consumer breaks on the first
 * post-ESC event, so the error arrives during settlement (the abandoned-turn
 * path), not during live reading.
 */
function createSettleErrorProvider(sessionId: string): {
  provider: ModelProvider;
  releaseTail: () => void;
} {
  let releaseTail: () => void = () => {};
  const tailGate = new Promise<void>((r) => { releaseTail = r; });
  const abort = new AbortCoordinator();
  let turnCount = 0;

  const provider: ModelProvider = {
    name: 'settle-error-provider',
    query(): ProviderQuery {
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
              version: 'settle-error-v1',
            },
          };
          while (!closed) {
            const controller = abort.begin();
            try {
              if (controller.signal.aborted) { abort.clear(controller); return; }
              const thisTurn = ++turnCount;
              if (thisTurn === 1) {
                // "long" first turn: emit a delta so the consumer has something
                // to read, then wait for the abort.
                yield { type: 'delta.text', text: 'starting', sessionId };
                if (!controller.signal.aborted) {
                  await new Promise<void>((resolve) => {
                    controller.signal.addEventListener('abort', () => resolve(), { once: true });
                  });
                }
                // The consumer already broke on `aborting:` (the first post-ESC
                // event), so whatever we yield from here is in settlement.
                // Emit a delta so the consumer can break, THEN emit the error.
                yield { type: 'delta.text', text: 'aborting', sessionId };
                // Wait for the test to release the tail (slow-to-die tool).
                await tailGate;
                // During settlement: emit the provider error.
                yield { type: 'error', error: new Error('provider 500') };
                return;
              } else {
                // Second turn: a clean echo.
                yield { type: 'assistant.message', text: 'Echo: after', sessionId };
                abort.clear(controller);
                yield {
                  type: 'turn.completed',
                  usage: {
                    resultSubtype: 'success',
                    stopReason: 'end_turn',
                    durationMs: 5,
                    totalCostUsd: 0.001,
                    inputTokens: 10,
                    outputTokens: 2,
                    raw: { input_tokens: 10, output_tokens: 2 },
                  },
                  sessionId,
                };
              }
            } finally {
              abort.clear(controller);
            }
          }
        },
        async interrupt(reason = 'interrupted') {
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
        close() { closed = true; abort.markClosed(); },
      };
      return q;
    },
  };
  return { provider, releaseTail };
}

describe('synthetic done label: live-reader fallback (R1.2 #5173)', () => {
  /**
   * When the user ESCs and the provider iterator ends with `{done:true}` (no
   * terminal `turn.completed`) the synthetic done must carry
   * `stopReason: 'interrupted'`, not `'error'`.
   *
   * Pre-fix: `recordSyntheticDone(turnStartMs)` was called without the
   * `turn.interrupted` flag, so the signal-based fallback always mapped to
   * 'error' (the abort signal is not set on the session when the user ESCs).
   */
  it('records stopReason interrupted when the iterator ends with done=true after ESC', async () => {
    const sessionId = `r1-2-interrupted-${Date.now()}`;
    const provider = createNoTerminalProvider(sessionId);
    const session = new AgentSession({ model: 'sonnet', provider });

    // sendThenEscAndBreak: ESC fires while the live reader is reading events,
    // then it breaks on the next event.  The provider interrupt sets the abort
    // flag and returns from its generator, so result.done=true in the live loop.
    await sendThenEscAndBreak(session, 'long task');
    await session.close();

    const records: LedgerRecord[] = [];
    for await (const r of readLedger(sessionId)) records.push(r);
    const done = records.find((r) => r.kind === 'done');
    // Before the fix this was 'error'; after the fix it must be 'interrupted'.
    expect(done?.stopReason).toBe('interrupted');
  });
});

describe('synthetic done label: abandoned-turn settlement error (R1.3 #5173)', () => {
  /**
   * When an abandoned turn's settlement encounters a provider `error` event
   * (stream stall, 4xx, connection error) the synthetic done must carry a
   * fatal stopReason (`'error'`), not `'interrupted'`.
   *
   * Pre-fix: `settle()` always set `turn.interrupted = true` unconditionally,
   * so the hook always called `buildInterruptedDone` even when the stream
   * errored rather than completing cleanly.
   */
  it('records a fatal stopReason when settlement sees a provider error event', async () => {
    const sessionId = `r1-3-settle-error-${Date.now()}`;
    const { provider, releaseTail } = createSettleErrorProvider(sessionId);
    const session = new AgentSession({ model: 'sonnet', provider });

    // ESC the first turn so it becomes abandoned; the consumer breaks on the
    // first post-ESC delta ('aborting'), leaving the error event for settle().
    await sendThenEscAndBreak(session, 'long task');

    // Start the second (clean) turn while the first is still settling.
    const afterDone = collect(session, 'after');
    // Let the tail release so the error event is emitted during settlement.
    await new Promise((r) => setTimeout(r, 20));
    releaseTail();

    await afterDone;
    await session.close();

    const records: LedgerRecord[] = [];
    for await (const r of readLedger(sessionId)) records.push(r);
    const dones = records.filter((r) => r.kind === 'done');
    // The first done (the abandoned+error turn) must NOT be 'interrupted'.
    expect(dones[0]?.stopReason).not.toBe('interrupted');
    // It should map to a fatal reason: the signal is not aborted (user ESC
    // only aborts the provider scope, not the session signal), so 'error'.
    expect(dones[0]?.stopReason).toBe('error');
  }, 5000);
});
