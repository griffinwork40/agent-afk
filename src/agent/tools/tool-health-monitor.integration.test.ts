/**
 * Integration tests: ToolHealthMonitor wired into SessionToolDispatcher.
 *
 * Verifies that a dispatcher running a repeatedly-failing tool:
 *   1. Produces the [tool-health] notice in the tool result content.
 *   2. Emits exactly ONE `tool_degraded` session_phase trace event
 *      (dedup: subsequent calls do NOT emit additional events).
 *   3. Does not alter `isError`.
 *   4. Leaves successful results untouched.
 *
 * Uses InMemoryTraceWriter to capture trace events without filesystem I/O.
 *
 * @module agent/tools/tool-health-monitor.integration.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionToolDispatcher } from './dispatcher.js';
import { builtinToolSchemas } from './schemas.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import type { ToolCall } from './types.js';
import type { ToolHandler } from './types.js';
import { HEALTH_MIN_SAMPLE } from './tool-health-monitor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ABORT = new AbortController().signal;

let _callSeq = 0;

/**
 * Make a unique call each time, varying the input so the repeat circuit breaker
 * (which fingerprints on toolName+input) and the repeat-failure guard (which
 * fingerprints on normalized toolName+input) never fire — we want to exercise
 * the health monitor, not the circuit breakers.
 */
function makeCall(name: string, input?: unknown): ToolCall {
  const seq = ++_callSeq;
  return {
    id: `call-${name}-${seq}`,
    name,
    input: input ?? { _seq: seq }, // unique input per call
    signal: ABORT,
  };
}

function alwaysFailHandler(msg = 'fetch failed: connect ECONNREFUSED'): ToolHandler {
  return async () => ({ content: msg, isError: true });
}

function alwaysOkHandler(): ToolHandler {
  return async () => ({ content: 'ok' });
}

function makeDispatcher(traceWriter?: InMemoryTraceWriter) {
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([
      ['failing_tool', alwaysFailHandler()],
      ['ok_tool', alwaysOkHandler()],
    ]),
    schemas: [...builtinToolSchemas],
    permissions: { allowedTools: ['failing_tool', 'ok_tool'] },
    ...(traceWriter ? { traceWriter } : {}),
  });
}

function toolDegradedEvents(writer: InMemoryTraceWriter) {
  return writer.events.filter(
    (e) => e.kind === 'session_phase' && (e.payload as any).phase === 'tool_degraded',
  );
}

// ---------------------------------------------------------------------------
// Core integration scenarios
// ---------------------------------------------------------------------------

