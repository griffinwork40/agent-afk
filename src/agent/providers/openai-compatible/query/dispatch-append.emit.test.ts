/**
 * Unit tests for emitDispatchedToolOutputs.
 *
 * Covers the core behaviours:
 *   - yields one tool.output event per call
 *   - prepends parse-error diagnostics and marks isError=true
 *   - yields a tool.diff event when result.render.diff is present
 *   - plumbs isError, batchIndex/batchSize, failureClass, and exitCode
 *   - pushes { call, result } pairs into the results array
 *
 * traceWriter is passed as undefined so the emitToolCall fire-and-forget
 * path is a no-op; the test focuses on the generator's yielded events.
 */

import { describe, it, expect } from 'vitest';
import { emitDispatchedToolOutputs } from './dispatch-append.emit.js';
import type { ToolCall, ToolResult } from '../../anthropic-direct/types.js';
import type { ProviderEvent } from '../../../provider.js';

function makeCall(id: string, name = 'bash'): ToolCall {
  return { id, name, input: {} };
}

function makeResult(content: string, extras: Partial<ToolResult> = {}): ToolResult {
  return { content, ...extras };
}

async function collect(
  gen: AsyncGenerator<ProviderEvent, void>,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('emitDispatchedToolOutputs', () => {
  it('yields one tool.output per call and pushes into results', async () => {
    const calls = [makeCall('c1'), makeCall('c2')];
    const dispatcherResults = [makeResult('output A'), makeResult('output B')];
    const results: { call: ToolCall; result: ToolResult }[] = [];

    const events = await collect(
      emitDispatchedToolOutputs({
        calls,
        dispatcherResults,
        parseErrors: new Map(),
        startTimes: new Map(),
        traceWriter: undefined,
        subagentId: undefined,
        sessionId: 'sess-1',
        results,
      }),
    );

    const toolOutputs = events.filter((e) => e.type === 'tool.output');
    expect(toolOutputs).toHaveLength(2);
    expect(toolOutputs[0]).toMatchObject({ type: 'tool.output', toolUseId: 'c1', content: 'output A' });
    expect(toolOutputs[1]).toMatchObject({ type: 'tool.output', toolUseId: 'c2', content: 'output B' });
    expect(results).toHaveLength(2);
    expect(results[0]?.call.id).toBe('c1');
    expect(results[1]?.call.id).toBe('c2');
  });

  it('prepends parse-error diagnostics and sets isError=true', async () => {
    const calls = [makeCall('c1')];
    const dispatcherResults = [makeResult('original output')];
    const results: { call: ToolCall; result: ToolResult }[] = [];

    const events = await collect(
      emitDispatchedToolOutputs({
        calls,
        dispatcherResults,
        parseErrors: new Map([['c1', 'bad JSON']]),
        startTimes: new Map(),
        traceWriter: undefined,
        subagentId: undefined,
        sessionId: 'sess-1',
        results,
      }),
    );

    const out = events.find((e) => e.type === 'tool.output');
    expect(out).toBeDefined();
    // isError is spread from the modified result
    expect((out as { isError?: boolean }).isError).toBe(true);
    // The content should contain both the parse error and the original output
    expect((out as { content: string }).content).toContain('bad JSON');
    expect((out as { content: string }).content).toContain('original output');
  });

  it('yields a tool.diff event when result.render.diff is present', async () => {
    const calls = [makeCall('c1', 'edit_file')];
    const dispatcherResults = [makeResult('ok', { render: { diff: '--- a\n+++ b\n' } })];
    const results: { call: ToolCall; result: ToolResult }[] = [];

    const events = await collect(
      emitDispatchedToolOutputs({
        calls,
        dispatcherResults,
        parseErrors: new Map(),
        startTimes: new Map(),
        traceWriter: undefined,
        subagentId: undefined,
        sessionId: 'sess-1',
        results,
      }),
    );

    expect(events.some((e) => e.type === 'tool.diff')).toBe(true);
    const diff = events.find((e) => e.type === 'tool.diff');
    expect((diff as { diff: string }).diff).toContain('--- a');
  });

  it('plumbs batchIndex, batchSize, failureClass, and exitCode', async () => {
    const calls = [makeCall('c1')];
    const dispatcherResults = [
      makeResult('out', {
        batchIndex: 2,
        batchSize: 4,
        failureClass: 'policy-block',
        exitCode: 1,
      }),
    ];
    const results: { call: ToolCall; result: ToolResult }[] = [];

    const events = await collect(
      emitDispatchedToolOutputs({
        calls,
        dispatcherResults,
        parseErrors: new Map(),
        startTimes: new Map(),
        traceWriter: undefined,
        subagentId: undefined,
        sessionId: 'sess-1',
        results,
      }),
    );

    const out = events.find((e) => e.type === 'tool.output') as Record<string, unknown> | undefined;
    expect(out?.batchIndex).toBe(2);
    expect(out?.batchSize).toBe(4);
    expect(out?.failureClass).toBe('policy-block');
    expect(out?.exitCode).toBe(1);
  });
});
