/**
 * Tests for `recordBootWarning` (#754).
 *
 * The critical property under test is PUSH-TIME emission: the durable
 * `boot_warning` trace event must land in the writer synchronously as part
 * of calling `recordBootWarning`, not at some later drain point — because on
 * the abort path (bootstrap throws after a producer already warned) no drain
 * site is ever reached. If emission were deferred past the call, a
 * synchronous throw right after `recordBootWarning` would race it.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryTraceWriter } from '../../../agent/trace/writer.js';
import { recordBootWarning } from './boot-warning-recorder.js';

function bootWarningEvents(writer: InMemoryTraceWriter) {
  return writer.events.filter(
    (e) => e.kind === 'session_phase' && e.payload.phase === 'boot_warning',
  );
}

describe('recordBootWarning', () => {
  it('pushes onto the caller-owned bootWarnings array (unchanged terminal behavior)', () => {
    const bootWarnings: string[] = [];
    const writer = new InMemoryTraceWriter();
    recordBootWarning({
      bootWarnings,
      traceWriter: writer,
      producer: 'mcp',
      message: '[mcp] server "foo": unknown key "cmd"',
    });
    expect(bootWarnings).toEqual(['[mcp] server "foo": unknown key "cmd"']);
  });

  it('emits a boot_warning trace event carrying producer + message metadata', () => {
    const writer = new InMemoryTraceWriter();
    recordBootWarning({
      bootWarnings: [],
      traceWriter: writer,
      producer: 'agent-registry',
      message: '~/.afk/agents/research-agent.md overrides built-in agent "research-agent"',
    });
    const events = bootWarningEvents(writer);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      phase: 'boot_warning',
      metadata: {
        producer: 'agent-registry',
        message: '~/.afk/agents/research-agent.md overrides built-in agent "research-agent"',
      },
    });
  });

  it('records the event even when the caller throws immediately afterward (abort path, #754)', () => {
    // Simulates the real shape: `agentRegistryWarn`/the MCP warnings loop call
    // `recordBootWarning`, and a LATER bootstrap phase throws before either
    // terminal-facing drain site (`interactive.ts`) can run. Because emission
    // happens synchronously at push time — not deferred to a drain — the
    // event is already durable by the time the throw unwinds the stack.
    const writer = new InMemoryTraceWriter();
    const bootWarnings: string[] = [];
    expect(() => {
      recordBootWarning({
        bootWarnings,
        traceWriter: writer,
        producer: 'mcp',
        message: '[mcp] server "foo" (alwaysLoad) failed to connect',
      });
      throw new Error('bootstrap aborted: mcp server "foo" failed to connect');
    }).toThrow('bootstrap aborted');

    // The throw propagated (abort path taken) — the array is even orphaned
    // now (nothing will ever drain it) — but the trace event is durable.
    const events = bootWarningEvents(writer);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.metadata?.['message']).toBe(
      '[mcp] server "foo" (alwaysLoad) failed to connect',
    );
  });

  it('never throws when traceWriter is undefined (tracing disabled)', () => {
    const bootWarnings: string[] = [];
    expect(() =>
      recordBootWarning({
        bootWarnings,
        traceWriter: undefined,
        producer: 'mcp',
        message: '[mcp] no writer',
      }),
    ).not.toThrow();
    expect(bootWarnings).toEqual(['[mcp] no writer']);
  });

  it('emits one event per warning — never aggregated', () => {
    const writer = new InMemoryTraceWriter();
    const bootWarnings: string[] = [];
    recordBootWarning({ bootWarnings, traceWriter: writer, producer: 'mcp', message: 'a' });
    recordBootWarning({ bootWarnings, traceWriter: writer, producer: 'mcp', message: 'b' });
    expect(bootWarningEvents(writer)).toHaveLength(2);
    expect(bootWarnings).toEqual(['a', 'b']);
  });
});
