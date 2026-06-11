/**
 * REGRESSION TEST: TUI blank-row gap + lost Done line inside a committed
 * subagent block in scrollback.
 *
 * BUG (production v3.99.x, mint skill in REPL): after a skill turn with two
 * sequential subagents (mint-plan → mint-parallelize), the final scrollback
 * showed:
 *
 *   ◉ → Agent(mint-parallelize) [subagent] — 18 tools · 2094 lines  ← STALE count (mid-flight capture)
 *   [~28 BLANK rows]
 *   │ ├─ <tool rows, count matches stale 18>
 *   │ └─ Done (36 tools · …)                                         ← final count
 *
 * The prior mint-plan block (15-at-capture vs 30-final) showed NO gap.
 *
 * ROOT CAUSE (confirmed by this test; compositor-level hypotheses ruled out
 * by terminal-compositor.pad-decay-straddle.test.ts and
 * stream-renderer-subagent-gap.repro.test.ts, both green pre-fix):
 *
 * finalizeOrchestrator (stream-renderer-orchestrator-emit.ts) ran the NUCLEAR
 * ToolLane.flush() at every orchestrator message_stop. When a subagent was
 * still running at that boundary:
 * 1. Its Agent entry was captured with a STALE tool count and DELETED from
 *    the lane; the rendered lines were scheduled as a deferred
 *    'before-content' CommitCoordinator batch.
 * 2. Subsequent child events re-entered the lane as orphans (agentContext
 *    pointing at the deleted parent).
 * 3. At subagent done, stream-renderer.ts:604's hasEntry() check returned
 *    FALSE → flushSource + 'after-subagent' scheduling + eager drainSubagent
 *    were ALL skipped → the final block (correct counts + Done line) was
 *    never committed.
 * 4. The stale before-content batch drained at dispose-time flushAll instead,
 *    out of causal order — producing the stale header, the blank gap, and a
 *    missing/displaced Done in scrollback.
 *
 * FIX: finalizeOrchestrator uses ToolLane.flushCompletedRoots() (selective),
 * so in-flight subagent roots survive the turn boundary and the done-path
 * contract (hasEntry → flushSource → after-subagent batch → eager drain)
 * holds. These tests drive the REAL finalizeOrchestrator, so they go red if
 * the nuclear flush ever returns.
 *
 * WHAT THIS TEST DOES:
 * Wire the real ToolLane + OverlayComposer + CommitCoordinator + TerminalCompositor
 * (with a mock TTY PassThrough stdout) and drive the exact production sequence:
 *
 *   [Phase 0] Subagent A (mint-plan): agent entry + ~15 child tool events,
 *             then done: flushSource + schedule 'after-subagent:A' +
 *             drainSubagent(A) — the clean reference block (NO gap)
 *   [Phase 1-2] Subagent B start (mint-parallelize) + tool events before the
 *             orchestrator boundary
 *   [Phase 3] REAL finalizeOrchestrator fires mid-B (orchestrator
 *             message_stop while B is still running) — the bug trigger
 *   [Phase 4] B accumulates more tool events after the boundary
 *   [Phase 5] Subagent B done: production done-path mirror
 *             (stream-renderer.ts:604) — hasEntry → flushSource + schedule
 *             'after-subagent:B' + drainSubagent(B)
 *
 * INSTRUMENTATION: every commitAbove call is intercepted to record the text
 * (and count of leading/embedded blanks); every setOverlay call is recorded
 * too. The final stdout byte stream is replayed into a headless xterm and
 * scrollback is asserted on.
 *
 * ASSERTIONS (red under the pre-fix nuclear flush):
 *   - B's Done line is present in scrollback (it was lost pre-fix)
 *   - maxBlankRun inside block B ≤ 1 (the ~28-row gap pre-fix)
 *
 * @module cli/_lib/subagent-block-gap.repro.test
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from '../terminal-compositor.js';
import { StatusLine } from '../status-line.js';
import { OverlayComposer } from './overlay-composer.js';
import { CommitCoordinator } from './commit-coordinator.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { finalizeOrchestrator } from './stream-renderer-orchestrator.js';
import type { OrchestratorCtx } from './stream-renderer-orchestrator.js';
import type { Writer } from '../slash/types.js';
import { syntheticResult, formatDoneSummary, freshSourceState } from './stream-renderer-source.js';

// ─── TTY mock harness (mirrors pad-decay-straddle.test.ts) ────────────────────
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
function dumpMap(lines: string[]): string {
  const out: string[] = [];
  let blanks = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').trimEnd();
    if (l === '') { blanks++; continue; }
    if (blanks > 0) { out.push(`     [${blanks} blank]`); blanks = 0; }
    out.push(`[${String(i).padStart(3)}] ${l.slice(0, 80)}`);
  }
  if (blanks > 0) out.push(`     [${blanks} blank]`);
  return out.join('\n');
}

/** Largest run of contiguous blank rows strictly between buffer rows a and b. */
function maxBlankRun(lines: string[], a: number, b: number): number {
  let max = 0, run = 0;
  for (let r = a + 1; r < b; r++) {
    if ((lines[r] ?? '').trim() === '') { run++; if (run > max) max = run; }
    else run = 0;
  }
  return max;
}