describe('ToolHealthMonitor integration (dispatcher)', () => {
  let writer: InMemoryTraceWriter;
  let dispatcher: SessionToolDispatcher;

  beforeEach(() => {
    _callSeq = 0;
    writer = new InMemoryTraceWriter();
    dispatcher = makeDispatcher(writer);
  });

  it('produces the [tool-health] notice in result content on triggering call', async () => {
    // Drive HEALTH_MIN_SAMPLE failures — the last one should contain the notice.
    let lastResult = await dispatcher.execute(makeCall('failing_tool'));
    for (let i = 1; i < HEALTH_MIN_SAMPLE; i++) {
      lastResult = await dispatcher.execute(makeCall('failing_tool'));
    }
    expect(lastResult.isError).toBe(true);
    expect(lastResult.content).toContain('[tool-health]');
    expect(lastResult.content).toContain('failing_tool');
    expect(lastResult.content).toContain('Stop retrying it');
  });

  it('emits exactly ONE tool_degraded trace event for repeated same-error failures', async () => {
    // Drive more than HEALTH_MIN_SAMPLE failures to verify dedup.
    for (let i = 0; i < HEALTH_MIN_SAMPLE + 4; i++) {
      await dispatcher.execute(makeCall('failing_tool'));
    }
    // Give the fire-and-forget emission a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    const events = toolDegradedEvents(writer);
    expect(events).toHaveLength(1);
  });

  it('emitted trace event has the correct payload shape', async () => {
    for (let i = 0; i < HEALTH_MIN_SAMPLE; i++) {
      await dispatcher.execute(makeCall('failing_tool'));
    }
    await new Promise((r) => setTimeout(r, 10));
    const events = toolDegradedEvents(writer);
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as any;
    expect(payload.phase).toBe('tool_degraded');
    expect(payload.metadata).toBeDefined();
    expect(payload.metadata.tool).toBe('failing_tool');
    expect(typeof payload.metadata.errorHead).toBe('string');
    expect(payload.metadata.errorCount).toBeGreaterThanOrEqual(HEALTH_MIN_SAMPLE);
    expect(payload.metadata.callCount).toBeGreaterThanOrEqual(HEALTH_MIN_SAMPLE);
  });

  it('does NOT alter isError — it stays true on a degraded result', async () => {
    for (let i = 0; i < HEALTH_MIN_SAMPLE; i++) {
      const result = await dispatcher.execute(makeCall('failing_tool'));
      expect(result.isError).toBe(true);
    }
  });

  it('leaves successful results untouched (no notice appended)', async () => {
    // First trigger degradation
    for (let i = 0; i < HEALTH_MIN_SAMPLE; i++) {
      await dispatcher.execute(makeCall('failing_tool'));
    }
    // A success on ok_tool should be pristine
    const okResult = await dispatcher.execute(makeCall('ok_tool'));
    expect(okResult.content).toBe('ok');
    expect(okResult.content).not.toContain('[tool-health]');
    expect(okResult.isError).toBeUndefined();
  });

  it('notice is suppressed on subsequent failing calls (no spam)', async () => {
    const noticeResults: string[] = [];
    for (let i = 0; i < HEALTH_MIN_SAMPLE + 5; i++) {
      const result = await dispatcher.execute(makeCall('failing_tool'));
      if (result.content.includes('[tool-health]')) noticeResults.push(result.content);
    }
    // Notice should appear exactly once (on the triggering call)
    expect(noticeResults).toHaveLength(1);
  });

  it('emits no trace event when fewer than HEALTH_MIN_SAMPLE calls are made', async () => {
    for (let i = 0; i < HEALTH_MIN_SAMPLE - 1; i++) {
      await dispatcher.execute(makeCall('failing_tool'));
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(toolDegradedEvents(writer)).toHaveLength(0);
  });

  it('does NOT emit a trace event when no traceWriter is configured', async () => {
    // Should not throw even without a trace writer
    const noTraceDispatcher = makeDispatcher(/* no writer */);
    let threw = false;
    try {
      for (let i = 0; i < HEALTH_MIN_SAMPLE; i++) {
        await noTraceDispatcher.execute(makeCall('failing_tool'));
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // writer was never attached — toolDegradedEvents on a separate writer stays empty
    await new Promise((r) => setTimeout(r, 10));
    expect(toolDegradedEvents(writer)).toHaveLength(0);
  });

  it('notice mention includes the dominant errorHead text', async () => {
    // Use a dispatcher with a custom error message
    const customWriter = new InMemoryTraceWriter();
    const customDispatcher = new SessionToolDispatcher({
      handlers: new Map<string, ToolHandler>([
        [
          'flaky_tool',
          alwaysFailHandler('SSL: CERTIFICATE_VERIFY_FAILED — cert expired'),
        ],
      ]),
      schemas: [...builtinToolSchemas],
      permissions: { allowedTools: ['flaky_tool'] },
      traceWriter: customWriter,
    });
    let lastResult = await customDispatcher.execute(makeCall('flaky_tool'));
    for (let i = 1; i < HEALTH_MIN_SAMPLE; i++) {
      lastResult = await customDispatcher.execute(makeCall('flaky_tool'));
    }
    // The notice should include at least the start of the errorHead
    expect(lastResult.content).toContain('[tool-health]');
    expect(lastResult.content).toContain('SSL');
  });
});
