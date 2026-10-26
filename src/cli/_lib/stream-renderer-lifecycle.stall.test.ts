/**
 * Stall-annotation lifecycle contracts for checkPauseAnnotations:
 *
 *  - Defect C: an annotation must never RE-CREATE a lane entry that was
 *    already flushed (absorbed into an ancestor's committed block). Doing so
 *    produced a ghost root that later committed below its parent's Done row.
 *  - Defect F: a parent whose own stream is silent only because it is blocked
 *    on live child agents is labelled `· awaiting N children` (not
 *    `· waiting Xs`) and is never given the hard-cutoff timeout error.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  checkPauseAnnotations,
  AWAITING_LABEL_PREFIX,
  WAITING_LABEL_PREFIX,
  type LifecycleContext,
} from './stream-renderer-lifecycle.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { createStageTracker } from '../commands/interactive/loop-stage.js';
import { freshSourceState, type SourceState } from './stream-renderer-source.js';
import { stripAnsi } from '../display.js';
import type { Writer } from '../slash/types.js';

const writer: Writer = { line() {}, raw() {}, success() {}, info() {}, warn() {}, error() {} };
const K = 375;
const STALE_MS = 31_000;

function makeCtx(toolLane: ToolLane, sources: Map<string, SourceState>): LifecycleContext {
  return {
    compositor: null,
    overlayComposer: null,
    stageTracker: createStageTracker(),
    thinkingLane: new ThinkingLane(),
    toolLane,
    streamingMarkdownRef: { current: null },
    lastProgressByTask: new Map(),
    thinkingMode: 'off',
    out: writer,
    sources,
    pauseTickInterval: null,
    resizeUnsub: null,
    ttfbStartedAt: undefined,
    ttfbDone: true,
    lastTtfbAnnotation: '',
    isTTY: false,
    disposed: false,
  };
}

function source(agentType: string, syntheticId: string, lastEventAt: number): SourceState {
  const s = freshSourceState(agentType);
  s.syntheticAgentToolUseId = syntheticId;
  s.lastEventAt = lastEventAt;
  return s;
}

/** Parent agent P with one nested child agent C, both in flight. */
function parentWithChild(): { lane: ToolLane; sources: Map<string, SourceState>; parent: SourceState; child: SourceState } {
  const lane = new ToolLane();
  lane.addStartWithAgentContext('P', 'Agent', '(orchestrator)', undefined);
  lane.addStartWithAgentContext('C', 'Agent', '(research-agent)', 'P');
  const now = Date.now();
  const parent = source('orchestrator', 'P', now - STALE_MS);
  const child = source('research-agent', 'C', now);
  const sources = new Map([['parent', parent], ['child', child]]);
  return { lane, sources, parent, child };
}

afterEach(() => { vi.useRealTimers(); });

describe('checkPauseAnnotations — never re-creates a flushed lane entry (Defect C)', () => {
  it('a stalled source whose entry was absorbed into an ancestor block gets no ghost root', () => {
    const { lane, sources, child } = parentWithChild();
    // Parent's block (with the still-running child absorbed) is committed.
    lane.flushSource('P');
    expect(lane.hasPending()).toBe(false);
    child.lastEventAt = Date.now() - STALE_MS;

    const ctx = makeCtx(lane, sources);
    checkPauseAnnotations(ctx);
    expect(lane.hasEntry('C'), 'stall annotation must not re-create the child').toBe(false);
    expect(lane.hasPending(), 'no ghost root in the lane').toBe(false);

    // Drive through the hard cutoff too — no tick may resurrect the entry.
    for (let i = 0; i < K * 2 + 1; i++) checkPauseAnnotations(ctx);
    expect(lane.hasPending()).toBe(false);
  });

  it('still annotates a live, present entry with the waiting label', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('A', 'Agent', '(solo)', undefined);
    const s = source('solo', 'A', Date.now() - STALE_MS);
    checkPauseAnnotations(makeCtx(lane, new Map([['solo', s]])));
    expect(s.pauseAnnotation?.startsWith(WAITING_LABEL_PREFIX)).toBe(true);
    expect(stripAnsi(lane.getOverlay())).toContain('· waiting');
  });
});

describe('checkPauseAnnotations — parent blocked on live children (Defect F)', () => {
  it('labels the parent `· awaiting 1 child` instead of `· waiting Xs`', () => {
    const { lane, sources, parent } = parentWithChild();
    checkPauseAnnotations(makeCtx(lane, sources));
    expect(parent.pauseAnnotation).toBe(`${AWAITING_LABEL_PREFIX}1 child`);
    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toContain('awaiting 1 child');
    expect(overlay).not.toContain('waiting 3');
  });

  it('pluralises for several live children', () => {
    const { lane, sources, parent } = parentWithChild();
    lane.addStartWithAgentContext('C2', 'Agent', '(research-agent)', 'P');
    checkPauseAnnotations(makeCtx(lane, sources));
    expect(parent.pauseAnnotation).toBe(`${AWAITING_LABEL_PREFIX}2 children`);
  });

  it('does not count a finished child', () => {
    const { lane, sources, parent } = parentWithChild();
    lane.addResult('C', { type: 'tool_result', toolUseId: 'C', content: 'ok', isError: false });
    checkPauseAnnotations(makeCtx(lane, sources));
    expect(parent.pauseAnnotation?.startsWith(WAITING_LABEL_PREFIX)).toBe(true);
  });

  it('never stamps the hard-cutoff timeout on a parent while a child is live', () => {
    const { lane, sources, parent } = parentWithChild();
    const ctx = makeCtx(lane, sources);
    for (let i = 0; i < K * 2 + 5; i++) checkPauseAnnotations(ctx);
    expect(parent.done, 'parent must not be auto-settled').toBe(false);
    expect(stripAnsi(lane.getOverlay())).not.toContain('timed out');

    // Once the child finishes, the ordinary stall clock applies again.
    lane.addResult('C', { type: 'tool_result', toolUseId: 'C', content: 'ok', isError: false });
    for (let i = 0; i < K * 2; i++) checkPauseAnnotations(ctx);
    expect(parent.done, 'cutoff resumes after children settle').toBe(true);
  });
});