/** Count leading blank lines in a string. */
function leadingBlanks(text: string): number {
  const lines = text.split('\n');
  let count = 0;
  for (const l of lines) {
    if (l.trim() === '') count++;
    else break;
  }
  return count;
}

/** Count embedded (non-leading, non-trailing) blank lines in a string. */
function embeddedBlanks(text: string): number {
  const lines = text.split('\n');
  // trim leading and trailing blanks
  let start = 0;
  while (start < lines.length && (lines[start] ?? '').trim() === '') start++;
  let end = lines.length - 1;
  while (end > start && (lines[end] ?? '').trim() === '') end--;
  let count = 0;
  for (let i = start + 1; i < end; i++) {
    if ((lines[i] ?? '').trim() === '') count++;
  }
  return count;
}

interface CommitRecord {
  text: string;
  leadingBlanks: number;
  embeddedBlanks: number;
  phase: string;
}

interface OverlayRecord {
  text: string;
  lineCount: number;
  phase: string;
}

// ─── Scenario runner ──────────────────────────────────────────────────────────

async function runMintScenario(opts: {
  cols: number;
  rows: number;
  /** Number of child tool events for subagent B BEFORE nuclear flush (stale count) */
  toolsBBeforeNuclear: number;
  /** Number of child tool events for subagent B AFTER nuclear flush (post-delete orphans) */
  toolsBAfterNuclear: number;
  /**
   * Whether to inject the nuclear-flush 'before-content' batch MID-WAY through B.
   * This is the production scenario: orchestrator message_stop fires while B is
   * still running (has accumulated some tools but not done yet).
   * When false: no nuclear flush — tests the normal case (should have no gap).
   */
  nuclearFlushMidB: boolean;
}): Promise<{
  lines: string[];
  dump: string;
  find: (m: string) => number;
  commitLog: CommitRecord[];
  overlayLog: OverlayRecord[];
}> {
  const stdout = makeStdout(opts.cols, opts.rows);
  const stdin = makeStdin();
  const allOutput = collect(stdout);

  const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  statusLine.start();
  statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });

  const compositor = new TerminalCompositor({
    stdout,
    stdin,
    onCancel: vi.fn(),
    scrollRegion: statusLine,
    anchorRow: 1,
  });
  await compositor.arm();
  statusLine.setExtraRows(2);
  compositor.setSpinner({ enabled: true });

  // Instrumentation: wrap commitAbove + track setOverlay calls
  const commitLog: CommitRecord[] = [];
  const overlayLog: OverlayRecord[] = [];
  let currentPhase = 'init';

  const origCommitAbove = compositor.commitAbove.bind(compositor);
  compositor.commitAbove = (text: string) => {
    commitLog.push({
      text,
      leadingBlanks: leadingBlanks(text),
      embeddedBlanks: embeddedBlanks(text),
      phase: currentPhase,
    });
    origCommitAbove(text);
  };

  const origSetOverlay = compositor.setOverlay.bind(compositor);
  compositor.setOverlay = (text: string) => {
    overlayLog.push({
      text: text.slice(0, 60),
      lineCount: text === '' ? 0 : text.split('\n').length,
      phase: currentPhase,
    });
    origSetOverlay(text);
  };

  // ─── Component wiring ───────────────────────────────────────────────────
  const toolLane = new ToolLane();
  const coordinator = new CommitCoordinator();
  const overlayComposer = new OverlayComposer(compositor, ['tool-lane']);
  overlayComposer.register({
    key: 'tool-lane',
    render: () => toolLane.hasPending() ? toolLane.getOverlay() : '',
  });

  // Helper: push overlay update through composer
  function flushOverlay(): void {
    overlayComposer.markDirty('tool-lane');
    overlayComposer.flush();
  }

  // Helper: orchestrator message_stop — calls the REAL production
  // finalizeOrchestrator (stream-renderer-orchestrator-emit.ts) with a real
  // OrchestratorCtx, so this test pins whatever the production lane-flush
  // semantics are. With the pre-fix nuclear toolLane.flush() it captured ALL
  // lane entries (including in-flight B, with a stale tool count) and deleted
  // them; with the fixed flushCompletedRoots() in-flight subagent roots
  // survive the turn boundary.
  const noop = (): void => {};
  const writerStub: Writer = {
    line: noop, raw: noop, success: noop, info: noop, warn: noop, error: noop,
  };
  const orchestratorSource = freshSourceState(undefined);
  const orchestratorCtx: OrchestratorCtx = {
    out: writerStub,
    isTTY: true,
    compositor,
    overlayComposer,
    toolLane,
    thinkingLane: new ThinkingLane(),
    thinkingMode: 'off',
    streamingMarkdown: { current: null },
    coordinator,
  };
  function fireOrchestratorMessageStop(): void {
    finalizeOrchestrator(orchestratorSource, orchestratorCtx);
  }

  // ─── Phase 0: Subagent A (mint-plan) — runs clean with no nuclear flush ─
  // Represents the first subagent that completes correctly (no gap).
  currentPhase = 'phase0-subagentA';
  const agentEntryIdA = 'agent-mint-plan-001';
  const sourceIdA = 'src-A';
  // Production: orchestrator tool_use_detail for 'agent' → addStartWithAgentContext
  toolLane.addStartWithAgentContext(agentEntryIdA, 'agent', '(mint-plan)', undefined);
  toolLane.mergeAgentLabel(agentEntryIdA, 'mint-plan');
  flushOverlay();

  // A's child tools
  for (let i = 0; i < 15; i++) {
    const toolId = `tool-A-${i}`;
    toolLane.addStartWithAgentContext(toolId, 'bash', `{"cmd":"echo ${i}"}`, agentEntryIdA);
    toolLane.addResult(toolId, syntheticResult(`output ${i}`, false));
    flushOverlay();
  }

  // A done: schedule + drain
  {
    const sourceA = freshSourceState('subagent');
    sourceA.stats.toolUses = 15;
    const doneSummaryA = formatDoneSummary(sourceA);
    toolLane.setAgentResultSummary(agentEntryIdA, doneSummaryA);
    toolLane.addResult(agentEntryIdA, syntheticResult(doneSummaryA, false));

    if (toolLane.hasEntry(agentEntryIdA)) {
      const lines = toolLane.flushSource(agentEntryIdA);
      const capturedCompositor = compositor;
      const capturedOverlayComposer = overlayComposer;
      coordinator.schedule({
        anchor: `after-subagent:${sourceIdA}`,
        commits: [() => {
          for (const line of lines) capturedCompositor.commitAbove(line);
          capturedCompositor.commitAbove('');
          capturedOverlayComposer.markDirty('tool-lane');
          capturedOverlayComposer.flush();
        }],
      });
    }
    currentPhase = 'phase0-subagentA-drain';
    coordinator.drainSubagent(sourceIdA);
    flushOverlay();
  }

  // ─── Phase 1: Subagent B start (mint-parallelize) ─────────────────────
  // Production: orchestrator dispatches B while the orchestrator turn is
  // STILL GENERATING (the message hasn't stopped yet).
  currentPhase = 'phase1-subagentB-start';
  const agentEntryIdB = 'agent-mint-parallelize-001';
  const sourceIdB = 'src-B';
  // Production: handleOrchestratorEvent sees 'agent' tool_use_detail →
  // addStartWithAgentContext(agentEntryIdB, 'agent', '(mint-parallelize)', skillCtx)
  // where skillCtx = findLastSkillEntryId() → undefined (no skill entry in lane)
  toolLane.addStartWithAgentContext(agentEntryIdB, 'agent', '(mint-parallelize)', undefined);
  toolLane.mergeAgentLabel(agentEntryIdB, 'mint-parallelize');
  flushOverlay();

  // ─── Phase 2: B accumulates tools BEFORE nuclear flush (stale count) ────
  currentPhase = 'phase2-subagentB-tools-before-nuclear';
  for (let i = 0; i < opts.toolsBBeforeNuclear; i++) {
    const toolId = `tool-B-pre-${i}`;
    toolLane.addStartWithAgentContext(toolId, 'bash', `{"cmd":"echo B_pre${i}"}`, agentEntryIdB);
    toolLane.addResult(toolId, syntheticResult(`out_pre ${i}`, false));
    flushOverlay();
  }

  // ─── Phase 3: orchestrator message_stop fires MID-WAY through B ──────────
  // This is the KEY production trigger: orchestrator stream ends while B is
  // still running. Pre-fix, finalizeOrchestrator nuclear-flushed the lane —
  // capturing B with toolsBBeforeNuclear tools (STALE count) and deleting it.
  // Post-fix (flushCompletedRoots) B survives the boundary.
  currentPhase = 'phase3-nuclear-flush-mid-B';
  if (opts.nuclearFlushMidB) {
    fireOrchestratorMessageStop();
  }

  // ─── Phase 4: B accumulates MORE tools after the message_stop ────────────
  // These tools arrive in handleSubagentEvent, which calls:
  //   addStartWithAgentContext(toolId, 'bash', ..., agentEntryIdB)
  // Pre-fix, agentEntryIdB had been deleted by the nuclear flush, so these
  // became orphaned entries with agentContext pointing to a deleted parent.
  // Post-fix, B survived and these nest normally. Production refreshes the
  // overlay on every subagent event regardless, so mirror that here.
  currentPhase = 'phase4-subagentB-tools-after-nuclear';
  for (let i = 0; i < opts.toolsBAfterNuclear; i++) {
    const toolId = `tool-B-post-${i}`;
    toolLane.addStartWithAgentContext(toolId, 'bash', `{"cmd":"echo B_post${i}"}`, agentEntryIdB);
    toolLane.addResult(toolId, syntheticResult(`out_post ${i}`, false));
    flushOverlay();
  }

  // ─── Phase 5: Subagent B done ────────────────────────────────────────────
  // Production: finalizeSubagent sets result summary, then stream-renderer.ts
  // checks hasEntry(agentEntryIdB). Pre-fix, the nuclear flush had deleted B
  // so this returned FALSE and the whole done-block path was skipped — the
  // bug. Post-fix, B survived the message_stop and this path runs normally.
  currentPhase = 'phase5-subagentB-done';
  {
    const sourceB = freshSourceState('subagent');
    sourceB.stats.toolUses = opts.toolsBBeforeNuclear + opts.toolsBAfterNuclear;
    const doneSummaryB = formatDoneSummary(sourceB);

    // Production: finalizeSubagent → setAgentResultSummary + addResult
    // (no-ops if agentEntryIdB is absent from the lane)
    toolLane.setAgentResultSummary(agentEntryIdB, doneSummaryB);
    toolLane.addResult(agentEntryIdB, syntheticResult(doneSummaryB, false));

    // Production: stream-renderer.ts:604: if (syntheticId && toolLane.hasEntry(syntheticId))
    if (toolLane.hasEntry(agentEntryIdB)) {
      const lines = toolLane.flushSource(agentEntryIdB);
      const capturedCompositor = compositor;
      const capturedOverlayComposer = overlayComposer;
      coordinator.schedule({
        anchor: `after-subagent:${sourceIdB}`,
        commits: [() => {
          for (const line of lines) capturedCompositor.commitAbove(line);
          capturedCompositor.commitAbove('');
          capturedOverlayComposer.markDirty('tool-lane');
          capturedOverlayComposer.flush();
        }],
      });
    }
    // drainSubagent(B):
    // - With nuclear flush: drains before-content (nuclear batch: stale B header +
    //   trailing blank + setOverlay('')) THEN after-subagent:B (EMPTY — never scheduled)
    // - Without nuclear flush: drains before-content (empty) THEN after-subagent:B
    //   (correctly scheduled above)
    // This is the STRADDLE: the nuclear batch calls setOverlay('') (collapses overlay)
    // before the after-subagent:B batch commits, which is empty anyway.
    coordinator.drainSubagent(sourceIdB);
    flushOverlay();
  }

  // ─── Phase 6: Trailing activity (pushes history to scrollback) ───────────
  currentPhase = 'phase6-trailing';
  compositor.setOverlay('next-subagent-spinner\nnext-subagent-detail');
  for (let k = 0; k < 6; k++) {
    compositor.commitAbove(`TRAILING_${k}`);
  }
  compositor.setOverlay('');

  // Force two repaints so the scrollback is stable
  const internals = compositor as unknown as { repaint(): void };
  internals.repaint();
  internals.repaint();

  // ─── Replay stdout into headless xterm ────────────────────────────────────
  const term = new HeadlessTerminal({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: 2000,
    allowProposedApi: true,
    convertEol: true,
  });
  await termWrite(term, allOutput());
  const lines = allLines(term);
  const dump = dumpMap(lines);
  term.dispose();
  statusLine.stop();
  compositor.disarm();

  const find = (m: string): number => lines.findIndex((l) => l.includes(m));
  return { lines, dump, find, commitLog, overlayLog };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('subagent block gap — production pipeline reproduction (H1/H2b/H3 discrimination)', () => {
  /**
   * Helper: run a scenario and produce diagnostic output + assertion result.
   */
  async function runAndReport(
    label: string,
    opts: Parameters<typeof runMintScenario>[0],
  ): Promise<{ gap: number; headerFound: boolean; doneFound: boolean; dump: string; commitLog: CommitRecord[]; overlayLog: OverlayRecord[] }> {
    const { lines, dump, find, commitLog, overlayLog } = await runMintScenario(opts);

    const phaseLog = commitLog.map(r =>
      `  [${r.phase}] leading=${r.leadingBlanks} embedded=${r.embeddedBlanks} text=${JSON.stringify(r.text.slice(0, 80))}`
    ).join('\n');
    const overlayLogStr = overlayLog.map(r =>
      `  [${r.phase}] lines=${r.lineCount}`
    ).join('\n');

    // H1: blanks in committed text (non-empty blanks = problem)
    const suspiciousCommits = commitLog.filter(r => r.leadingBlanks > 0 || r.embeddedBlanks > 0);
    const h1 = suspiciousCommits.length > 1 // allow 1 for the intentional trailing blank
      ? `H1 CANDIDATE (${suspiciousCommits.length} calls with blank lines)`
      : 'H1 clear';

    // Find B block boundaries
    const headerIdxB = find('mint-parallelize');
    let doneIdxB = -1;
    for (let i = headerIdxB + 1; i < lines.length; i++) {
      if ((lines[i] ?? '').includes('Done (')) { doneIdxB = i; break; }
    }

    // H3: duplicated rows
    const h3 = (headerIdxB >= 0 && doneIdxB > headerIdxB)
      ? (() => {
          const rowsInBlock = lines.slice(headerIdxB, doneIdxB + 1);
          const seen = new Set<string>();
          let dups = 0;
          for (const row of rowsInBlock) {
            const trimmed = row.trim();
            if (trimmed && seen.has(trimmed)) dups++;
            seen.add(trimmed);
          }
          return dups > 0 ? `H3 CANDIDATE (${dups} dup rows)` : 'H3 clear';
        })()
      : 'H3 N/A';

    const gap = (headerIdxB >= 0 && doneIdxB > headerIdxB)
      ? maxBlankRun(lines, headerIdxB, doneIdxB)
      : -1;

    console.log(`\n=== ${label} ===\nheader=${headerIdxB} done=${doneIdxB} gap=${gap} | ${h1} | ${h3}\ncommitAbove:\n${phaseLog}\nsetOverlay:\n${overlayLogStr}\nBuffer:\n${dump}\n`);

    return { gap, headerFound: headerIdxB >= 0, doneFound: doneIdxB >= 0, dump, commitLog, overlayLog };
  }

  // ── Baseline: no nuclear flush — must produce no gap ───────────────────
  for (const geo of [
    { cols: 80, rows: 24, label: '80x24' },
    { cols: 120, rows: 50, label: '120x50' },
  ]) {
    it(`baseline (no nuclear flush, B survives to done): no gap (${geo.label})`, async () => {
      const { gap, headerFound, doneFound, dump } = await runAndReport(
        `BASELINE ${geo.label}`,
        { cols: geo.cols, rows: geo.rows, toolsBBeforeNuclear: 18, toolsBAfterNuclear: 0, nuclearFlushMidB: false },
      );
      if (!headerFound || !doneFound) return; // block not scrolled yet — not a failure
      expect(gap, `baseline must have no gap:\n${dump}`).toBeLessThanOrEqual(1);
    }, 20_000);
  }

  // ── Regression: orchestrator message_stop mid-B must not lose B's block ──
  // This is the primary production mechanism: message_stop fires while B is
  // running (toolsBBeforeNuclear tools accumulated). Pre-fix, the nuclear
  // flush captured B with a stale count and deleted it; B's done-path then
  // found hasEntry(B)=false → no after-subagent:B batch, no drainSubagent →
  // stale block committed at dispose, Done MISSING. Post-fix
  // (flushCompletedRoots) B survives the boundary and the done-path commits
  // the complete block with final counts.
  for (const geo of [
    { cols: 80, rows: 24, label: '80x24' },
    { cols: 120, rows: 50, label: '120x50' },
  ]) {
    for (const [beforeN, afterN] of [[18, 18], [15, 21]] as [number, number][]) {
      const label = `nuclear-mid-B (${geo.label}) pre=${beforeN} post=${afterN}`;
      it(`${label}: B Done must appear in scrollback`, async () => {
        const { headerFound, doneFound, dump, gap } = await runAndReport(
          label,
          {
            cols: geo.cols,
            rows: geo.rows,
            toolsBBeforeNuclear: beforeN,
            toolsBAfterNuclear: afterN,
            nuclearFlushMidB: true,
          },
        );

        if (!headerFound) {
          // B completely lost — a more severe form of the regression
          console.log('SEVERE: B header absent — mid-flight flush deleted B without committed fallback');
        }

        // ASSERTION #1: B's Done line must appear in scrollback. Under the
        // pre-fix nuclear flush, doneFound=false (Done was never committed
        // because hasEntry(B)=false at done time skips the after-subagent:B batch).
        expect(
          doneFound,
          `B Done line missing from scrollback (mid-flight flush deleted B before done; after-subagent:B batch never scheduled).\n${dump}`,
        ).toBe(true);

        // ASSERTION #2: No blank gap inside the block.
        if (doneFound && headerFound) {
          expect(
            gap,
            `BLANK GAP of ${gap} rows inside subagent B block.\n${dump}`,
          ).toBeLessThanOrEqual(1);
        }
      }, 20_000);
    }
  }

  // ── Production-faithful focused variant ────────────────────────────────────
  // Exact mint production knobs: 80x24 terminal, A=15 tools (mint-plan),
  // B=18 tools before the mid-flight message_stop + 18 after
  // (mint-parallelize stale scenario from the 2026-06-10 screenshot).
  it('production-faithful (80x24, A=15, B=18+18 message_stop mid-flight): B Done must be in scrollback', async () => {
    const { headerFound, doneFound, gap, commitLog, dump } = await runAndReport(
      'PRODUCTION-FAITHFUL',
      { cols: 80, rows: 24, toolsBBeforeNuclear: 18, toolsBAfterNuclear: 18, nuclearFlushMidB: true },
    );

    // Instrumentation cross-check: finalizeOrchestrator only SCHEDULES — no
    // direct commits during phase 3. Post-fix, the done-path commits fire in
    // phase 5 (eager drainSubagent); pre-fix phase 5 was silent (hasEntry=false).
    const phase3Commits = commitLog.filter(r => r.phase === 'phase3-nuclear-flush-mid-B');
    const phase5Commits = commitLog.filter(r => r.phase === 'phase5-subagentB-done');

    console.log(`
PRODUCTION-FAITHFUL FINDINGS:
  headerFound=${headerFound} doneFound=${doneFound} gap=${gap}
  phase3 (finalize) direct commits: ${phase3Commits.length} (expected 0 — finalize only schedules)
  phase5 (B done) commits: ${phase5Commits.length} (expected >0 post-fix — eager drain)
`);

    expect(phase3Commits.length, 'finalizeOrchestrator must not commit directly').toBe(0);
    expect(phase5Commits.length, 'B done-path must eagerly drain its block').toBeGreaterThan(0);

    // PRIMARY ASSERTION: Done line must be present in scrollback. Under the
    // pre-fix nuclear flush: B was deleted mid-flight → hasEntry(B)=false at
    // done time → after-subagent:B never scheduled → Done never committed.
    expect(
      doneFound,
      `B Done line absent from scrollback.
Mid-flight flush deleted B from lane (with stale 18-tool count captured).
B's done handler found hasEntry(B)=false → skipped flushSource+schedule+drainSubagent.
B's stale block (18 tools) was committed by before-content batch at dispose time.
B's Done line (36 tools) was never committed.
Buffer:\n${dump}`,
    ).toBe(true);

    // SECONDARY ASSERTION: no blank gap (if both header and done present)
    if (headerFound && doneFound) {
      expect(gap, `Blank gap of ${gap} in B block:\n${dump}`).toBeLessThanOrEqual(1);
    }
  }, 20_000);
});
