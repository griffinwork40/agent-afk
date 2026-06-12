/**
 * REPRODUCTION ATTEMPT: TUI blank-row gap inside a subagent block in scrollback.
 *
 * BUG (production, current code at commit d2bb783): In the interactive REPL,
 * when the mint skill runs sequential subagents (Agent(mint-plan) →
 * Agent(mint-parallelize) → Agent(mint-build), each with 30+ tool events),
 * the final scrollback shows:
 *   - subagent header line (e.g. "→ Agent(mint-parallelize) [subagent] — 18 tools")
 *     NOTE: STALE mid-flight count (not the final 36)
 *   - ~28 BLANK rows
 *   - that block's tool lines + Done (36 tools · …) line
 * Gap is INSIDE one logical block; the prior identical block (mint-plan) shows
 * NO gap.
 *
 * HYPOTHESES (from prior investigation):
 * (a) CupFrameRenderer shrink-padding (cup-frame-renderer.ts ~158-170):
 *     When the overlay height shrinks, blank rows prepended during the prior
 *     render scroll into scrollback at the next commitAbove.
 *
 * (b) commitAbove Phase 1 overflow path (!fitsAboveFrame in
 *     terminal-compositor.committed-band-commit.ts): When prevTopRow ≤ 1
 *     (BLOCKER-1 guard — overlay fills the viewport), the overflow path CUP-
 *     writes the block at anchorFloor and emits lineCount LFs. Those LFs
 *     scroll the TOP rows of the screen (which may be blank from the
 *     just-cleared frame) into scrollback.
 *
 * STRATEGY: Drive TerminalCompositor + ToolLane + OverlayComposer directly
 * (not through StreamRenderer which reads process.stdout for isTTY detection).
 * Mirror what StreamRenderer.process() does for each subagent event type.
 *
 * TRIGGER CONDITION: The overflow path (!fitsAboveFrame) requires prevTopRow ≤ 1,
 * meaning the overlay fills the entire viewport. This needs overlay height ≥ rows-2.
 * We test this by:
 *   1. Adding background agents to grow the overlay to fill the viewport
 *   2. Setting a tall overlay via setOverlay (mimicking thinking-live slot)
 *   3. Using small terminal geometries (rows=15, rows=24)
 *
 * REPRODUCTION STATUS: NOT REPRODUCED (0 blank rows in all configurations).
 * The fix is already in place at d2bb783. All tests assert ≤1 blank rows;
 * they WOULD FAIL if the bug were present (gap ≥ 5 rows).
 *
 * SEE ALSO: src/cli/terminal-compositor.scrollback-gap.test.ts — the
 * analogous committed-band gap test (also fixed, tests the same overflow path).
 *
 * WHAT WAS NOT TRIED:
 * - async timer-based overlay updates (production uses 1500ms throttle for
 *   content/thinking chunks — our test fires synchronously)
 * - the exact production StreamRenderer path via a mock process.stdout
 *   (would require patching process.stdout.isTTY/columns/rows at module load)
 * - overflow with a block containing a PRE-COMMITTED header (headerEmitted=true
 *   path in flushSource — requires a parent skill/compose context in the lane)
 * - the "stale count" scenario (requires two separate commits for the same
 *   subagent: one for the header at mid-flight, one for children at done)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from '../terminal-compositor.js';
import { StatusLine } from '../status-line.js';
import { OverlayComposer } from './overlay-composer.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import {
  freshSourceState,
  syntheticResult,
  formatDoneSummary,
} from './stream-renderer-source.js';
import type { SourceState } from './stream-renderer-source.js';

// ─── TTY mock harness (mirrors terminal-compositor.scrollback-gap.test.ts) ───
type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin  = NodeJS.ReadStream  & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

function makeStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true; s.columns = cols; s.rows = rows;
  return s;
}
function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true; s.isRaw = false;
  s.setRawMode = vi.fn((r: boolean) => { s.isRaw = r; return s; });
  return s;
}
function collect(stream: MockStdout): () => string {
  const chunks: string[] = [];
  stream.on('data', (x) => chunks.push(String(x)));
  return () => chunks.join('');
}
function termWrite(t: HeadlessTerminal, d: string): Promise<void> {
  return new Promise((resolve) => t.write(d, resolve));
}
function allLines(t: HeadlessTerminal): string[] {
  const buf = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}

// ─── Buffer analysis helpers ──────────────────────────────────────────────────

/** Compress a line buffer for human-readable reporting. Blank runs compressed. */
function dumpBuffer(lines: string[]): string {
  const result: string[] = [];
  let blankRun = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === '') {
      blankRun++;
    } else {
      if (blankRun > 0) {
        result.push(`  [${blankRun} blank]`);
        blankRun = 0;
      }
      result.push(`[${String(i).padStart(3)}] ${l.slice(0, 80)}`);
    }
  }
  if (blankRun > 0) result.push(`  [${blankRun} blank]`);
  return result.join('\n');
}

