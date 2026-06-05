/**
 * Integration test for the render-registry → ToolResultChunk → renderer
 * pipeline.
 *
 * Regression guard for the failure mode that motivated this code path:
 * tools whose `content` is a single-line JSON blob >80 chars (e.g.
 * memory_search) used to be truncated by `truncateContent` BEFORE the
 * renderer ran, leaving a mangled `…`-suffixed JSON string in the lane.
 * Now `buildToolOutputEvent` consults the registry on the raw content
 * upstream of truncation, writes the formatted string to `chunk.display`,
 * and the renderer short-circuits on it.
 *
 * The chosen layering: handler emits raw `content`; provider event
 * carries `toolName?`; stream-consumer (one box upstream of the renderer)
 * derives `chunk.display` from the registry; renderer is a dumb
 * passthrough. `display` never appears on `ProviderEvent` or `ToolResult`.
 */

import { describe, it, expect } from 'vitest';
import type { ProviderEvent } from '../provider.js';
import { transformProviderEvent } from './stream-consumer.js';
import type { OutputEvent } from './stream-consumer.js';
import { formatOutcome } from '../../cli/commands/interactive/tool-lane-format.js';
import { stripAnsi } from '../../cli/display.js';

const noopDeps = {
  onAssistantMessage: () => {},
  onMetadata: () => {},
  onInit: () => {},
};

