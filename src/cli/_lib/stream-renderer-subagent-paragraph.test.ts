/**
 * Regression test for issue #110 — "route all overlay repaints through the
 * composer to stop paragraph flicker."
 *
 * Invariant under test: while the orchestrator's live thinking paragraph (the
 * `'thinking-live'` overlay slot) is active, a SUBAGENT state transition
 * (handleSubagentEvent: tool_use_detail / tool_result / done / error) must NOT
 * drop the thinking paragraph from the next composed overlay frame.
 *
 * History (the bug this pins): before the OverlayComposer migration each
 * subagent transition called `compositor.setOverlay(toolLane.getOverlay())`
 * directly — emitting ONLY the tool lane and clobbering the multi-row thinking
 * paragraph, producing flicker (the paragraph blanked on the subagent's
 * repaint, then repainted on the next orchestrator-composed frame). Under
 * parallel subagents firing repaints at independent cadences the blank/repaint
 * cycle was continuous.
 *
 * The fix: every subagent callsite routes through
 * `overlayComposer.markDirty('tool-lane') + flush()` when a composer is wired.
 * `flush()` recomposes ALL active slots in z-order (overlay-composer.ts), so
 * the `'thinking-live'` slot is preserved alongside the tool lane. This test
 * pins that at the INTEGRATION level: it drives the real `handleSubagentEvent`
 * against a real `OverlayComposer` wired through the production
 * `registerOverlaySlots`. If a future change reverts a subagent callsite to a
 * bare tool-lane `setOverlay`, the composed frame loses the `◆ thinking`
 * header and these tests fail. The `control` test proves the assertion
 * genuinely discriminates the fix from the pre-fix behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  handleSubagentEvent,
  synthesizeAgentEntry,
  type SubagentCtx,
} from './stream-renderer-subagent.js';
import type { OrchestratorCtx } from './stream-renderer-orchestrator.js';
import { freshSourceState, type SourceState } from './stream-renderer-source.js';
import { OverlayComposer } from './overlay-composer.js';
import { registerOverlaySlots } from './stream-renderer-lifecycle.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { createStageTracker } from '../commands/interactive/loop-stage.js';
import { stripAnsi } from '../display.js';
import type { Writer } from '../slash/types.js';
import type { StreamingMarkdownRenderer } from './stream-renderer.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { OutputEvent } from '../../agent/types.js';

/** The header `formatThinkingParagraph` always emits — a stable, glyph-only
 *  marker that survives `stripAnsi` (the `◆` is a unicode char, not ANSI). */
const PARAGRAPH_HEADER = '◆ thinking';

/** Production z-order from stream-renderer.ts:427 (the constructor wiring). */
const ORDER = [
  'thinking-live',
  'markdown-pending',
  'tool-lane',
  'progress-banner',
  'interrupt',
] as const;

