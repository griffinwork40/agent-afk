/**
 * Witness-layer tests for the `interrupt_halt` session_phase (Deliverable B).
 *
 * The event records interrupt→halt latency: the wall-clock from the turn
 * signal firing (ESC soft-stop → `interrupt()` aborts with reason
 * `'interrupted'`) to the terminal `turn.completed` being emitted on the abort
 * path. It is the field-visible proof the ESC-lag fix keeps the halt within an
 * event-loop turn. These tests assert it fires on interrupt, carries a
 * non-negative durationMs, is tagged with the provider, and is ABSENT on a
 * clean turn and on a session close (reason `'closed'`).
 */

import { describe, it, expect } from 'vitest';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import type { AnthropicClientLike } from './types.js';
import { InMemoryTraceWriter } from '../../trace/writer.js';
import {
  fromArray,
  collect,
  ctx,
  makeTextStream,
  makeClient,
  makeDispatcher,
} from './loop.test-helpers.js';

function makeAbortError(): Error {
  const e = new Error('Request was aborted.');
  e.name = 'AbortError';
  return e;
}

/** Settle the fire-and-forget emit microtasks before asserting. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function interruptHaltEvents(writer: InMemoryTraceWriter): Array<{ durationMs?: number; metadata?: Record<string, unknown> }> {
  return writer.events
    .filter(
      (e) =>
        e.kind === 'session_phase' &&
        (e.payload as { phase: string }).phase === 'interrupt_halt',
    )
    .map((e) => e.payload as { durationMs?: number; metadata?: Record<string, unknown> });
}

describe('loop.ts runTurn — interrupt_halt session_phase', () => {
  it('emits interrupt_halt with a non-negative durationMs when the turn is interrupted mid-stream', async () => {
    const writer = new InMemoryTraceWriter();
    const ac = new AbortController();

    // The stream self-interrupts (as the REPL's ESC soft-stop does) then the
    // request aborts — the SDK throws AbortError. loop.ts breaks on the in-band
    // error while signal.aborted and emits a single terminal turn.completed.
    const client: AnthropicClientLike = {
      messages: {
        create: () =>
          (async function* (): AsyncGenerator<RawMessageStreamEvent> {
            ac.abort('interrupted');
            throw makeAbortError();
          })(),
      },
    };

    const events = await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'do a long thing' }],
        system: null,
        tools: [],
        toolDispatcher: makeDispatcher(async () => ({ content: '', isError: false })),
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: ac.signal,
        ctx,
        traceWriter: writer,
      }),
    );
    await flush();

    // The turn still ends with exactly one terminal turn.completed (the ESC-lag
    // single-terminal guarantee) — and no error event leaked.
    const terminals = events.filter((e) => e.type === 'turn.completed' || e.type === 'error');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.type).toBe('turn.completed');

    const halts = interruptHaltEvents(writer);
    expect(halts).toHaveLength(1);
    expect(halts[0]!.durationMs).toBeTypeOf('number');
    expect(halts[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(halts[0]!.metadata).toMatchObject({ provider: 'anthropic-direct' });
  });

  it('does NOT emit interrupt_halt on a clean (non-interrupted) turn', async () => {
    const writer = new InMemoryTraceWriter();
    const client = makeClient(() => fromArray(makeTextStream('all done', 'end_turn')));

    await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'hello' }],
        system: null,
        tools: [],
        toolDispatcher: makeDispatcher(async () => ({ content: '', isError: false })),
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        traceWriter: writer,
      }),
    );
    await flush();

    expect(interruptHaltEvents(writer)).toHaveLength(0);
  });

  it('does NOT emit interrupt_halt when the turn signal aborts with reason "closed" (session close, not an ESC halt)', async () => {
    const writer = new InMemoryTraceWriter();
    const ac = new AbortController();

    // close() aborts the per-turn signal with reason 'closed'. loop.ts still
    // yields a terminal turn.completed on the abort path, but this is a session
    // teardown — NOT an interrupt-halt-latency event, so it must be excluded.
    const client: AnthropicClientLike = {
      messages: {
        create: () =>
          (async function* (): AsyncGenerator<RawMessageStreamEvent> {
            ac.abort('closed');
            throw makeAbortError();
          })(),
      },
    };

    await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'x' }],
        system: null,
        tools: [],
        toolDispatcher: makeDispatcher(async () => ({ content: '', isError: false })),
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: ac.signal,
        ctx,
        traceWriter: writer,
      }),
    );
    await flush();

    expect(interruptHaltEvents(writer)).toHaveLength(0);
  });

  it('emits no interrupt_halt when no trace writer is wired (interrupt still handled)', async () => {
    const writer = new InMemoryTraceWriter();
    const ac = new AbortController();
    const client: AnthropicClientLike = {
      messages: {
        create: () =>
          (async function* (): AsyncGenerator<RawMessageStreamEvent> {
            ac.abort('interrupted');
            throw makeAbortError();
          })(),
      },
    };

    const events = await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'x' }],
        system: null,
        tools: [],
        toolDispatcher: makeDispatcher(async () => ({ content: '', isError: false })),
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: ac.signal,
        ctx,
        // traceWriter omitted intentionally — a no-trace session must not crash
        // and simply records nothing.
      }),
    );
    await flush();

    // Still exactly one terminal, and the standalone writer we never passed in
    // saw nothing.
    const terminals = events.filter((e) => e.type === 'turn.completed' || e.type === 'error');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.type).toBe('turn.completed');
    expect(writer.events).toHaveLength(0);
  });
});