describe('stream-consumer: render-registry → chunk.display → formatOutcome', () => {
  it('derives chunk.display from raw content for memory_search and renders it verbatim', () => {
    // Simulate the exact event the Anthropic provider yields for a
    // memory_search returning 3 facts and 1 procedure. The raw payload is
    // 275 chars on a single line — pre-fix, `truncateContent` would have
    // mangled it before any summarizer downstream could parse it.
    const rawHandlerContent = JSON.stringify([
      { type: 'fact', content: 'something useful', created_at: '2026-05-16T00:00:00Z', confidence: 1 },
      { type: 'fact', content: 'another fact', created_at: '2026-05-16T00:00:00Z', confidence: 1 },
      { type: 'fact', content: 'third fact', created_at: '2026-05-16T00:00:00Z', confidence: 1 },
      { type: 'procedure', content: '# Some procedure body', created_at: '', confidence: 1 },
    ]);
    expect(rawHandlerContent.length).toBeGreaterThan(80);

    const evt: ProviderEvent = {
      type: 'tool.output',
      toolUseId: 't1',
      toolName: 'memory_search',
      content: rawHandlerContent,
      sessionId: 's1',
    };

    const out = transformProviderEvent(evt, noopDeps) as Extract<
      OutputEvent,
      { type: 'chunk' }
    >;
    expect(out.type).toBe('chunk');
    if (out.chunk.type !== 'tool_result') throw new Error('unreachable');

    // The registry ran on the RAW (un-truncated) content, so display
    // accurately counts 4 results. The chunk.content is still subject to
    // truncation as before, but that no longer leaks into the rendering.
    expect(out.chunk.display).toBe('4 results (3 facts, 1 procedure)');
    expect(out.chunk.content.length).toBeLessThanOrEqual(81);

    const rendered = stripAnsi(formatOutcome(out.chunk, undefined, 60, 'memory_search'));
    expect(rendered).toBe('4 results (3 facts, 1 procedure)');
    expect(rendered).not.toContain('"type"');
    expect(rendered).not.toContain('"fact"');
  });

  it('skips registry lookup for error results (raw error text survives)', () => {
    // Error path: handler returns `memory_search error: <msg>` with
    // isError: true. The registry MUST NOT run — even though the registry
    // would return null on this payload anyway (it's not valid JSON), we
    // explicitly skip to guard against a future formatter that happens to
    // accept error-shaped content.
    const evt: ProviderEvent = {
      type: 'tool.output',
      toolUseId: 't2',
      toolName: 'memory_search',
      content: 'memory_search error: bad query',
      isError: true,
      sessionId: 's1',
    };
    const out = transformProviderEvent(evt, noopDeps) as Extract<
      OutputEvent,
      { type: 'chunk' }
    >;
    if (out.chunk.type !== 'tool_result') throw new Error('unreachable');
    expect(out.chunk.display).toBeUndefined();

    const rendered = stripAnsi(formatOutcome(out.chunk, undefined, 60, 'memory_search'));
    expect(rendered).toContain('memory_search error: bad query');
  });

  it('events without toolName fall through to the existing preview path (Codex compat)', () => {
    // OpenAI Codex provider emits some `tool.output` events without a
    // toolName. The registry returns null, chunk.display stays undefined,
    // and the existing rendering takes over.
    const evt: ProviderEvent = {
      type: 'tool.output',
      toolUseId: 't3',
      content: 'short bash output line',
      sessionId: 's1',
    };
    const out = transformProviderEvent(evt, noopDeps) as Extract<
      OutputEvent,
      { type: 'chunk' }
    >;
    if (out.chunk.type !== 'tool_result') throw new Error('unreachable');
    expect(out.chunk.display).toBeUndefined();
    const rendered = stripAnsi(formatOutcome(out.chunk, undefined, 60, 'bash'));
    expect(rendered).toContain('short bash output line');
  });

  it('events with toolName but unregistered tool fall through unchanged', () => {
    const evt: ProviderEvent = {
      type: 'tool.output',
      toolUseId: 't4',
      toolName: 'read_file',
      content: 'line 1\nline 2\nline 3',
      sessionId: 's1',
    };
    const out = transformProviderEvent(evt, noopDeps) as Extract<
      OutputEvent,
      { type: 'chunk' }
    >;
    if (out.chunk.type !== 'tool_result') throw new Error('unreachable');
    expect(out.chunk.display).toBeUndefined();
  });

  // Regression: `ToolResultChunk.truncated` is the OVERFLOW signal from
  // the handler — not the cosmetic 80-char display preview clip computed
  // inside `truncateContent`. The handler reports truncation via
  // `ToolResult.truncated` → `tool.output.truncated` → `chunk.truncated`.
  // Subagent traces (handle.ts) record this field so parent agents can
  // detect "buffer was clipped" without substring-scanning content.
  it('chunk.truncated reflects ToolResult.truncated, not display-layer preview clipping', () => {
    // Long single-line content WOULD trip the 80-char preview clip, but
    // the event itself does not carry truncated:true. The chunk's
    // truncated must NOT be set just because content is long.
    const longButNotOverflowed: ProviderEvent = {
      type: 'tool.output',
      toolUseId: 'long',
      content: 'x'.repeat(500),
      sessionId: 's1',
    };
    const longOut = transformProviderEvent(longButNotOverflowed, noopDeps) as Extract<
      OutputEvent,
      { type: 'chunk' }
    >;
    if (longOut.chunk.type !== 'tool_result') throw new Error('unreachable');
    expect(longOut.chunk.truncated).toBeUndefined();

    // Conversely: short content with the structured flag set — chunk
    // must propagate truncated:true even though the preview path would
    // not clip a 25-char string.
    const shortButOverflowed: ProviderEvent = {
      type: 'tool.output',
      toolUseId: 'short',
      content: 'short result content',
      truncated: true,
      sessionId: 's1',
    };
    const shortOut = transformProviderEvent(shortButOverflowed, noopDeps) as Extract<
      OutputEvent,
      { type: 'chunk' }
    >;
    if (shortOut.chunk.type !== 'tool_result') throw new Error('unreachable');
    expect(shortOut.chunk.truncated).toBe(true);
  });
});

describe('stream-consumer: stream.retry → stream_retry', () => {
  it('maps a provider stream.retry event to the OutputEvent stream_retry marker', () => {
    // The provider emits 'stream.retry' on a mid-stream overload re-drive;
    // the consumer must surface it as the surface-facing 'stream_retry' so the
    // CLI/Telegram/threads buffers can discard the round's partial text.
    const evt: ProviderEvent = { type: 'stream.retry', sessionId: 's1' };
    const out = transformProviderEvent(evt, noopDeps);
    expect(out).toEqual({ type: 'stream_retry' });
  });
});