/** Largest run of contiguous blank rows between two indices (exclusive). */
function largestBlankRun(lines: string[], fromIdx: number, toIdx: number): number {
  let maxRun = 0, cur = 0;
  for (let i = fromIdx + 1; i < toIdx; i++) {
    if ((lines[i] ?? '').trim() === '') {
      cur++;
      if (cur > maxRun) maxRun = cur;
    } else {
      cur = 0;
    }
  }
  return maxRun;
}

/** Find [headerIdx, doneIdx] for a named subagent block. */
function findBlock(lines: string[], headerNeedle: string): [number, number] {
  let headerIdx = -1, doneIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (headerIdx === -1 && l.includes(headerNeedle)) headerIdx = i;
    if (headerIdx !== -1 && doneIdx === -1 && i > headerIdx && l.includes('Done')) doneIdx = i;
  }
  return [headerIdx, doneIdx];
}

// ─── Production-faithful subagent driver ─────────────────────────────────────

/**
 * Run one subagent to completion, mirroring StreamRenderer.process() for
 * each subagent event:
 *   synthesize → (tool_use_detail + tool_result) × N → done → flushSource → commitAbove
 *
 * External constraint (production path): flushSource removes entries immediately;
 * overlayComposer.flush() collapses the overlay AFTER all commitAbove calls.
 */
function runSubagentToCompletion(opts: {
  sourceId: string;
  agentType: string;
  toolCount: number;
  compositor: TerminalCompositor;
  toolLane: ToolLane;
  overlayComposer: OverlayComposer;
  maxWidth: number;
}): void {
  const { sourceId, agentType, toolCount, compositor, toolLane, overlayComposer, maxWidth } = opts;
  const source: SourceState = freshSourceState(agentType);

  // synthesizeAgentEntry
  const syntheticId = `__synth_agent_${sourceId}`;
  toolLane.addStartWithAgentContext(syntheticId, 'Agent', `(${agentType})`, undefined, maxWidth);
  source.syntheticAgentToolUseId = syntheticId;
  overlayComposer.markDirty('tool-lane');
  overlayComposer.flush();

  // tool_use_detail + tool_result pairs
  for (let i = 0; i < toolCount; i++) {
    const toolId = `${sourceId}_tool_${i}`;
    const toolName = ['bash', 'read_file', 'write_file', 'grep', 'glob'][i % 5]!;
    toolLane.addStartWithAgentContext(toolId, toolName, `("step_${i}")`, syntheticId, maxWidth);
    source.stats.toolUses += 1;
    overlayComposer.markDirty('tool-lane');
    overlayComposer.flush();
    toolLane.addResult(toolId, { type: 'tool_result', toolUseId: toolId, content: `ok_${i}`, isError: false });
    overlayComposer.markDirty('tool-lane');
    overlayComposer.flush();
  }

  // done → finalizeSubagent
  toolLane.setThinkingTail(syntheticId, undefined);
  const summary = formatDoneSummary(source);
  toolLane.setAgentResultSummary(syntheticId, summary);
  toolLane.addResult(syntheticId, syntheticResult(summary, false));
  overlayComposer.markDirty('tool-lane');
  overlayComposer.flush();

  // flushSource → commitAbove loop (mirrors coordinator 'after-subagent' batch)
  const lines = toolLane.flushSource(syntheticId);
  for (const line of lines) compositor.commitAbove(line);
  compositor.commitAbove('');
  overlayComposer.markDirty('tool-lane');
  overlayComposer.flush();
}

/**
 * Add background agents to grow the overlay. Each agent shows as ~5 lines:
 * 1 header + 3 completed children + 1 in-flight tool. Does NOT complete them
 * (they stay active = overlay stays tall).
 */
