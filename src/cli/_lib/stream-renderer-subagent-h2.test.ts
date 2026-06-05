/**
 * Hypothesis H2 verification test (post-fix):
 * setOverlay is throttled to ≤1 call per 1500ms window on content/thinking chunks.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  synthesizeAgentEntry,
  handleSubagentEvent,
  type SubagentCtx,
} from './stream-renderer-subagent.js';
import { freshSourceState, type SourceState } from './stream-renderer-source.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import type { Writer } from '../slash/types.js';
import type { StreamingMarkdownRenderer } from './stream-renderer.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { OutputEvent } from '../../agent/types.js';

function makeCtx(toolLane: ToolLane, compositor: TerminalCompositor, thinkingMode: 'live' | 'summary' | 'off' = 'live'): SubagentCtx {
  const writer: Writer = { line() {}, raw() {}, success() {}, info() {}, warn() {}, error() {} };
  return {
    isTTY: true,
    compositor,
    toolLane,
    out: writer,
    streamingMarkdown: new Map<string, StreamingMarkdownRenderer>(),
    thinkingMode,
  };
}

describe('H2 fix: setOverlay throttled on high-frequency content/thinking chunks', () => {
  it('setOverlay fires ≤2 times for 20 content chunks within a 1500ms window', () => {
    vi.useFakeTimers();
    try {
      // Start at a known non-zero time so the first chunk fires (avoids epoch=0 edge)
      vi.setSystemTime(10_000);

      const lane = new ToolLane();
      const setOverlaySpy = vi.fn();
      const compositor = { setOverlay: setOverlaySpy, commitAbove: vi.fn() } as unknown as TerminalCompositor;
      const ctx = makeCtx(lane, compositor);

      const source: SourceState = freshSourceState('test-agent');
      source.agentType = 'verifier';
      synthesizeAgentEntry('src-1', source, ctx, undefined);

      // 20 content chunks at 50Hz — total 400ms, all within 1500ms window
      const chunkCount = 20;
      for (let i = 0; i < chunkCount; i++) {
        vi.advanceTimersByTime(20); // 20ms apart = 50Hz, total = 400ms (< 1500ms)
        handleSubagentEvent(
          { type: 'chunk', chunk: { type: 'content', content: `token ${i} ` } } as OutputEvent,
          'src-1', source, ctx,
        );
      }

      // Fixed: only the first chunk fires setOverlay; subsequent within 1500ms window are skipped
      // Allow ≤2 to handle any boundary effects
      const callCount = setOverlaySpy.mock.calls.length;
      console.log(`setOverlay call count for ${chunkCount} content chunks at 50Hz (post-fix): ${callCount}`);
      expect(callCount).toBeLessThanOrEqual(2);
      expect(callCount).toBeGreaterThanOrEqual(1); // at least the first chunk fires
    } finally {
      vi.useRealTimers();
    }
  });

  it('setOverlay fires ≤2 times for 30 thinking chunks within a 1500ms window (live mode)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);

      const lane = new ToolLane();
      const setOverlaySpy = vi.fn();
      const compositor = { setOverlay: setOverlaySpy, commitAbove: vi.fn() } as unknown as TerminalCompositor;
      const ctx = makeCtx(lane, compositor, 'live');

      const source: SourceState = freshSourceState('test-agent-thinking');
      source.agentType = 'verifier';
      synthesizeAgentEntry('src-2', source, ctx, undefined);

      // 30 thinking chunks at 66Hz — total 450ms, all within 1500ms window
      const chunkCount = 30;
      for (let i = 0; i < chunkCount; i++) {
        vi.advanceTimersByTime(15); // 15ms apart ≈ 66Hz, total = 450ms (< 1500ms)
        handleSubagentEvent(
          { type: 'chunk', chunk: { type: 'thinking', content: `thinking token ${i} ` } } as OutputEvent,
          'src-2', source, ctx,
        );
      }

      // Fixed: only the first chunk fires setOverlay; subsequent within 1500ms window are skipped
      const callCount = setOverlaySpy.mock.calls.length;
      console.log(`setOverlay call count for ${chunkCount} thinking chunks at 66Hz (post-fix): ${callCount}`);
      expect(callCount).toBeLessThanOrEqual(2);
      expect(callCount).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setOverlay fires again after 1500ms window elapses during content streaming', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);

      const lane = new ToolLane();
      const setOverlaySpy = vi.fn();
      const compositor = { setOverlay: setOverlaySpy, commitAbove: vi.fn() } as unknown as TerminalCompositor;
      const ctx = makeCtx(lane, compositor);

      const source: SourceState = freshSourceState('test-agent-window');
      source.agentType = 'verifier';
      synthesizeAgentEntry('src-3', source, ctx, undefined);

      // First chunk — fires immediately (t=10000)
      vi.advanceTimersByTime(10);
      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: 'first token ' } } as OutputEvent,
        'src-3', source, ctx,
      );
      const afterFirst = setOverlaySpy.mock.calls.length;
      expect(afterFirst).toBeGreaterThanOrEqual(1); // first fires

      // 500ms later — still within 1500ms window
      vi.advanceTimersByTime(500);
      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: 'second token within window ' } } as OutputEvent,
        'src-3', source, ctx,
      );
      const afterWithin = setOverlaySpy.mock.calls.length;
      // No new call within window
      expect(afterWithin).toBe(afterFirst);

      // Past the 1500ms window (500 + 1100 = 1600ms since first)
      vi.advanceTimersByTime(1100);
      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: 'third token past window ' } } as OutputEvent,
        'src-3', source, ctx,
      );
      const afterWindow = setOverlaySpy.mock.calls.length;
      // Should have fired again after window expired
      expect(afterWindow).toBeGreaterThan(afterWithin);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discrete state changes (tool_use_detail) always fire setOverlay immediately (unthrottled)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);

      const lane = new ToolLane();
      const setOverlaySpy = vi.fn();
      const compositor = { setOverlay: setOverlaySpy, commitAbove: vi.fn() } as unknown as TerminalCompositor;
      const ctx = makeCtx(lane, compositor);

      const source: SourceState = freshSourceState('test-agent-discrete');
      source.agentType = 'verifier';
      synthesizeAgentEntry('src-4', source, ctx, undefined);

      // First content chunk sets the overlay throttle timestamp
      vi.advanceTimersByTime(10);
      handleSubagentEvent(
        { type: 'chunk', chunk: { type: 'content', content: 'some prose ' } } as OutputEvent,
        'src-4', source, ctx,
      );
      const afterContent = setOverlaySpy.mock.calls.length;

      // tool_use_detail immediately after (within 1500ms window — would be throttled if content)
      vi.advanceTimersByTime(50);
      handleSubagentEvent(
        {
          type: 'chunk',
          chunk: { type: 'tool_use_detail', toolUseId: 'tu-1', toolName: 'bash', toolInput: '{}' },
        } as OutputEvent,
        'src-4', source, ctx,
      );
      const afterToolUse = setOverlaySpy.mock.calls.length;
      // Discrete state change must fire immediately (not throttled)
      expect(afterToolUse).toBeGreaterThan(afterContent);
    } finally {
      vi.useRealTimers();
    }
  });
});