const noopWriter: Writer = {
  line() {},
  raw() {},
  success() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Wire a real OverlayComposer exactly as production does (registerOverlaySlots),
 * with an ACTIVE orchestrator thinking paragraph and a shared tool lane. The
 * composer's sink IS the (mock) compositor, so every frame the compositor
 * receives is captured in `overlayFrames` — mirroring production where
 * `new OverlayComposer(compositor, …)` makes the compositor the single sink.
 */
function setup() {
  const overlayFrames: string[] = [];
  const compositor = {
    setOverlay: (t: string) => overlayFrames.push(t),
    commitAbove: () => {},
  } as unknown as TerminalCompositor;

  // The orchestrator's live thinking lane drives the 'thinking-live' slot.
  // A single non-whitespace push leaves it active + buffered, so
  // formatThinkingParagraph(peekPhase()) renders a non-empty paragraph.
  const thinkingLane = new ThinkingLane();
  thinkingLane.push(
    'Investigating why the overlay paragraph flickers under parallel subagents.',
  );

  const toolLane = new ToolLane();

  const overlayComposer = new OverlayComposer(compositor, [...ORDER]);
  registerOverlaySlots(overlayComposer, {
    stageTracker: createStageTracker(),
    thinkingMode: 'live',
    thinkingLane,
    streamingMarkdownRef: { current: null },
    toolLane,
    lastProgressByTask: new Map(),
    getInterrupting: () => false,
  });

  // Build a minimal OrchestratorCtx so subagent handlers can call
  // setComposedOverlay(ctx.orchestratorCtx) and route through the composer
  // (issue #389: subagents no longer hold overlayComposer directly).
  const orchestratorCtx: OrchestratorCtx = {
    isTTY: true,
    compositor,
    overlayComposer,
    toolLane,
    thinkingLane,
    thinkingMode: 'live',
    out: noopWriter,
    streamingMarkdown: { current: null },
    lastProgressByTask: new Map(),
  };

  const ctx: SubagentCtx = {
    isTTY: true,
    compositor,
    toolLane,
    out: noopWriter,
    streamingMarkdown: new Map<string, StreamingMarkdownRenderer>(),
    thinkingMode: 'summary',
    orchestratorCtx,
  };

  return { overlayFrames, compositor, thinkingLane, toolLane, overlayComposer, ctx };
}

function chunkEvent(chunk: Record<string, unknown>): OutputEvent {
  return { type: 'chunk', chunk } as unknown as OutputEvent;
}

describe('issue #110 — subagent transitions preserve the orchestrator thinking paragraph', () => {
  it('keeps the thinking paragraph in every frame across tool_use_detail → tool_result → done', () => {
    const { overlayFrames, thinkingLane, ctx } = setup();

    // Precondition: the thinking-live slot is genuinely active and renderable.
    expect(thinkingLane.isActive()).toBe(true);
    expect(thinkingLane.hasBufferedContent()).toBe(true);

    // A subagent appears under the orchestrator — synthesize its parent
    // `Agent(...)` row in the shared tool lane (handleSubagentEvent early-
    // returns without a syntheticAgentToolUseId).
    const source: SourceState = freshSourceState('verifier');
    synthesizeAgentEntry('sub-1', source, ctx, undefined);

    const transitions: Array<{ label: string; event: OutputEvent }> = [
      {
        label: 'tool_use_detail',
        event: chunkEvent({
          type: 'tool_use_detail',
          toolUseId: 't1',
          toolName: 'bash',
          toolInput: '("ls")',
        }),
      },
      {
        label: 'tool_result',
        event: chunkEvent({
          type: 'tool_result',
          toolUseId: 't1',
          content: 'ok',
          isError: false,
        }),
      },
      { label: 'done', event: { type: 'done' } as unknown as OutputEvent },
    ];

    for (const { label, event } of transitions) {
      const before = overlayFrames.length;
      handleSubagentEvent(event, 'sub-1', source, ctx);

      // Each discrete transition is unthrottled → fires exactly one composed
      // frame through the composer's single setOverlay sink.
      expect(overlayFrames.length, `${label} produced no overlay frame`).toBeGreaterThan(before);

      const frame = stripAnsi(overlayFrames.at(-1) ?? '');
      expect(
        frame,
        `frame after subagent ${label} dropped the orchestrator thinking paragraph`,
      ).toContain(PARAGRAPH_HEADER);
    }

    // Sanity: the subagent's tool actually composed into the same frame (it is
    // a real composed overlay, not just the paragraph in isolation).
    expect(stripAnsi(overlayFrames.at(-1) ?? '')).toContain('bash');
  });

  it('keeps the thinking paragraph when a subagent transition ends in error', () => {
    const { overlayFrames, ctx } = setup();

    const source: SourceState = freshSourceState('verifier');
    synthesizeAgentEntry('sub-err', source, ctx, undefined);

    handleSubagentEvent(
      chunkEvent({ type: 'tool_use_detail', toolUseId: 'e1', toolName: 'bash', toolInput: '("boom")' }),
      'sub-err',
      source,
      ctx,
    );

    const before = overlayFrames.length;
    handleSubagentEvent(
      { type: 'error', error: new Error('subagent blew up') } as unknown as OutputEvent,
      'sub-err',
      source,
      ctx,
    );

    expect(overlayFrames.length, 'error produced no overlay frame').toBeGreaterThan(before);
    expect(
      stripAnsi(overlayFrames.at(-1) ?? ''),
      'error frame dropped the orchestrator thinking paragraph',
    ).toContain(PARAGRAPH_HEADER);
  });

  it('control: the pre-fix bare tool-lane overlay would NOT contain the paragraph', () => {
    // Proves the assertion in the tests above is load-bearing: a bare
    // `setOverlay(toolLane.getOverlay())` (the regression) emits only the tool
    // lane, which never carries the `◆ thinking` header. So a passing
    // assertion above can ONLY mean the composer recomposed the thinking slot.
    const { toolLane, ctx } = setup();
    const source: SourceState = freshSourceState('verifier');
    synthesizeAgentEntry('sub-ctrl', source, ctx, undefined);
    handleSubagentEvent(
      chunkEvent({ type: 'tool_use_detail', toolUseId: 'c1', toolName: 'bash', toolInput: '("ls")' }),
      'sub-ctrl',
      source,
      ctx,
    );

    const bareOverlay = stripAnsi(toolLane.getOverlay());
    expect(bareOverlay).toContain('bash'); // the tool lane is non-empty…
    expect(bareOverlay).not.toContain(PARAGRAPH_HEADER); // …but never carries the paragraph
  });
});