function addBackgroundAgents(
  toolLane: ToolLane,
  overlayComposer: OverlayComposer,
  count: number,
  maxWidth: number,
): void {
  for (let a = 0; a < count; a++) {
    const agentId = `__synth_bg_${a}`;
    toolLane.addStartWithAgentContext(agentId, 'Agent', `(background-${a})`, undefined, maxWidth);
    for (let t = 0; t < 3; t++) {
      const tId = `bg_tool_${a}_${t}`;
      toolLane.addStartWithAgentContext(tId, 'bash', `("bg_${a}_step_${t}")`, agentId, maxWidth);
      toolLane.addResult(tId, { type: 'tool_result', toolUseId: tId, content: 'ok', isError: false });
    }
    // One in-flight tool (no result = agent stays "active" in the overlay)
    toolLane.addStartWithAgentContext(`bg_inflight_${a}`, 'read_file', `("file_${a}.ts")`, agentId, maxWidth);
    overlayComposer.markDirty('tool-lane');
    overlayComposer.flush();
  }
}

// ─── Shared teardown ─────────────────────────────────────────────────────────
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

// ─── Main tests ───────────────────────────────────────────────────────────────

describe('TUI subagent-gap: no blank rows between header and Done in scrollback', () => {
  /**
   * Mint-like sequence: orchestrator text → subagent A (30 tools) → orchestrator
   * text → subagent B (36 tools) → subagent C starts (no done).
   * Geometry: 120×50 production, 80×24 compact, 80×40 mid.
   */
  for (const { cols, rows, label } of [
    { cols: 120, rows: 50, label: '120×50 production geometry' },
    { cols: 80,  rows: 24, label: '80×24 compact' },
    { cols: 80,  rows: 40, label: '80×40 mid' },
  ] as const) {
    it(`[${label}] mint-like 3-subagent sequence — no gap inside blocks`, async () => {
      const stdout = makeStdout(cols, rows);
      const stdin  = makeStdin();
      const captured = collect(stdout);
      const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
      statusLine.start();
      statusLine.repaint({ model: 'test-model', cost: 0, tokens: 0, contextPct: 0 });
      const compositor = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1,
      });
      await compositor.arm();
      statusLine.setExtraRows(2);
      compositor.setSpinner({ enabled: true });
      const toolLane = new ToolLane();
      const overlayComposer = new OverlayComposer(compositor, ['tool-lane']);
      overlayComposer.register({ key: 'tool-lane', render: () => toolLane.getOverlay() });
      cleanups.push(() => { statusLine.stop(); compositor.disarm(); });
      const maxWidth = cols - 14;

      // Subagent A: mint-plan (30 tools)
      runSubagentToCompletion({ sourceId: 'mint-plan-001', agentType: 'mint-plan', toolCount: 30, compositor, toolLane, overlayComposer, maxWidth });
      compositor.commitAbove('Orchestrator: plan complete');
      compositor.commitAbove('');

      // Subagent B: mint-parallelize (36 tools) — the buggy one per report
      runSubagentToCompletion({ sourceId: 'mint-parallelize-002', agentType: 'mint-parallelize', toolCount: 36, compositor, toolLane, overlayComposer, maxWidth });
      compositor.commitAbove('Orchestrator: parallelization complete');
      compositor.commitAbove('');

      // Subagent C: mint-build starts but doesn't complete
      const buildSynId = '__synth_agent_mint-build-003';
      toolLane.addStartWithAgentContext(buildSynId, 'Agent', '(mint-build)', undefined, maxWidth);
      for (let i = 0; i < 5; i++) {
        const tid = `build_tool_${i}`;
        toolLane.addStartWithAgentContext(tid, 'bash', `("build_${i}")`, buildSynId, maxWidth);
        toolLane.addResult(tid, { type: 'tool_result', toolUseId: tid, content: 'ok', isError: false });
      }
      overlayComposer.markDirty('tool-lane');
      overlayComposer.flush();

      const internals = compositor as unknown as { repaint(): void };
      internals.repaint();

      const term = new HeadlessTerminal({ cols, rows, scrollback: 1000, allowProposedApi: true, convertEol: true });
      cleanups.push(() => term.dispose());
      await termWrite(term, captured());
      const lines = allLines(term);

      console.log(`\n─── [${cols}×${rows}] mint-3-subagent buffer map ─────────`);
      console.log(dumpBuffer(lines));
      console.log(`baseY=${term.buffer.active.baseY}`);

      const [planH, planD] = findBlock(lines, 'mint-plan');
      const [paraH, paraD] = findBlock(lines, 'mint-parallelize');

      if (planH >= 0 && planD > planH) {
        const g = largestBlankRun(lines, planH, planD);
        console.log(`  mint-plan gap: ${g} rows (header=${planH} done=${planD})`);
        expect(g, `mint-plan gap ${g} rows`).toBeLessThanOrEqual(1);
      }
      if (paraH >= 0 && paraD > paraH) {
        const g = largestBlankRun(lines, paraH, paraD);
        console.log(`  mint-parallelize gap: ${g} rows (header=${paraH} done=${paraD})`);
        expect(g, `mint-parallelize gap ${g} rows`).toBeLessThanOrEqual(1);
      }
    }, 20_000);
  }

  /**
   * Overflow path trigger: tall overlay via background agents forces
   * prevTopRow ≤ 1 → BLOCKER-1 guard fires → overflow path.
   * Tests multiple bgAgent × rows combinations to find the reproduction threshold.
   */
  for (const { bgAgents, termRows } of [
    { bgAgents: 3, termRows: 24 },
    { bgAgents: 4, termRows: 24 },  // TRIGGER ZONE: overlay ~20 lines on 21-row frame
    { bgAgents: 5, termRows: 24 },  // DEEP TRIGGER: overlay ~25 lines
    { bgAgents: 2, termRows: 15 },  // tiny terminal
    { bgAgents: 3, termRows: 15 },
  ] as const) {
    it(
      `[80×${termRows}] ${bgAgents} bg-agents overflow path — no gap`,
      async () => {
        const cols = 80, rows = termRows;
        const stdout = makeStdout(cols, rows);
        const stdin  = makeStdin();
        const captured = collect(stdout);
        const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
        statusLine.start();
        statusLine.repaint({ model: 'test-model', cost: 0, tokens: 0, contextPct: 0 });
        const compositor = new TerminalCompositor({
          stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1,
        });
        await compositor.arm();
        statusLine.setExtraRows(2);
        compositor.setSpinner({ enabled: true });
        const toolLane = new ToolLane();
        const overlayComposer = new OverlayComposer(compositor, ['tool-lane']);
        overlayComposer.register({ key: 'tool-lane', render: () => toolLane.getOverlay() });
        cleanups.push(() => { statusLine.stop(); compositor.disarm(); });
        const maxWidth = cols - 14;

        // Fill overlay with background agents to push prevTopRow toward 1
        addBackgroundAgents(toolLane, overlayComposer, bgAgents, maxWidth);
        (compositor as unknown as { repaint(): void }).repaint();

        // Run target subagent while overlay is tall
        runSubagentToCompletion({
          sourceId: `target-${bgAgents}-${rows}`,
          agentType: 'target-agent',
          toolCount: 10,
          compositor, toolLane, overlayComposer, maxWidth,
        });

        const internals = compositor as unknown as { repaint(): void };
        internals.repaint();

        const term = new HeadlessTerminal({ cols, rows, scrollback: 1000, allowProposedApi: true, convertEol: true });
        cleanups.push(() => term.dispose());
        await termWrite(term, captured());
        const lines = allLines(term);

        const [h, d] = findBlock(lines, 'target-agent');
        const gap = (h >= 0 && d > h) ? largestBlankRun(lines, h, d) : 0;

        console.log(
          `  [bg=${bgAgents} rows=${rows}] header=${h} done=${d} gap=${gap}` +
          (gap >= 5 ? ' ← BUG REPRODUCED' : ''),
        );
        if (gap >= 5) console.log(`  Buffer:\n${dumpBuffer(lines)}`);

        expect(
          gap,
          `[bg=${bgAgents} rows=${rows}] gap=${gap} rows (header=${h} done=${d}).\n${dumpBuffer(lines)}`,
        ).toBeLessThanOrEqual(1);
      },
      15_000,
    );
  }

  /**
   * Tall setOverlay (mimics orchestrator thinking-live filling the viewport)
   * combined with a subagent commit. This is the closest to the production
   * scenario where the thinking-live slot and the tool-lane slot together
   * fill the overlay beyond the terminal height.
   */
  it(
    '[80×24] 27-line setOverlay + subagent commit — no gap (thinking-live scenario)',
    async () => {
      const cols = 80, rows = 24;
      const stdout = makeStdout(cols, rows);
      const stdin  = makeStdin();
      const captured = collect(stdout);
      const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
      statusLine.start();
      statusLine.repaint({ model: 'test-model', cost: 0, tokens: 0, contextPct: 0 });
      const compositor = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1,
      });
      await compositor.arm();
      statusLine.setExtraRows(2);
      compositor.setSpinner({ enabled: true });
      const toolLane = new ToolLane();
      cleanups.push(() => { statusLine.stop(); compositor.disarm(); });
      const maxWidth = cols - 14;

      // Simulate a large thinking-live overlay from the orchestrator (27 lines
      // fills a 24-row terminal with extraRows=2, forcing prevTopRow ≤ 1)
      const thinkingOverlay = Array.from(
        { length: 24 },
        (_, i) => `Thinking line ${i}: analyzing the codebase structure...`,
      ).join('\n');
      compositor.setOverlay(thinkingOverlay);
      (compositor as unknown as { repaint(): void }).repaint();

      // Target subagent runs while overlay fills the viewport
      const sourceId = 'tall-overlay-target';
      const source: SourceState = freshSourceState('mint-parallelize');
      const syntheticId = `__synth_agent_${sourceId}`;

      toolLane.addStartWithAgentContext(syntheticId, 'Agent', '(mint-parallelize)', undefined, maxWidth);
      source.syntheticAgentToolUseId = syntheticId;
      compositor.setOverlay(thinkingOverlay + '\n' + toolLane.getOverlay());

      for (let i = 0; i < 10; i++) {
        const tid = `${sourceId}_tool_${i}`;
        toolLane.addStartWithAgentContext(tid, 'bash', `("step_${i}")`, syntheticId, maxWidth);
        source.stats.toolUses += 1;
        compositor.setOverlay(thinkingOverlay + '\n' + toolLane.getOverlay());
        toolLane.addResult(tid, { type: 'tool_result', toolUseId: tid, content: `ok_${i}`, isError: false });
        compositor.setOverlay(thinkingOverlay + '\n' + toolLane.getOverlay());
      }

      // finalizeSubagent
      toolLane.setThinkingTail(syntheticId, undefined);
      const summary = formatDoneSummary(source);
      toolLane.setAgentResultSummary(syntheticId, summary);
      toolLane.addResult(syntheticId, syntheticResult(summary, false));
      compositor.setOverlay(thinkingOverlay + '\n' + toolLane.getOverlay());

      // commitAbove while overlay still tall (production pattern)
      const lines = toolLane.flushSource(syntheticId);
      for (const line of lines) compositor.commitAbove(line);
      compositor.commitAbove('');
      // Collapse the overlay AFTER commit (mimics the production commit closure)
      compositor.setOverlay('');
      const internals = compositor as unknown as { repaint(): void };
      internals.repaint();

      const term = new HeadlessTerminal({ cols, rows, scrollback: 1000, allowProposedApi: true, convertEol: true });
      cleanups.push(() => term.dispose());
      await termWrite(term, captured());
      const allBufLines = allLines(term);

      console.log('\n─── [tall-setOverlay] buffer map ──────────────────────────');
      console.log(`baseY=${term.buffer.active.baseY}  totalLines=${allBufLines.length}`);
      console.log(dumpBuffer(allBufLines));
      console.log('──────────────────────────────────────────────────────────\n');

      const [h, d] = findBlock(allBufLines, 'mint-parallelize');
      const gap = (h >= 0 && d > h) ? largestBlankRun(allBufLines, h, d) : 0;
      console.log(`  Header at ${h}, Done at ${d}, gap: ${gap} rows${gap >= 5 ? ' ← BUG REPRODUCED' : ''}`);

      expect(
        gap,
        `BUG: ${gap} blank rows between header (${h}) and Done (${d}).\n${dumpBuffer(allBufLines)}`,
      ).toBeLessThanOrEqual(1);
    },
    20_000,
  );
});
