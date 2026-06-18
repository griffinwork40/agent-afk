/**
 * Tests for ToolLane.getOverlay — overlay-rendering cluster.
 *
 * Verbatim extraction from tool-lane.test.ts (pure test reorganization).
 * No assertion bodies or test logic were changed.
 *
 * Contains: Spine renderer scenarios, MAX_OVERLAY_ROOTS sliding cap,
 * childless NESTING head anchors, scrollback suppression, anonymous anchors,
 * anonymous-anchor invariant, headerEmitted nested skill silence,
 * depth-2 ghost row, committed spine continuity, band/overlay reconciliation,
 * and severed-spine regression tests.
 */

import { describe, it, expect } from 'vitest';
import { ToolLane } from './tool-lane.js';
import { displayWidth, stripAnsi } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';

function makeResult(content: string, isError = false): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 'unused',
    content,
    isError,
  };
}

// ─── Spine renderer scenarios (commit-2 build plan §C) ────────────────────────
//
// Visual scenarios exercising the left-anchored spine + turn-root marker that
// distinguish the spine renderer from the prior `├ └` tree:
//   - sequential 1 subagent (baseline shape)
//   - parallel-3 (sibling Agents — three spines, three turn-roots)
//   - nested-2 (Agent inside Agent — outer spine continues past inner)
//   - abort (Agent without a Done synthetic — spine still renders)
//   - ASCII fallback (AGENT_AFK_ASCII=1 swaps `│ ├─ ╰─ ◉` for `| +- \- o`)
//
// These pin the topology shape end-to-end. Pure-function property tests for
// the connector contract live under `assignConnectors` above; these focus on
// the composed, end-to-end output where columns + glyphs must agree.
describe('Spine renderer scenarios', () => {
  it('sequential — single subagent block renders ◉-rooted spine', () => {
    const lane = new ToolLane();
    const agentId = '__synth_spine_seq';
    lane.addStartWithAgentContext(agentId, 'Agent', '(diagnose)', undefined);
    lane.addStartWithAgentContext('s1', 'Read', '("abort-graph.ts")', agentId);
    lane.addResult('s1', makeResult('144 lines'));
    lane.setAgentResultSummary(agentId, 'Done (1 tool · 1.5s)');
    lane.addResult(agentId, {
      type: 'tool_result', toolUseId: 'synthetic', content: 'Done (1 tool · 1.5s)', isError: false,
    });
    const output = stripAnsi(lane.flush().join('\n'));
    // The turn-root marker anchors the topology at col 0.
    expect(output.split('\n')[0]).toMatch(/^◉ /);
    // The spine column sits directly under the turn-root.
    expect(output.split('\n')[1]).toMatch(/^│ /);
    // Last sibling uses the rounded corner.
    expect(output.split('\n').slice(-1)[0]).toMatch(/^│ ╰─ /);
    expect(output).toMatchSnapshot();
  });

  it('parallel — three sibling Agents each get their own turn-root + spine', () => {
    const lane = new ToolLane();
    for (const [agentId, label] of [
      ['__synth_par_A', '(anthropic-port)'],
      ['__synth_par_B', '(openai-port)'],
      ['__synth_par_C', '(codex-port)'],
    ] as const) {
      lane.addStartWithAgentContext(agentId, 'Agent', label, undefined);
      lane.addStartWithAgentContext(`${agentId}_t`, 'Edit', `("${label.slice(1, -1)}.ts")`, agentId);
      lane.addResult(`${agentId}_t`, makeResult('edited'));
      lane.setAgentResultSummary(agentId, 'Done (1 tool · 2.0s)');
      lane.addResult(agentId, {
        type: 'tool_result', toolUseId: 'synthetic', content: 'Done (1 tool · 2.0s)', isError: false,
      });
    }
    const output = stripAnsi(lane.flush().join('\n'));
    const turnRootRows = output.split('\n').filter((l) => l.startsWith('◉ '));
    // Three subagent dispatches → three turn-root markers.
    expect(turnRootRows).toHaveLength(3);
    // Each turn-root row labels its agent by name.
    expect(turnRootRows[0]).toContain('anthropic-port');
    expect(turnRootRows[1]).toContain('openai-port');
    expect(turnRootRows[2]).toContain('codex-port');
    expect(output).toMatchSnapshot();
  });

  it('nested — Agent inside Agent: outer spine continues past inner block', () => {
    // Topology: mint > [Read, gather > [Read, Grep], Done]
    const lane = new ToolLane();
    const outer = '__synth_nest_outer';
    const inner = '__synth_nest_inner';
    lane.addStartWithAgentContext(outer, 'Agent', '(mint)', undefined);
    lane.addStartWithAgentContext('o_t1', 'Read', '("daemon.ts")', outer);
    lane.addResult('o_t1', makeResult('311 lines'));
    lane.addStartWithAgentContext(inner, 'Agent', '(gather)', outer);
    lane.addStartWithAgentContext('i_t1', 'Read', '("cron.ts")', inner);
    lane.addResult('i_t1', makeResult('42 lines'));
    lane.addStartWithAgentContext('i_t2', 'Grep', '("interval")', inner);
    lane.addResult('i_t2', makeResult('6 matches'));
    lane.addResult(inner, makeResult('inner done'));
    lane.setAgentResultSummary(outer, 'Done (4 tools · 8.0s)');
    lane.addResult(outer, {
      type: 'tool_result', toolUseId: 'synthetic', content: 'Done (4 tools · 8.0s)', isError: false,
    });
    const output = stripAnsi(lane.flush().join('\n'));
    // Outer turn-root at col 0.
    expect(output.split('\n')[0]).toMatch(/^◉ /);
    // Inner Agent rows live under the outer spine — they start with the
    // outer's `│ ` then the connector for the inner block.
    const innerHead = output.split('\n').find((l) => l.includes('gather'));
    expect(innerHead).toBeDefined();
    expect(innerHead!).toMatch(/^│ ├─ /);
    // Grandchildren of the outer (inner's tool calls) carry TWO spine cols:
    // outer's `│ ` (cols 0-1) + inner's `│ ` (cols 2-3) + connector.
    const innerFirstChild = output.split('\n').find((l) => l.includes('cron.ts'));
    expect(innerFirstChild).toBeDefined();
    expect(innerFirstChild!).toMatch(/^│ │ ├─ /);
    expect(output).toMatchSnapshot();
  });

  it('abort — Agent without a Done synthetic still renders spine + children', () => {
    // Scenario: subagent dispatched, a few tools ran, then aborted before
    // a Done summary was attached. The lane should still render the head
    // row, the spine, and the tools that did run — no synthetic "Done"
    // line. Note: flush() filters out entries without a `result` (only
    // settled trees flow into scrollback). To exercise the spine on an
    // unfinished Agent we mark the Agent itself as resulted (mirrors the
    // streaming path's `tool_result` on the synthetic agent id) but skip
    // setAgentResultSummary so no Done synthetic is appended.
    const lane = new ToolLane();
    const agentId = '__synth_abort';
    lane.addStartWithAgentContext(agentId, 'Agent', '(aborted)', undefined);
    lane.addStartWithAgentContext('a1', 'Read', '("file.ts")', agentId);
    lane.addResult('a1', makeResult('partial'));
    // Agent settles WITHOUT setAgentResultSummary — no Done line should appear.
    lane.addResult(agentId, {
      type: 'tool_result', toolUseId: 'synthetic', content: 'aborted', isError: false,
    });
    const output = stripAnsi(lane.flush().join('\n'));
    expect(output).toMatch(/^◉ /);
    expect(output).toContain('Read');
    // No Done synthetic since setAgentResultSummary was never called —
    // the last row is the Read sibling, with the LAST connector promoting it.
    expect(output).not.toContain('Done');
    expect(output.split('\n').slice(-1)[0]).toMatch(/^│ ╰─ /);
    expect(output).toMatchSnapshot();
  });

  it('ASCII fallback — AGENT_AFK_ASCII=1 swaps box-drawing for ASCII glyphs', () => {
    // Width-equivalent ASCII set: `|` for `│`, `+-` for `├─`, `\-` for `╰─`,
    // `o` for `◉`. Box-drawing glyphs must be completely absent from output.
    const prevAscii = process.env['AGENT_AFK_ASCII'];
    process.env['AGENT_AFK_ASCII'] = '1';
    try {
      const lane = new ToolLane();
      const agentId = '__synth_ascii';
      lane.addStartWithAgentContext(agentId, 'Agent', '(ascii)', undefined);
      lane.addStartWithAgentContext('a1', 'Read', '("x.ts")', agentId);
      lane.addResult('a1', makeResult('10 lines'));
      lane.setAgentResultSummary(agentId, 'Done (1 tool · 0.5s)');
      lane.addResult(agentId, {
        type: 'tool_result', toolUseId: 'synthetic', content: 'Done (1 tool · 0.5s)', isError: false,
      });
      const output = stripAnsi(lane.flush().join('\n'));
      // ASCII glyphs present at the topology positions.
      expect(output.split('\n')[0]).toMatch(/^o /);
      expect(output.split('\n')[1]).toMatch(/^\| /);
      expect(output).toContain('+- ');
      expect(output).toContain('\\- ');
      // Box-drawing glyphs must NOT leak through.
      expect(output).not.toMatch(/[│├╰─]/);
      expect(output).toMatchSnapshot();
    } finally {
      if (prevAscii === undefined) {
        delete process.env['AGENT_AFK_ASCII'];
      } else {
        process.env['AGENT_AFK_ASCII'] = prevAscii;
      }
    }
  });

  it('depth-2 last-sibling ancestor: grandchild indent uses spineClosed ("  ") not spine ("│ ")', () => {
    // Nit 4: when the inner Agent is the LAST sibling at its level
    // (isLast=true), its spine column should use spineClosed ('  ') in the
    // grandchild's indent — not the live spine ('│ '). This verifies that
    // the ancestorIsLast vector (pushed in renderFlushChildren as
    // [...ancestorIsLast, isLast]) flows correctly into the recursive call
    // for grandchildren.
    //
    // Topology: outer Agent (only child at root)
    //              └─ inner Agent (only child of outer, so isLast=true)
    //                    └─ leaf Read (grandchild, only child of inner)
    //
    // Note: setAgentResultSummary adds a Done synthetic AFTER the real
    // children, making the real child a mid-sibling rather than last.
    // We intentionally do NOT call setAgentResultSummary on outer so that
    // inner is the actual last sibling and receives the '╰─ ' connector.
    //
    // buildIndent behaviour for grandchild:
    //   - ancestorIsLast = [true]  (inner was last at the outer level)
    //   - loop: out += spineClosed ('  ')  (outer ancestor's closed slot)
    //   - post-loop: out += g.spine ('│ ')  (inner's own active spine)
    //   → indent = '  │ '
    //
    // Contrast: if isLast had been false (inner was mid-sibling), the loop
    // would emit g.spine ('│ ') for the outer slot → indent = '│ │ '.
    const lane = new ToolLane();
    const outer = '__nit4_outer';
    const inner = '__nit4_inner';
    lane.addStartWithAgentContext(outer, 'Agent', '(outer-last)', undefined);
    lane.addStartWithAgentContext(inner, 'Agent', '(inner-last)', outer);
    lane.addStartWithAgentContext('leaf', 'Read', '("leaf.ts")', inner);
    lane.addResult('leaf', makeResult('leaf contents'));
    lane.setAgentResultSummary(inner, 'Done (1 tool · 0.5s)');
    lane.addResult(inner, {
      type: 'tool_result', toolUseId: 'synthetic', content: 'Done (1 tool · 0.5s)', isError: false,
    });
    // Outer settles WITHOUT setAgentResultSummary — no Done synthetic is added
    // for outer, so inner remains the actual last child of outer (isLast=true).
    lane.addResult(outer, {
      type: 'tool_result', toolUseId: 'synthetic', content: 'done', isError: false,
    });

    const output = stripAnsi(lane.flush().join('\n'));
    const lines = output.split('\n');

    // Outer Agent is the only root child → it uses the turn-root marker at col 0.
    expect(lines[0]).toMatch(/^◉ /);
    expect(lines[0]).toContain('outer-last');

    // Inner Agent is the only child of outer (no resultSummary synthetic on outer)
    // → inner receives the LAST connector ('╰─ ').
    // Its indent = buildIndent([], g) = g.spine ('│ ') [outer's active spine].
    // So inner's row starts with: '│ ' + '╰─ ' = '│ ╰─ '.
    const innerHead = lines.find((l) => l.includes('inner-last'));
    expect(innerHead).toBeDefined();
    expect(innerHead!).toMatch(/^│ ╰─ /);

    // Grandchild (leaf Read) carries the ancestorIsLast=[true] vector:
    //   buildIndent([true], g) → spineClosed ('  ') + g.spine ('│ ') = '  │ '
    // So leaf's row starts with '  │ ', NOT '│ │ ' (which would mean inner's
    // isLast was false and the outer spine slot remained open).
    const leafLine = lines.find((l) => l.includes('leaf.ts'));
    expect(leafLine).toBeDefined();
    expect(leafLine!).toMatch(/^  │ /);
    // Negative: '│ │ ' would mean the ancestor slot was NOT closed.
    expect(leafLine!).not.toMatch(/^│ │ /);
  });

  /**
   * Regression: subagent text-child narration must not re-open the spine
   * column that the last tool-child's `╰─` connector just closed.
   *
   * Bug (screenshot): inside a parent Agent with tool children followed by
   * an assistant-text narration, the narration row rendered at the parent's
   * own indent — emitting `│` at the same column the `╰─` row above just
   * closed. The eye reads the `│` below `╰─` as a *re-opened* branch,
   * visually severing the topology spine between this Agent and any
   * subsequent sibling rendered below.
   *
   * Fix: textChildren render with `buildIndent([...ancestorIsLast, true], g)`,
   * which treats the text as appearing AFTER the last tool sibling — the
   * parent's spine slot becomes `spineClosed` (`'  '`) in the text-child
   * indent, NOT `g.spine` (`'│ '`). So the narration row leads with `'  │ '`
   * (closed parent + text gutter), not `'│ │ '` (parent reopened).
   *
   * Pins tool-lane-render.ts:805–807 (overlay) and :917–919 (flush).
   */
  it('text-child narration after last ╰─ closes the parent spine (no re-open)', () => {
    const lane = new ToolLane();
    const agentId = '__synth_text_after_last';
    lane.addStartWithAgentContext(agentId, 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('t1', 'Read', '("a.ts")', agentId);
    lane.addResult('t1', makeResult('10 lines'));
    lane.addStartWithAgentContext('t2', 'Grep', '("foo")', agentId);
    lane.addResult('t2', makeResult('3 matches'));
    lane.upsertTextChild('text-1', agentId, 'narration after the last tool');
    lane.addResult(agentId, makeResult('done'));

    const output = stripAnsi(lane.flush().join('\n'));
    const narrationLine = output.split('\n').find((l) => l.includes('narration after the last tool'));
    expect(narrationLine).toBeDefined();
    // Closed parent-spine slot at cols 0-1 ('  '), then text gutter `│ ` at
    // cols 2-3. Pre-fix output was `│ │ narration…` (parent reopened).
    expect(narrationLine!).toMatch(/^  │ /);
    expect(narrationLine!).not.toMatch(/^│ │ /);
  });

  /**
   * Pins the overlay path of the textIndent fix at renderOverlayChildren
   * (tool-lane-render.ts textChildren loop). The existing test above only
   * exercises the flush() path (renderFlushChildren); this test drives
   * getOverlay() via upsertTextChild() to confirm the same `'  │ '` prefix
   * appears in the live overlay frame — NOT the pre-fix `'│ │ '` form that
   * re-opened a closed branch.
   *
   * Drive path: getOverlay() after upsertTextChild() — the overlay text-child
   * indent path (renderOverlayChildren textChildren loop) that the M4 finding
   * identified as unexercised by the existing suite.
   */
  it('overlay text-child narration prefix matches ^  │  (not ^│ │ )', () => {
    const lane = new ToolLane();
    const agentId = '__synth_overlay_text_indent';
    lane.addStartWithAgentContext(agentId, 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('t1', 'Read', '("a.ts")', agentId);
    lane.addResult('t1', makeResult('10 lines'));
    lane.upsertTextChild('text-1', agentId, 'overlay narration after the last tool');

    // Agent has NOT received addResult — still in-flight, so getOverlay()
    // renders the live overlay frame including text children.
    const overlay = stripAnsi(lane.getOverlay());
    const narrationLine = overlay.split('\n').find((l) =>
      l.includes('overlay narration after the last tool'),
    );
    expect(narrationLine).toBeDefined();
    // Closed parent-spine slot at cols 0-1 ('  '), then text gutter `│ ` at
    // cols 2-3. Pre-fix output was `│ │ narration…` (parent spine re-opened).
    // Pins the overlay path of renderOverlayChildren textChildren indent.
    expect(narrationLine!).toMatch(/^  │ /);
    expect(narrationLine!).not.toMatch(/^│ │ /);
  });

  /**
   * Regression: narration with a single unbreakable token wider than the
   * text wrap budget must not overflow the terminal and hard-wrap to col 0.
   *
   * `renderTextChildLines` calls `wrapToWidth(hard:false)`, which leaves
   * tokens larger than maxWidth on a single line. Without `clampLineToTerminal`,
   * the composed `indent + textPrefix + token` exceeds `cols` and the
   * terminal soft-wraps the overflow to column 0 with no spine glyph —
   * an orphaned flush-left continuation that severs the topology spine.
   *
   * Pins the per-line clamp added at tool-lane-render.ts:805–807 and :917–919.
   */
  it('text-child narration with an oversized token stays within terminal width', () => {
    const lane = new ToolLane();
    const cols = process.stdout.columns ?? 88;
    const agentId = '__synth_text_overflow';
    lane.addStartWithAgentContext(agentId, 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('t1', 'Read', '("a.ts")', agentId);
    lane.addResult('t1', makeResult('10 lines'));
    // Token wider than (cols - indent - prefix - safety) — exercises the
    // wrapToWidth(hard:false) escape hatch. Real-world example: a long
    // identifier or URL with no break opportunity.
    const longToken = 'a'.repeat(cols + 20);
    lane.upsertTextChild('text-1', agentId, `prefix ${longToken} suffix`);
    lane.addResult(agentId, makeResult('done'));

    const output = lane.flush().join('\n');
    for (const line of output.split('\n')) {
      expect(
        displayWidth(stripAnsi(line)),
        `narration line exceeds terminal width (${cols}): ${JSON.stringify(line)}`,
      ).toBeLessThanOrEqual(cols);
    }
  });

  /**
   * L2 coverage gap — Agent with text children but NO tool children
   * exercises the `else` branch of the textIndent guard at
   * tool-lane-render.ts:834 (overlay) and :970 (flush):
   *
   *     const textIndent = toolChildren.length > 0
   *       ? buildIndent([...ancestorIsLast, true], g)  // ← all 6 M4-fix tests hit this
   *       : indent;                                    // ← previously unexercised
   *
   * The fallback branch (`: indent`) applies when an Agent has no rendered
   * tool siblings — only text children. Without this branch, the text-row
   * indent would be extended by a phantom `spineClosed` slot (2 cells) and
   * the narration would shift two columns to the right of where its
   * parent's spine connector sits.
   *
   * Drive path: subagent that does no tool work but emits text narration
   * before completing — e.g. an analysis agent that synthesizes findings
   * inline without dispatching nested children.
   */
  it('text-child narration under Agent with zero tool children uses base indent (no phantom spine slot)', () => {
    const lane = new ToolLane();
    const agentId = '__synth_text_only_agent';
    lane.addStartWithAgentContext(agentId, 'Agent', '(researcher)', undefined);
    // No addStartWithAgentContext for tool children — toolChildren.length === 0.
    lane.upsertTextChild('text-1', agentId, 'inline narration with no tool calls');
    lane.addResult(agentId, makeResult('done'));

    const output = stripAnsi(lane.flush().join('\n'));
    const narrationLine = output.split('\n').find((l) => l.includes('inline narration'));
    expect(narrationLine).toBeDefined();
    // Fallback path: textIndent === indent (no `[..., true]` extension).
    // For a root-level Agent, `indent === ''`, so the narration row starts
    // with the text-prefix gutter `│ ` directly at col 0 — NOT shifted
    // right by an extra `  ` from the phantom spineClosed slot.
    expect(narrationLine!).toMatch(/^│ /);
    // Defensive: must not start with the would-be phantom-indented form.
    expect(narrationLine!).not.toMatch(/^  │ /);
  });

  /**
   * L2 coverage gap — overlay variant of the empty-toolChildren branch.
   * Drives the live-overlay path (getOverlay) rather than the scrollback
   * path (flush) to exercise the same `else` branch at
   * tool-lane-render.ts:834 in the overlay render pipeline.
   */
  it('overlay text-child narration under Agent with zero tool children uses base indent', () => {
    const lane = new ToolLane();
    const agentId = '__synth_overlay_text_only';
    lane.addStartWithAgentContext(agentId, 'Agent', '(researcher)', undefined);
    lane.upsertTextChild('text-1', agentId, 'overlay narration with no tool calls');

    const overlay = stripAnsi(lane.getOverlay());
    const narrationLine = overlay
      .split('\n')
      .find((l) => l.includes('overlay narration with no tool calls'));
    expect(narrationLine).toBeDefined();
    // Same invariant as the flush test above: base-indent path, no phantom
    // spineClosed extension.
    expect(narrationLine!).toMatch(/^│ /);
    expect(narrationLine!).not.toMatch(/^  │ /);
  });

  /**
   * Regression: a root-level Agent's thinkingTail (in-flight ⌇ narration)
   * must carry the Agent's spine glyph at col 0, not leading whitespace.
   *
   * Pre-fix prefix was `'    '` (4 plain spaces) → the row showed
   * `'    ⌇ thinking…'` with col 0 empty. The Agent's children below carry
   * `│ ` at col 0 (their parent's live spine), so the tail row left a
   * spine-shaped gap between the Agent head and its children — visually
   * severing the topology.
   *
   * Fix at tool-lane.ts:374 (NESTING_TOOLS branch — tail after children)
   * and :402 (childless Agent branch — tail under the `…` line).
   */
  it('overlay thinkingTail under in-flight Agent carries spine at col 0', () => {
    const lane = new ToolLane();
    const agentId = '__synth_tail_with_children';
    lane.addStartWithAgentContext(agentId, 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('t1', 'Read', '("a.ts")', agentId);
    lane.addResult('t1', makeResult('10 lines'));
    lane.setThinkingTail(agentId, 'still thinking about the next step');

    const overlay = stripAnsi(lane.getOverlay());
    const tailLine = overlay.split('\n').find((l) => l.includes('⌇') && l.includes('still thinking'));
    expect(tailLine).toBeDefined();
    // `│ ` at col 0 (Agent's spine), then padding before `⌇`. Pre-fix
    // output started with 4 plain spaces, breaking the spine column.
    expect(tailLine!).toMatch(/^│ /);
    expect(tailLine!).not.toMatch(/^    ⌇/);
  });

  it('overlay thinkingTail under childless Agent carries spine at col 0', () => {
    // Childless branch (line 402): no tool children yet — tail hangs
    // directly under the `… ` waiting indicator. The Agent's spine is
    // still active (the Agent hasn't settled), so col 0 must be `│`.
    const lane = new ToolLane();
    const agentId = '__synth_tail_childless';
    lane.addStartWithAgentContext(agentId, 'Agent', '(researcher)', undefined);
    lane.setThinkingTail(agentId, 'first thought before any tool');

    const overlay = stripAnsi(lane.getOverlay());
    const tailLine = overlay.split('\n').find((l) => l.includes('⌇') && l.includes('first thought'));
    expect(tailLine).toBeDefined();
    expect(tailLine!).toMatch(/^│ /);
    expect(tailLine!).not.toMatch(/^    ⌇/);
  });

  /**
   * Pins the nested renderOverlayChildren thinkingTail path (NESTING_TOOLS
   * branch with grandchildren) — unexercised by the root-level thinkingTail
   * tests, which drive the code path in tool-lane.ts (~line 381/413).
   *
   * Topology: outer Agent (root) → inner Agent (child, isLast=true) → leaf
   * tool (grandchild). Setting thinkingTail on the inner Agent causes
   * getOverlay() to recurse into renderOverlayChildren for the outer's
   * children, find the inner Agent has grandchildren, recurse into them,
   * THEN emit the `⌇` line via:
   *
   *   const tailIndentColored = colorizeIndent(
   *     buildIndent([...ancestorIsLast, isLast], g), g
   *   );
   *   lines.push(clampLineToTerminal(
   *     tailIndentColored + palette.thinking('⌇  ' + …), cols
   *   ));
   *
   * Column-alignment invariant: the tail uses the grandchild-frame indent
   * ([...ancestorIsLast, isLast]) so `⌇` aligns with the `├` / `╰`
   * connectors on the Agent's child rows at every nesting depth.
   *
   * For depth 1 (inner Agent is outer's only / last child, isLast=true):
   *   tailIndent = buildIndent([true], g) = '  │ '
   *   ANSI-stripped tail row: '  │ ⌇  reviewing…'
   *   col-0 is a space (parent spine closed by the inner Agent's `╰─`);
   *   `⌇` aligns with the grandchild `├` / `╰` connector column.
   *
   * The buggy form used the current frame's `indentColored` (depth 0,
   * buildIndent([], g) = '│ '), which re-opened the parent's col-0 spine
   * and placed `⌇` one slot too shallow ('│ ⌇  …' instead of '  │ ⌇  …').
   *
   * Key distinguisher from the no-grandchild path (in-progress else branch):
   * - Without grandchildren: `continuationIndent + '⌇'`
   *   → ANSI-stripped: `│     ⌇` (5 chars before `⌇`). That path is
   *   intentionally NOT touched — the tail hangs UNDER a leaf tool row, not
   *   as a sibling of children.
   *
   * Positive assertion (`/^  │ ⌇  /`): correct grandchild-frame indent — col-0
   * closed by the inner Agent's last-child `╰─` (isLast close-below).
   * Negative assertion (`/^│ ⌇/`): rules out the too-shallow buggy form.
   * Second negative assertion (`/^│     ⌇/`): rules out the leaf fallback.
   */
  it('grandchild Agent thinkingTail via renderOverlayChildren has correct nested prefix', () => {
    const lane = new ToolLane();
    const outerAgentId = '__synth_gc_outer';
    const innerAgentId = '__synth_gc_inner';
    // Outer root Agent
    lane.addStartWithAgentContext(outerAgentId, 'Agent', '(orchestrator)', undefined);
    // Inner Agent — child of outer (isLast=true: only child, but overlay always-open)
    lane.addStartWithAgentContext(innerAgentId, 'Agent', '(researcher)', outerAgentId);
    // Grandchild leaf tool — gives the inner Agent grandchildren so the
    // NESTING_TOOLS-with-grandchildren branch fires at renderOverlayChildren
    // (`if (NESTING_TOOLS.has(child.toolName) && grandchildren.length > 0)`)
    lane.addStartWithAgentContext('gc-tool-1', 'Read', '("plan.ts")', innerAgentId);
    lane.addResult('gc-tool-1', makeResult('55 lines'));
    // Set thinkingTail on the inner Agent — rendered at the NESTING_TOOLS
    // post-grandchildren path (not the root-level path in tool-lane.ts).
    lane.setThinkingTail(innerAgentId, 'reviewing the plan before next step');

    const overlay = stripAnsi(lane.getOverlay());
    const tailLine = overlay
      .split('\n')
      .find((l) => l.includes('⌇') && l.includes('reviewing the plan'));
    expect(tailLine).toBeDefined();
    // Grandchild-frame indent: buildIndent([true], g) = '  │ ' — the inner Agent
    // is the outer's last child, so its `╰─` CLOSES col-0 beneath it (isLast).
    // ANSI-stripped: '  │ ⌇  reviewing…' — blank col 0, │ at col 2, ⌇ at col 4.
    expect(tailLine!).toMatch(/^  │ ⌇  /);
    // Buggy form: current frame's shallow indent (buildIndent([], g) = '│ ')
    // would produce '│ ⌇  …' — missing the grandchild depth slot.
    expect(tailLine!).not.toMatch(/^│ ⌇/);
    // The leaf-tool continuation path (continuationIndent + '⌇') produces
    // '│     ⌇' (5 chars before '⌇'). Negative pin confirms the grandchild
    // path fired rather than the fallback.
    expect(tailLine!).not.toMatch(/^│     ⌇/);
  });

  /**
   * Pins the column alignment between thinkingTail content and tool-child
   * content under a root-level Agent. Before the alignment fix, tail
   * content landed at col 6 (`│   ⌇ <content>`) while tool-child content
   * landed at col 5 (`│ ╰─ <content>`) — a 1-col visual drift that read
   * as a broken spine when both rows were on screen together.
   *
   * Post-fix prefix is `dim(g.spine) + '⌇  '` (5 cells): `│` at col 0,
   * `⌇` at col 2 (parallel to `├` / `╰`), content at col 5 (parallel to
   * child content). Regression sentinel against any future change that
   * re-introduces the `g.spineClosed` cushion at this site.
   */
  it('overlay thinkingTail content column aligns with tool-child content column', () => {
    const lane = new ToolLane();
    const agentId = '__synth_tail_align';
    lane.addStartWithAgentContext(agentId, 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('t1', 'bash', '(echo hi)', agentId);
    lane.addResult('t1', makeResult('hi'));
    lane.setThinkingTail(agentId, 'narration content');

    const overlay = stripAnsi(lane.getOverlay());
    const childLine = overlay
      .split('\n')
      .find((l) => l.includes('bash') && l.includes('echo hi'));
    const tailLine = overlay
      .split('\n')
      .find((l) => l.includes('⌇') && l.includes('narration content'));
    expect(childLine).toBeDefined();
    expect(tailLine).toBeDefined();

    // Both rows: `│ <connector><pad><content>`. The connector + pad spans
    // 3 cells (`╰─ ` for child, `⌇  ` for tail), placing content at col 5
    // in both. The 1-col drift pre-fix had tail content at col 6.
    const childContentCol = childLine!.indexOf('$ bash');
    const tailContentCol = tailLine!.indexOf('narration content');
    expect(childContentCol).toBe(5);
    expect(tailContentCol).toBe(5);

    // Glyph alignment: `⌇` sits at the same column as the `╰` connector
    // glyph in the child row above, signaling the row's structural slot.
    const childGlyphCol = childLine!.indexOf('╰');
    const tailGlyphCol = tailLine!.indexOf('⌇');
    expect(childGlyphCol).toBe(2);
    expect(tailGlyphCol).toBe(2);
  });

  /**
   * Regression: nested agent thinking-tail aligns with its tool children,
   * not the parent spine.
   *
   * Topology: outer nesting-tool Agent (root) → inner Agent (child, depth 1)
   * → two leaf tool grandchildren. The inner Agent has a thinkingTail set
   * while its grandchildren are in-flight.
   *
   * Correct geometry (ANSI-stripped, isLast close-below — the inner Agent is the
   * outer's LAST child, so its `╰─` closes col-0 beneath it):
   *
   *   "◉ "                                ← outer Agent header (root row)
   *   "│ ╰─ → Agent(diagnose-…)"          ← inner Agent row (last child of outer)
   *   "  │ ├─ ● glob …"                   ← grandchild 1 (mid connector, col-0 closed)
   *   "  │ ╰─ ● grep …"                   ← grandchild 2 (last connector, col-0 closed)
   *   "  │ ⌇  claim…"                     ← CORRECT: grandchild-frame indent, col-0 closed
   *   "│ │ ⌇  claim…"                     ← WRONG (rejected): open │ below a `╰─` (severed)
   *
   * Assertions:
   *   - tail row col-0 is a space (the inner Agent's `╰─` closed the outer spine)
   *   - tail row matches /^  │ ⌇  / (grandchild-frame depth, col-0 closed)
   *   - index of '⌇' in tail equals index of '├' or '╰' in a grandchild row
   *
   * This exercises renderOverlayChildren (tool-lane-render-children.ts) using
   * tailIndentColored = colorizeIndent(buildIndent([...ancestorIsLast, isLast]), g)
   * — the tail tracks the grandchild frame, which closes col-0 below a last child.
   */
  it('nested agent thinking-tail aligns with its tool children, not the parent spine', () => {
    const lane = new ToolLane();
    const outerAgentId = '__reg_nested_tail_outer';
    const innerAgentId = '__reg_nested_tail_inner';

    // Outer root Agent (the parent nesting tool)
    lane.addStartWithAgentContext(outerAgentId, 'agent', '(diagnose)', undefined);
    // Inner Agent — only/last child of outer, so its `╰─` closes col-0 below it
    lane.addStartWithAgentContext(innerAgentId, 'agent', '(diagnose-git-research)', outerAgentId);
    // Two grandchildren — so NESTING_TOOLS-with-grandchildren path fires
    lane.addStartWithAgentContext('reg-gc-1', 'glob', '(agent-afk)', innerAgentId);
    lane.addResult('reg-gc-1', makeResult('12 matches'));
    lane.addStartWithAgentContext('reg-gc-2', 'grep', '(pattern)', innerAgentId);
    // reg-gc-2 still in-flight (no result yet) — simulates live overlay
    // Set thinkingTail on the inner Agent
    lane.setThinkingTail(innerAgentId, '"claim": some in-flight narration from the inner agent');

    const overlay = stripAnsi(lane.getOverlay());
    const lines = overlay.split('\n').filter((l) => l.length > 0);

    const tailLine = lines.find((l) => l.includes('⌇') && l.includes('claim'));
    expect(tailLine).toBeDefined();

    // col-0 must be a space — the inner Agent is the outer's last child, so its
    // `╰─` closes the outer spine column beneath it (isLast close-below).
    expect(tailLine![0]).toBe(' ');

    // Grandchild-frame indent: buildIndent([true], g) = '  │ ' (col-0 closed)
    // Tail row: '  │ ⌇  …' — blank col 0, │ at col 2, ⌇ at col 4
    expect(tailLine!).toMatch(/^  │ ⌇  /);

    // Buggy form (too shallow): '│ ⌇  …' — missing grandchild depth slot
    expect(tailLine!).not.toMatch(/^│ ⌇ /);

    // ⌇ must align with the connector column of a grandchild row (├ or ╰)
    const grandchildLine = lines.find((l) => l.includes('glob') || l.includes('grep'));
    expect(grandchildLine).toBeDefined();
    const connectorCol = grandchildLine!.search(/[├╰]/);
    const tailGlyphCol = tailLine!.indexOf('⌇');
    expect(connectorCol).toBeGreaterThan(0);
    expect(tailGlyphCol).toBe(connectorCol);
  });

  /**
   * Regression (H2 — PR #470 review): text-child narration after
   * `agentResultSummary` must use a closed-spine indent even when the Agent
   * has ZERO ToolEntry children.
   *
   * Bug: when `toolChildren.length === 0` but `agentResultSummary != null`,
   * `addResultSummarySynthetic` injects a synthetic sibling that receives the
   * `╰─` connector — closing the parent's spine slot. The old guard
   * (`toolChildren.length > 0`) evaluated to `false`, so textIndent fell back
   * to bare `indent`, emitting `│` at the same column the `╰─` synthetic just
   * closed. The eye reads the `│` as a re-opened branch, severing the spine
   * topology in scrollback.
   *
   * Fix: guard widened to `(toolChildren.length > 0 || agentResultSummary != null)`
   * so that the resultSummary synthetic counts as a real last-connector emitter
   * and the text-child indent extends one slot (treating it as appearing AFTER
   * the `╰─` row).
   *
   * Pins tool-lane-render.ts renderFlushChildren textIndent guard (~line 965).
   */
  it('text-child narration after agentResultSummary ╰─ closes the parent spine (zero tool children)', () => {
    const lane = new ToolLane();
    const agentId = '__synth_text_after_summary_no_tools';
    lane.addStartWithAgentContext(agentId, 'Agent', '(analyst)', undefined);
    // NO tool children — toolChildren.length === 0
    // Text child comes before result (temporal order: narration then done)
    lane.upsertTextChild('text-1', agentId, 'summary narration with no tool calls');
    // agentResultSummary is set — injects a Done synthetic via
    // addResultSummarySynthetic before assignConnectors, so the synthetic
    // receives '╰─' and closes the parent's spine column.
    lane.setAgentResultSummary(agentId, 'Done (0 tools · 0.1s)');
    lane.addResult(agentId, makeResult('done'));

    const output = stripAnsi(lane.flush().join('\n'));
    const narrationLine = output.split('\n').find((l) => l.includes('summary narration with no tool calls'));
    expect(narrationLine).toBeDefined();
    // With H2 fix: textIndent extends one slot (agentResultSummary != null),
    // so the row starts with '  │ ' (closed parent-spine + text gutter).
    // Pre-fix output was '│ ' (parent spine re-opened, no closed slot).
    expect(narrationLine!).toMatch(/^  │ /);
    expect(narrationLine!).not.toMatch(/^│ │ /);
  });
});

describe('ToolLane.getOverlay — MAX_OVERLAY_ROOTS sliding cap', () => {
  // The live overlay must not grow unbounded on long multi-tool turns.
  // On a 14-tool turn (real-world: deep diagnose / mint runs), the screen
  // otherwise fills with one row per dispatched tool. The cap elides the
  // *oldest completed* roots into a single dim summary line ("… +N done")
  // while always preserving in-flight roots so the user can see what is
  // currently running. Scrollback (flush()) is unaffected by the cap.

  it('renders all rows when root count is at the cap', () => {
    const lane = new ToolLane();
    // Exactly MAX_OVERLAY_ROOTS=6 completed root tools — all should show.
    for (let i = 1; i <= 6; i++) {
      lane.addStart(`t-${i}`, 'read_file', `("f${i}.ts")`);
      lane.addResult(`t-${i}`, makeResult(`${i} lines`));
    }
    const overlay = lane.getOverlay();
    expect(overlay).not.toContain('done');  // no summary line
    // All six files should appear individually.
    for (let i = 1; i <= 6; i++) {
      expect(overlay).toContain(`f${i}.ts`);
    }
  });

  it('elides oldest completed roots with "… +N done" suffix when over cap', () => {
    const lane = new ToolLane();
    // 14 completed roots — recreates the screenshot scenario.
    for (let i = 1; i <= 14; i++) {
      lane.addStart(`t-${i}`, 'read_file', `("f${i}.ts")`);
      lane.addResult(`t-${i}`, makeResult(`${i} lines`));
    }
    const overlay = lane.getOverlay();
    const lines = stripAnsi(overlay).split('\n');

    // Summary footer should appear once, naming the elided count (14 - 6 = 8).
    const summaryLines = lines.filter((l) => /\+8 done/.test(l));
    expect(summaryLines.length).toBe(1);
    expect(summaryLines[0]).toMatch(/^\s*…/);

    // The 6 most recently completed files (f9..f14) survive; older ones don't.
    expect(overlay).not.toContain('f1.ts');
    expect(overlay).not.toContain('f8.ts');
    expect(overlay).toContain('f9.ts');
    expect(overlay).toContain('f14.ts');

    // Total visible root-level read_file rows = 6.
    const readRows = lines.filter((l) => /read_file/.test(l));
    expect(readRows.length).toBe(6);

    // Positional assertion: summary line must appear *after* the last visible
    // root row, not before the first.
    const summaryIdx = lines.findIndex((l) => /\+8 done/.test(l));
    const firstVisibleIdx = lines.findIndex((l) => /f9\.ts/.test(l));
    expect(summaryIdx).toBeGreaterThan(firstVisibleIdx);
  });

  it('always shows in-flight roots — they bypass the cap', () => {
    const lane = new ToolLane();
    // 5 completed reads — under cap.
    for (let i = 1; i <= 5; i++) {
      lane.addStart(`done-${i}`, 'read_file', `("done${i}.ts")`);
      lane.addResult(`done-${i}`, makeResult(`${i} lines`));
    }
    // 3 in-flight tools — pushes total to 8, over cap of 6.
    for (let i = 1; i <= 3; i++) {
      lane.addStart(`active-${i}`, 'bash', `("cmd-${i}")`);
      // No addResult — these are in-flight.
    }
    const overlay = lane.getOverlay();

    // All three active tools must be visible.
    expect(overlay).toContain('cmd-1');
    expect(overlay).toContain('cmd-2');
    expect(overlay).toContain('cmd-3');

    // Done budget = 6 - 3 active = 3 done slots. Oldest 2 done get hidden.
    expect(overlay).toMatch(/\+2 done/);
    expect(overlay).not.toContain('done1.ts');
    expect(overlay).not.toContain('done2.ts');
    expect(overlay).toContain('done3.ts');
    expect(overlay).toContain('done5.ts');
  });

  it('caps active-only overflow without losing any active row', () => {
    // Pathological case: all roots are active. Cap must not hide any —
    // hiding an in-flight row would be a correctness failure (user can't
    // see what is currently running).
    const lane = new ToolLane();
    for (let i = 1; i <= 10; i++) {
      lane.addStart(`a-${i}`, 'bash', `("cmd-${i}")`);
    }
    const overlay = lane.getOverlay();
    // No "done" summary line — nothing is done.
    expect(overlay).not.toMatch(/\+\d+ done/);
    // All 10 commands visible.
    for (let i = 1; i <= 10; i++) {
      expect(overlay).toContain(`cmd-${i}`);
    }
  });

  it('flush() is unaffected by the cap — scrollback retains full detail', () => {
    const lane = new ToolLane();
    for (let i = 1; i <= 14; i++) {
      lane.addStart(`t-${i}`, 'read_file', `("f${i}.ts")`);
      lane.addResult(`t-${i}`, makeResult(`${i} lines`));
    }
    // Verify cap is engaged in overlay first.
    expect(lane.getOverlay()).toMatch(/\+\d+ done/);
    // But flush sees everything — full grouped-summary output, no elision.
    const flushed = lane.flush().join('\n');
    expect(flushed).not.toMatch(/\+\d+ done/);  // no overlay-cap leakage
    expect(flushed).toContain('read_file');
    expect(flushed).toContain('×14');           // grouped under one row

  });
});

// ─── getOverlay() anchors childless NESTING heads with ◉ (floating-spine bug) ─
//
// Regression for the "broken topology spine" bug: a completed (or in-flight)
// NESTING dispatch head (skill/Agent/compose) that owns NO in-lane children —
// because its descendants were rooted separately or already flushed, and its
// header has not been eagerly committed (headerEmitted=false) — fell through
// the with-children branch (tool-lane.ts:320, gated on children.length > 0),
// missed the headerEmitted-silence branch, and rendered via the flat-leaf
// `else` path at a bare 2-space lead with NO turn-root marker and NO spine —
// a skill row floating disconnected from the topology.
//
// The fix makes getOverlay() consistent with flush() (which already routes
// childless NESTING tools to the frame head via NESTING membership alone):
// childless NESTING heads anchor the spine with ◉ at col 0. Leaf (non-NESTING)
// tools are unaffected and keep their flat 2-space lead.
describe('ToolLane.getOverlay — childless NESTING head anchors the spine', () => {
  it('completed childless skill renders ◉-anchored, not a flat-leaf float', () => {
    const lane = new ToolLane();
    // A skill that owns no in-lane children (descendants rooted separately or
    // already flushed) and whose header was NOT eagerly committed. This is the
    // exact shape from the screenshot: `◆ skill (review) — ✓ 25 lines`.
    lane.addStartWithAgentContext('skill-1', 'skill', '(review)', undefined);
    lane.addResult('skill-1', makeResult('25 lines'));

    const overlay = stripAnsi(lane.getOverlay());
    const skillLine = overlay.split('\n').find((l) => l.includes('skill') && l.includes('review'));
    expect(skillLine).toBeDefined();
    // Anchored: turn-root marker ◉ at col 0 — NOT the pre-fix bare 2-space lead.
    expect(skillLine!).toMatch(/^◉ /);
    expect(skillLine!).not.toMatch(/^ {2}\S/);
    // The outcome still renders on the head row (no children carry it).
    expect(skillLine!).toContain('25 lines');
  });

  it('in-flight childless Agent renders ◉-anchored with the " …" marker', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('agent-1', 'Agent', '(researcher)', undefined);
    // No children, no result — in-flight dispatch head.

    const overlay = stripAnsi(lane.getOverlay());
    const head = overlay.split('\n')[0];
    expect(head).toMatch(/^◉ /);
    expect(head).toContain('researcher');
    expect(head).toContain('…');
  });

  it('childless in-flight Agent with a thinkingTail: head ◉-anchored, tail keeps spine', () => {
    // Mirrors the existing "thinkingTail under childless Agent" test, but also
    // asserts the HEAD row is now ◉-anchored (pre-fix it led with 2 spaces).
    const lane = new ToolLane();
    const agentId = '__synth_childless_anchor_tail';
    lane.addStartWithAgentContext(agentId, 'Agent', '(researcher)', undefined);
    lane.setThinkingTail(agentId, 'first thought before any tool');

    const lines = stripAnsi(lane.getOverlay()).split('\n');
    const head = lines.find((l) => l.includes('researcher'));
    const tail = lines.find((l) => l.includes('⌇') && l.includes('first thought'));
    expect(head).toBeDefined();
    expect(head!).toMatch(/^◉ /);
    // Tail continuity preserved: spine glyph at col 0 (existing invariant).
    expect(tail).toBeDefined();
    expect(tail!).toMatch(/^│ /);
  });

  it('non-NESTING completed leaf still renders at a flat lead (fix is NESTING-scoped)', () => {
    // Teeth check the scope: a plain Read root must NOT gain a ◉ anchor — only
    // NESTING dispatch heads anchor the spine.
    const lane = new ToolLane();
    lane.addStart('read-1', 'Read', '("foo.ts")');
    lane.addResult('read-1', makeResult('120 lines'));

    const overlay = stripAnsi(lane.getOverlay());
    const line = overlay.split('\n').find((l) => l.includes('Read'));
    expect(line).toBeDefined();
    expect(line!).not.toMatch(/^◉ /);
  });

  it('childless skill + separately-rooted sibling: skill anchors, no flat float (screenshot topology)', () => {
    // Reproduces the screenshot's topology at the render layer: a childless
    // skill at root alongside a separately-rooted Agent (the orphaned-descendant
    // state). The skill must anchor with ◉ rather than floating at a flat lead;
    // the sibling Agent gets its own turn-root. Both spine columns are honest.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(review)', undefined);
    lane.addResult('skill-1', makeResult('25 lines'));
    lane.addStartWithAgentContext('agent-1', 'Agent', '(review-629-correctness)', undefined);
    lane.addStartWithAgentContext('t1', 'Read', '("a.ts")', 'agent-1');
    lane.addResult('t1', makeResult('10 lines'));

    const lines = stripAnsi(lane.getOverlay()).split('\n');
    const skillLine = lines.find((l) => l.includes('skill') && l.includes('review)'));
    expect(skillLine).toBeDefined();
    expect(skillLine!).toMatch(/^◉ /);
    expect(skillLine!).not.toMatch(/^ {2}\S/);
    // Every NESTING head in the overlay is ◉-anchored — no floating leaf row
    // carrying a parenthesized skill/agent label at a bare 2-space lead.
    const floatingNestingHead = lines.find((l) => /^ {2}[◆→]/.test(l));
    expect(floatingNestingHead).toBeUndefined();
  });
});

// ─── headerEmitted suppression in getOverlay + flushSource (re-emission bug) ──
//
// Regression for the "duplicate frame headers" bug visible when a sibling
// subagent completes mid-flight under a still-running parent: the completed
// child's flushSource eagerly emits the ancestor chain (skill → Agent) to
// scrollback AND marks anc.headerEmitted=true, but two downstream paths fail
// to consult that flag:
//
//   1. getOverlay() — re-renders the same ancestors below scrollback while
//      they remain alive in the lane. The user sees two visual copies of the
//      ancestor stack: one in scrollback (with completed children) and one
//      in the overlay (with still-running children).
//
//   2. flushSource(ancestor) — when the headerEmitted ancestor itself later
//      completes, formatAgentSummary unconditionally re-emits the header
//      line, duplicating it under the eagerly-emitted copy above.
//
// Both paths are fixed by reading the headerEmitted flag and suppressing the
// header line accordingly.
describe('ToolLane.getOverlay — suppresses ancestors already in scrollback', () => {
  it('flush breadcrumb omits empty child.toolInput but keeps non-empty labels', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('root', 'skill', '(root)', undefined);

    lane.addStartWithAgentContext('empty-agent', 'Agent', '', 'root');
    lane.addStartWithAgentContext('empty-completed-child', 'Agent', '(done)', 'empty-agent');
    lane.addResult('empty-completed-child', makeResult('done'));
    lane.flushSource('empty-completed-child');
    lane.addStartWithAgentContext('empty-live-child', 'Read', '("empty.ts")', 'empty-agent');
    lane.addResult('empty-live-child', makeResult('1 line'));

    lane.addStartWithAgentContext('labeled-agent', 'Agent', '(review)', 'root');
    lane.addStartWithAgentContext('labeled-completed-child', 'Agent', '(done)', 'labeled-agent');
    lane.addResult('labeled-completed-child', makeResult('done'));
    lane.flushSource('labeled-completed-child');
    lane.addStartWithAgentContext('labeled-live-child', 'Read', '("labeled.ts")', 'labeled-agent');
    lane.addResult('labeled-live-child', makeResult('1 line'));

    lane.addResult('root', makeResult('done'));
    const output = stripAnsi(lane.flush().join('\n'));

    expect(output).toContain('↳ Agent\n');
    expect(output).not.toContain('↳ Agent \n');
    expect(output).toContain('↳ Agent (review)');
  });

  it('after flushSource eagerly commits an ancestor header, getOverlay must not re-render it', () => {
    // Topology: skill → devils-advocate → [paranoid (completes), architect (still running)]
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(devils-advocate)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(devils-advocate)', 'skill-1');
    lane.addStartWithAgentContext('paranoid-1', 'Agent', '(paranoid)', 'agent-1');
    lane.addStartWithAgentContext('architect-1', 'Agent', '(architect)', 'agent-1');
    // paranoid does some work and finishes
    lane.addStartWithAgentContext('p-tool-1', 'Read', '("foo.ts")', 'paranoid-1');
    lane.addResult('p-tool-1', makeResult('contents'));
    lane.setAgentResultSummary('paranoid-1', 'Done (1 tool)');
    lane.addResult('paranoid-1', makeResult('paranoid done'));

    // paranoid completes mid-turn → flushSource eagerly emits skill + agent-1
    // headers and marks them headerEmitted=true. paranoid's subtree is removed
    // from this.entries. agent-1 and skill-1 remain alive.
    const scrollback = stripAnsi(lane.flushSource('paranoid-1').join('\n'));

    // Scrollback must contain skill + devils-advocate headers (this is the
    // existing eager-emission contract — sanity check, not the bug under test).
    expect(scrollback).toContain('skill');
    expect(scrollback).toContain('devils-advocate');

    // Now: architect is still running. The overlay re-renders skill + agent-1
    // (alive in lane) plus architect (in-flight under them).
    const overlay = stripAnsi(lane.getOverlay());

    // Original anti-duplicate contract: the full-color ancestor frame
    // (`◆ skill`, `→ Agent(devils-advocate)`) must NOT re-render in the
    // overlay — that's the duplicate-frame bug this test was originally
    // written to guard against.
    expect(overlay, 'overlay rendered full-color skill frame (duplicate-frame bug)').not.toMatch(/◆.*skill\b.*\(devils-advocate\)/);
    expect(overlay, 'overlay rendered full-color Agent frame (duplicate-frame bug)').not.toMatch(/→\s*Agent\s*\(devils-advocate\)/);

    // Anonymous-anchor invariant: committed labels live in scrollback;
    // live overlay may render anonymous anchors only to preserve tree
    // geometry. The headerEmitted ancestors must NOT re-emit their labels
    // in any form — neither full prefix nor dim breadcrumb. The previous
    // contract emitted `↳ <toolName> <toolInput>` as a dim back-reference;
    // it has been replaced by an anonymous anchor (marker / connector only).
    expect(overlay, 'committed skill label re-rendered in overlay').not.toContain('skill (devils-advocate)');
    expect(overlay, 'committed Agent label re-rendered in overlay').not.toContain('Agent (devils-advocate)');
    expect(overlay, 'overlay carries the dropped ↳ breadcrumb glyph').not.toContain('↳');
    // architect is the still-alive descendant; it MUST still appear in the overlay.
    expect(overlay).toContain('architect');
  });

  it('multi-level: both ancestors marked headerEmitted are both suppressed in overlay', () => {
    // Same shape as the screenshot in the bug report: skill → skill → Agent(architect, running)
    // Two ancestor levels marked headerEmitted by an earlier sibling completion.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-outer', 'skill', '(outer)', undefined);
    lane.addStartWithAgentContext('agent-outer', 'Agent', '(devils-advocate)', 'skill-outer');
    lane.addStartWithAgentContext('skill-inner', 'skill', '(inner)', 'agent-outer');
    lane.addStartWithAgentContext('agent-inner', 'Agent', '(devils-advocate)', 'skill-inner');
    // Two siblings: paranoid completes, architect still running
    lane.addStartWithAgentContext('paranoid-1', 'Agent', '(paranoid)', 'agent-inner');
    lane.addStartWithAgentContext('architect-1', 'Agent', '(architect)', 'agent-inner');
    lane.addStartWithAgentContext('p-tool-1', 'Read', '("foo.ts")', 'paranoid-1');
    lane.addResult('p-tool-1', makeResult('contents'));
    lane.setAgentResultSummary('paranoid-1', 'Done (1 tool)');
    lane.addResult('paranoid-1', makeResult('paranoid done'));

    // Flush paranoid: walks up agent-inner → skill-inner → agent-outer →
    // skill-outer. All four ancestors get headerEmitted=true.
    lane.flushSource('paranoid-1');

    // Overlay should not re-render any of the four headerEmitted ancestors
    // as full-color frames (the original duplicate-frame anti-pattern).
    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay, 'overlay rendered full-color outer skill frame').not.toMatch(/◆.*skill\b.*\(outer\)/);
    expect(overlay, 'overlay rendered full-color inner skill frame').not.toMatch(/◆.*skill\b.*\(inner\)/);

    // Anonymous-anchor invariant (multi-level): each headerEmitted ancestor
    // contributes geometry only (marker / connector / spine), never a label.
    // Previous contract re-emitted dim `↳ skill (outer)` / `↳ skill (inner)`
    // breadcrumbs; both are now suppressed because their committed labels
    // already live in scrollback.
    expect(overlay, 'committed outer-skill label re-rendered in overlay').not.toContain('skill (outer)');
    expect(overlay, 'committed inner-skill label re-rendered in overlay').not.toContain('skill (inner)');
    expect(overlay, 'overlay carries the dropped ↳ breadcrumb glyph').not.toContain('↳');
    // architect is the still-alive descendant; must still appear.
    expect(overlay).toContain('architect');
  });

  it('overlay still renders ancestor headers that have NOT been eagerly committed', () => {
    // Control: an ancestor with headerEmitted=false (not yet committed to
    // scrollback) MUST still render in the overlay. This guards against an
    // over-eager suppression that hides legitimate in-flight ancestors.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(critic)', 'skill-1');
    lane.addStartWithAgentContext('tool-1', 'Read', '("foo.ts")', 'agent-1');
    // No flushSource has run; nothing is headerEmitted.

    const overlay = stripAnsi(lane.getOverlay());
    // Both ancestors must appear in the overlay (this is the normal pre-bug behavior).
    expect(overlay).toContain('skill');
    expect(overlay).toContain('diagnose');
    expect(overlay).toContain('critic');
  });

  // Anonymous-anchor regression tests: when a NESTING_TOOL ancestor is
  // headerEmitted=true (its colored frame is in scrollback) AND it still
  // has live in-flight children in the lane, the overlay must render an
  // ANONYMOUS anchor row (marker / connector only — no label, no `↳`
  // back-reference) at the parent's indent. Anchor exists to give the
  // child rows below a real visual row their connectors can attach to,
  // but carries no label content because the labeled header is already
  // in scrollback.

  it('anonymous anchor renders at the EXACT indent of the would-be header (consistent ancestor spacing)', () => {
    // Topology: skill → Agent → [paranoid completes, architect runs].
    // After flushSource('paranoid-1'), skill + Agent are both headerEmitted.
    // Architect remains in-flight.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(critic)', 'skill-1');
    lane.addStartWithAgentContext('paranoid-1', 'Agent', '(paranoid)', 'agent-1');
    lane.addStartWithAgentContext('architect-1', 'Agent', '(architect)', 'agent-1');
    lane.addStartWithAgentContext('p-tool-1', 'Read', '("x.ts")', 'paranoid-1');
    lane.addResult('p-tool-1', makeResult('ok'));
    lane.setAgentResultSummary('paranoid-1', 'Done (1 tool)');
    lane.addResult('paranoid-1', makeResult('done'));
    lane.flushSource('paranoid-1');

    const overlay = stripAnsi(lane.getOverlay());
    const overlayLines = overlay.split('\n');

    // Root-level anonymous anchor: '◉ ' alone (the dim turn-root marker,
    // 2 cells wide). Anchors the spine column for the child rows below
    // (which start with `│ ` at col 0). ◉ is chosen over `│ ` because the
    // overlay isn't physically adjacent to its committed scrollback header —
    // a `│` would assert upward continuity that doesn't exist under
    // reordering. ◉ claims nothing about upward; it only anchors the spine
    // going down.
    //
    // No label, no `↳`: the committed `◆ skill(diagnose)` lives in scrollback
    // above and must not be restated in any form in the overlay.
    const skillAnchor = overlayLines[0];
    expect(skillAnchor, 'missing root-level anonymous anchor row').toBeDefined();
    expect(skillAnchor, `root anchor must be marker-only; got: ${JSON.stringify(skillAnchor)}`)
      .toMatch(/^◉\s*$/);

    // Nested anonymous anchor rendered via renderOverlayChildren — depth 1, a
    // dispatch head under skill-1, rendered with a tree connector:
    //   '│ ╰─'  (last sibling)   '│ ├─'  (mid sibling)
    //   - `│ `      = g.spine (skill-1's active spine column at col 0)
    //   - `╰─ `/`├─ ` = g.lastConnector / g.midConnector (col 2, geometry only)
    //
    // No label suffix: the committed `◉ → Agent(critic)` lives in scrollback;
    // this row is geometry (a bare connector) to ground architect's rows below.
    const agentAnchor = overlayLines[1];
    expect(agentAnchor, 'missing nested anonymous anchor row').toBeDefined();
    expect(agentAnchor, `nested anchor must be connector-only; got: ${JSON.stringify(agentAnchor)}`)
      .toMatch(/^│ (╰─|├─)\s*$/);

    // The architect descendant (still alive, NOT headerEmitted) renders
    // with its FULL prefix at the next-deeper indent — proving the anchor
    // geometry above is correct (children attach to a real rendered row).
    expect(overlay).toContain('Agent(architect)');
    // No `↳` glyph anywhere in the overlay (anti-breadcrumb invariant).
    expect(overlay).not.toContain('↳');
    // No committed-ancestor label text anywhere in the overlay.
    expect(overlay).not.toContain('critic');
    expect(overlay).not.toContain('diagnose');
  });

  it('anonymous anchor structurally distinct from the duplicate-frame anti-pattern', () => {
    // Validates that the anonymous anchor (marker / connector only) is
    // structurally distinguishable from BOTH the original duplicate-frame
    // pattern (`◆ skill ... → Agent(...)`) AND the prior `↳ <label>`
    // breadcrumb format. This regression guards against either form
    // returning via the anchor path.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(critic)', 'skill-1');
    lane.addStartWithAgentContext('child-1', 'Agent', '(running-still)', 'agent-1');
    lane.addStartWithAgentContext('completed-1', 'Agent', '(completed)', 'agent-1');
    lane.addResult('completed-1', makeResult('done'));
    lane.flushSource('completed-1');

    const overlay = stripAnsi(lane.getOverlay());

    // Original glyph-prefixed frames must NOT re-appear (duplicate-frame
    // anti-pattern this fix is careful NOT to re-introduce).
    expect(overlay).not.toMatch(/◆.*skill\s*\(diagnose\)/);
    expect(overlay).not.toMatch(/→\s*Agent\s*\(critic\)/);

    // Prior `↳ <label>` breadcrumb form must NOT re-appear.
    expect(overlay).not.toContain('↳');
    expect(overlay).not.toContain('skill (diagnose)');
    expect(overlay).not.toContain('Agent (critic)');

    // running-still descendant must remain (alive, NOT headerEmitted).
    expect(overlay).toContain('running-still');
  });

  it('headerEmitted ancestor with no in-flight children left renders nothing in overlay', () => {
    // Edge case: a skill ancestor whose only child completes via flushSource.
    // The child's subtree is removed from this.entries; the skill remains
    // alive but has zero descendants in the lane. Pre-fix the overlay's
    // non-nesting branch rendered `'  ' + skill.prefix + palette.dim(' …')`
    // — a one-line "in-progress" marker that duplicated the eagerly-emitted
    // header in scrollback above. Post-fix the entire entry is suppressed.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(orchestrator)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(only-child)', 'skill-1');
    lane.addStartWithAgentContext('tool-1', 'Read', '("foo.ts")', 'agent-1');
    lane.addResult('tool-1', makeResult('contents'));
    lane.setAgentResultSummary('agent-1', 'Done (1 tool)');
    lane.addResult('agent-1', makeResult('agent done'));

    // Only child completes — flushSource removes agent-1 + tool-1 from the
    // lane and marks skill-1.headerEmitted=true. skill-1 remains alive but
    // has no descendants left in this.entries.
    lane.flushSource('agent-1');

    const overlay = stripAnsi(lane.getOverlay());
    // skill-1's prefix must NOT appear in the overlay (it's already in scrollback).
    expect(overlay, `overlay re-rendered childless headerEmitted skill: ${JSON.stringify(overlay)}`)
      .not.toContain('orchestrator');
  });
});

// ─── Anonymous anchor for headerEmitted ancestors (overlay path) ────────────
//
// Invariant: committed labels live in scrollback; live overlay may render
// anonymous anchors only to preserve tree geometry.
//
// When a parent NESTING_TOOL entry has `headerEmitted = true`, the overlay
// must emit a row that:
//   (a) occupies the parent's column position so descendants' connector
//       glyphs (├─ / ╰─) reference an actual rendered row, and
//   (b) carries the ancestorIsLast vector through to recursive children
//       with a matching visual row for every slot,
//   (c) emits NO label (no toolName, no toolInput, no `↳` back-reference) —
//       the labeled header already lives in scrollback above.
//
// The anchor row is the dim turn-root marker (root) or the tree connector
// (nested) and nothing else.
describe('ToolLane.getOverlay — anonymous anchor for headerEmitted ancestors', () => {
  it('headerEmitted ancestor renders as anonymous anchor (marker/connector only, no label)', () => {
    // Topology: skill → Agent(architect, running), sibling paranoid already flushed
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(devils-advocate)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(devils-advocate)', 'skill-1');
    lane.addStartWithAgentContext('paranoid-1', 'Agent', '(paranoid)', 'agent-1');
    lane.addStartWithAgentContext('architect-1', 'Agent', '(architect)', 'agent-1');
    lane.addStartWithAgentContext('p-tool-1', 'Read', '("foo.ts")', 'paranoid-1');
    lane.addResult('p-tool-1', makeResult('contents'));
    lane.setAgentResultSummary('paranoid-1', 'Done (1 tool)');
    lane.addResult('paranoid-1', makeResult('paranoid done'));

    // paranoid completes → flushSource marks agent-1 headerEmitted=true
    lane.flushSource('paranoid-1');

    // architect is still running — overlay must show anonymous anchors for
    // skill-1 and agent-1, then architect's full prefix at the deeper indent.
    const overlay = stripAnsi(lane.getOverlay());
    const lines = overlay.split('\n');

    // No `↳` back-reference glyph anywhere (anti-breadcrumb invariant).
    expect(overlay, 'overlay carries the dropped ↳ breadcrumb glyph').not.toContain('↳');
    // Committed labels must not re-appear in the overlay.
    expect(overlay, 'committed skill label re-rendered').not.toContain('skill (devils-advocate)');
    expect(overlay, 'committed Agent(devils-advocate) label re-rendered').not.toContain('Agent (devils-advocate)');

    // architect (still-running child) must appear — its connector attaches
    // to the anonymous anchor row above.
    expect(overlay).toContain('architect');

    // Ordering invariant: each anchor row precedes the descendant whose
    // connector attaches to it. Find the first row that looks like an anchor
    // (`◉` alone at root, or `│ <connector>` when nested) and assert architect
    // comes after.
    const anchorIdx = lines.findIndex((l) => /^◉\s*$/.test(l) || /^│ (╰─|├─)\s*$/.test(l));
    const architectIdx = lines.findIndex((l) => l.includes('architect'));
    expect(anchorIdx, 'anonymous anchor row must appear in overlay').toBeGreaterThanOrEqual(0);
    expect(architectIdx, 'architect must appear in overlay').toBeGreaterThanOrEqual(0);
    expect(anchorIdx, 'anchor must precede architect in overlay').toBeLessThan(architectIdx);
  });

  it('grandchildren render with correct spine depth when ancestor is headerEmitted', () => {
    // Topology: skill-1 → [agent-outer (alive, deep subtree), sibling-1 (completes)]
    //   agent-outer → agent-inner (running) → inner-tool (running)
    //
    // sibling-1 completes → flushSource walks ancestors up from sibling-1
    // and marks skill-1 (the only NESTING ancestor) headerEmitted=true.
    // agent-outer is NOT in sibling-1's ancestor chain so its
    // headerEmitted stays false; it renders with its full prefix.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(outer)', undefined);
    lane.addStartWithAgentContext('agent-outer', 'Agent', '(outer-agent)', 'skill-1');
    // sibling that will complete
    lane.addStartWithAgentContext('sibling-1', 'Agent', '(sibling)', 'skill-1');
    // still-running nested agent under agent-outer
    lane.addStartWithAgentContext('agent-inner', 'Agent', '(inner-agent)', 'agent-outer');
    lane.addStartWithAgentContext('inner-tool', 'Read', '("a.ts")', 'agent-inner');

    // Complete sibling to trigger eager header emission on skill-1
    lane.addResult('sibling-1', makeResult('done'));
    lane.flushSource('sibling-1');

    // skill-1.headerEmitted = true; agent-outer / agent-inner / inner-tool
    // remain alive and not headerEmitted.
    const overlay = stripAnsi(lane.getOverlay());

    // No `↳` back-reference glyph (anti-breadcrumb invariant).
    expect(overlay, 'overlay carries the dropped ↳ breadcrumb glyph').not.toContain('↳');
    // Committed skill-1 label must not re-appear.
    expect(overlay, 'committed skill label re-rendered in overlay').not.toContain('skill (outer)');

    // agent-outer (alive, NOT headerEmitted) carries its full prefix.
    expect(overlay).toContain('outer-agent');
    // inner-agent (alive, NOT headerEmitted) carries its full prefix.
    expect(overlay).toContain('inner-agent');
    // inner-tool child appears — its spine columns attach to a drawn parent.
    expect(overlay).toContain('Read');

    // Anonymous root anchor renders first (◉ alone).
    const lines = overlay.split('\n');
    expect(lines[0], `root anchor must be marker-only; got: ${JSON.stringify(lines[0])}`)
      .toMatch(/^◉\s*$/);
  });
});

// ─── Anonymous-anchor invariant — explicit regression suite ─────────────────
//
// Pins the four guarantees of the anonymous-anchor renderer projection:
//
//   1. No `↳` glyph appears in the overlay for any headerEmitted ancestor
//      (the prior dim breadcrumb body is gone in all four render paths).
//   2. Already-committed parent labels (toolName + toolInput) do not
//      re-appear anywhere in the overlay; the committed copy in scrollback
//      is the sole source of truth.
//   3. Child connector alignment is preserved: descendants of an anonymized
//      ancestor render at the correct indent depth, with spine columns
//      that attach to a real drawn row above (no orphan │ floating in space).
//   4. A partial live overlay with one completed child (already committed
//      to scrollback via flushSource) and one still-active child renders as
//      one continuous tree — anonymous anchors above, full-prefix live row
//      below, no duplicate-looking parent rows.
describe('ToolLane.getOverlay — anonymous-anchor invariant', () => {
  it('regression 1: no `↳` glyph appears for headerEmitted ancestors', () => {
    // Topology: skill → Agent → [paranoid (completes), architect (alive)]
    // Both skill and Agent get headerEmitted after paranoid's flushSource.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(devils-advocate)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(devils-advocate)', 'skill-1');
    lane.addStartWithAgentContext('paranoid-1', 'Agent', '(paranoid)', 'agent-1');
    lane.addStartWithAgentContext('architect-1', 'Agent', '(architect)', 'agent-1');
    lane.addStartWithAgentContext('p-tool-1', 'Read', '("foo.ts")', 'paranoid-1');
    lane.addResult('p-tool-1', makeResult('ok'));
    lane.setAgentResultSummary('paranoid-1', 'Done (1 tool)');
    lane.addResult('paranoid-1', makeResult('done'));
    lane.flushSource('paranoid-1');

    const overlay = stripAnsi(lane.getOverlay());
    // Hard invariant: the `↳` glyph (formerly the breadcrumb back-reference
    // marker) appears nowhere in the live overlay.
    expect(overlay, `↳ glyph leaked into overlay: ${JSON.stringify(overlay)}`)
      .not.toContain('↳');
  });

  it('regression 2: already-committed parent labels do not re-appear in overlay', () => {
    // Build a deep 3-level headerEmitted chain so every committed label
    // is a potential leak target.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(diagnose-pipeline)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(orchestrator)', 'skill-1');
    lane.addStartWithAgentContext('agent-2', 'Agent', '(researcher)', 'agent-1');
    // Two siblings under agent-2: one completes, one stays alive.
    lane.addStartWithAgentContext('done-child', 'Agent', '(reporter)', 'agent-2');
    lane.addStartWithAgentContext('live-child', 'Agent', '(verifier)', 'agent-2');
    lane.addStartWithAgentContext('done-tool', 'Read', '("x.ts")', 'done-child');
    lane.addResult('done-tool', makeResult('ok'));
    lane.setAgentResultSummary('done-child', 'Done (1 tool)');
    lane.addResult('done-child', makeResult('done'));
    lane.flushSource('done-child');

    const overlay = stripAnsi(lane.getOverlay());

    // Each committed label (skill, both intermediate Agents, the reporter
    // child) must not appear in the live overlay — they all live in
    // scrollback now.
    expect(overlay, 'committed skill label re-rendered').not.toContain('diagnose-pipeline');
    expect(overlay, 'committed orchestrator Agent label re-rendered').not.toContain('orchestrator');
    expect(overlay, 'committed researcher Agent label re-rendered').not.toContain('researcher');
    expect(overlay, 'committed reporter (already in scrollback) re-rendered').not.toContain('reporter');

    // The still-live verifier carries its full prefix — proves we are not
    // silently suppressing all labels.
    expect(overlay).toContain('verifier');
  });

  it('regression 3: child connector alignment is preserved when ancestor is anonymized', () => {
    // Topology: skill → Agent → [paranoid (completes), architect (alive)]
    // After flushSource, skill (depth 0) and Agent (depth 1) are anonymized.
    // architect is at depth 2; its connector row must attach geometrically
    // to a drawn anchor row above.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(critic)', 'skill-1');
    lane.addStartWithAgentContext('paranoid-1', 'Agent', '(paranoid)', 'agent-1');
    lane.addStartWithAgentContext('architect-1', 'Agent', '(architect)', 'agent-1');
    lane.addStartWithAgentContext('p-tool-1', 'Read', '("x.ts")', 'paranoid-1');
    lane.addResult('p-tool-1', makeResult('ok'));
    lane.setAgentResultSummary('paranoid-1', 'Done (1 tool)');
    lane.addResult('paranoid-1', makeResult('done'));
    lane.flushSource('paranoid-1');

    const overlay = stripAnsi(lane.getOverlay());
    const lines = overlay.split('\n').filter(Boolean);

    // Row 0: root anchor for skill — `◉ ` alone (turn-root marker, 2 cells).
    expect(lines[0], `root anchor; got: ${JSON.stringify(lines[0])}`)
      .toMatch(/^◉\s*$/);

    // Row 1: nested anchor for agent-1 — `│ ╰─` (last sibling of skill's child
    // list; the others flushed) or `│ ├─`. Spine column at col 0 (skill-1's
    // active spine), tree connector at col 2.
    expect(lines[1], `nested anchor; got: ${JSON.stringify(lines[1])}`)
      .toMatch(/^│ (╰─|├─)\s*$/);

    // Row 2 (or later): architect's full prefix at depth 2 — a LEAF (no in-lane
    // children), so it hangs off its own connector. Because agent-1 is skill's
    // last child here (`╰─`), the overlay CLOSES col-0 beneath it (isLast): the
    // architect row's col-0 slot is the blank `'  '`, col-2 is agent-1's active
    // spine, then the connector. No `│` runs below the `╰─` (no severed spine).
    const architectLine = lines.find((l) => l.includes('architect'));
    expect(architectLine, 'architect row missing from overlay').toBeDefined();
    // architect is at depth 2 → 2 ancestor/spine slots + 3-cell connector.
    // Match: starts with `│ ` (or `  `) ×2 then `├─ ` / `╰─ ` then content.
    expect(architectLine, `architect connector alignment; got: ${JSON.stringify(architectLine)}`)
      .toMatch(/^(│ |  )(│ |  )(├─ |╰─ )/);
  });

  it('regression 4: partial overlay with one completed + one active child renders as one continuous tree', () => {
    // The end-to-end scenario the audit was triggered by: parallel subagents
    // where one finishes mid-turn and the other keeps running. The overlay
    // must show:
    //   - anonymous anchor for the still-live parent (no duplicate of the
    //     scrollback-committed header)
    //   - full prefix for the active child
    //   - no `↳` breadcrumb, no committed label re-statement
    //   - the active child's connector lines up geometrically under the
    //     anonymous anchor
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(devils-advocate)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(devils-advocate)', 'skill-1');
    lane.addStartWithAgentContext('paranoid-1', 'Agent', '(paranoid)', 'agent-1');
    lane.addStartWithAgentContext('architect-1', 'Agent', '(architect)', 'agent-1');
    // paranoid does some work and completes mid-turn
    lane.addStartWithAgentContext('p-tool-1', 'Grep', '("TODO")', 'paranoid-1');
    lane.addResult('p-tool-1', makeResult('7 matches'));
    lane.setAgentResultSummary('paranoid-1', 'Done (1 tool · 0.5s)');
    lane.addResult('paranoid-1', makeResult('paranoid done'));
    // architect is still working
    lane.addStartWithAgentContext('a-tool-1', 'Read', '("plan.md")', 'architect-1');

    // paranoid's subtree commits to scrollback; skill-1 + agent-1 are marked
    // headerEmitted; architect remains live.
    const scrollback = stripAnsi(lane.flushSource('paranoid-1').join('\n'));
    const overlay = stripAnsi(lane.getOverlay());

    // — Scrollback (the committed tree above) carries the labeled headers.
    expect(scrollback).toContain('skill');
    expect(scrollback).toContain('devils-advocate');
    expect(scrollback).toContain('paranoid');

    // — Overlay reads as one continuous tree, no duplicate labels.
    const overlayLines = overlay.split('\n').filter(Boolean);

    // Row 0: anonymous root anchor for skill (committed label is in scrollback).
    expect(overlayLines[0], `expected anonymous root anchor; got: ${JSON.stringify(overlayLines[0])}`)
      .toMatch(/^◉\s*$/);

    // Row 1: anonymous nested anchor for agent-1 — a tree connector `│ ╰─`
    // (committed label is in scrollback). agent-1 is skill's last live child,
    // so col-0 CLOSES beneath this row (isLast).
    expect(overlayLines[1], `expected anonymous nested anchor; got: ${JSON.stringify(overlayLines[1])}`)
      .toMatch(/^│ (╰─|├─)\s*$/);

    // architect's full prefix appears at the correct depth. architect is itself
    // a dispatch head with an in-lane child (a-tool-1), so it hangs off its own
    // tree connector at depth 2. Because agent-1 closed col-0 above, architect's
    // col-0 slot is blank: `  │ ╰─ → Agent(architect)`; its tool child sits one
    // level deeper.
    expect(overlay).toContain('architect');
    const architectLine = overlayLines.find((l) => l.includes('architect'));
    expect(architectLine, 'architect line missing').toBeDefined();
    expect(architectLine!, `architect connector geometry; got: ${JSON.stringify(architectLine)}`)
      .toMatch(/^(│ |  )(│ |  )(├─ |╰─ )/);

    // architect's child tool (a-tool-1 Read("plan.md")) appears deeper still.
    expect(overlay).toContain('Read');
    expect(overlay).toContain('plan.md');

    // No `↳` breadcrumb glyph anywhere.
    expect(overlay).not.toContain('↳');
    // No committed-label restatement.
    expect(overlay).not.toContain('devils-advocate');
    expect(overlay).not.toContain('paranoid');
  });

  it('regression 4 — ASCII glyph mode: anonymous anchors use `o` + ASCII connectors', () => {
    // Smoke test for the ASCII fallback path (AGENT_AFK_ASCII=1). The
    // anonymous-anchor invariant must hold under both glyph sets.
    const prevAscii = process.env['AGENT_AFK_ASCII'];
    process.env['AGENT_AFK_ASCII'] = '1';
    try {
      const lane = new ToolLane();
      lane.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
      lane.addStartWithAgentContext('agent-1', 'Agent', '(critic)', 'skill-1');
      lane.addStartWithAgentContext('paranoid-1', 'Agent', '(paranoid)', 'agent-1');
      lane.addStartWithAgentContext('architect-1', 'Agent', '(architect)', 'agent-1');
      lane.addStartWithAgentContext('p-tool-1', 'Read', '("x.ts")', 'paranoid-1');
      lane.addResult('p-tool-1', makeResult('ok'));
      lane.setAgentResultSummary('paranoid-1', 'Done (1 tool)');
      lane.addResult('paranoid-1', makeResult('done'));
      lane.flushSource('paranoid-1');

      const overlay = stripAnsi(lane.getOverlay());
      const lines = overlay.split('\n').filter(Boolean);

      // Root anchor: `o ` (ASCII turn-root, 2 cells).
      expect(lines[0], `ASCII root anchor; got: ${JSON.stringify(lines[0])}`)
        .toMatch(/^o\s*$/);

      // Nested anchor: `| +-` or `| \-` (ASCII spine + connector).
      expect(lines[1], `ASCII nested anchor; got: ${JSON.stringify(lines[1])}`)
        .toMatch(/^\| (\\-|\+-)\s*$/);

      // No `↳` (anti-breadcrumb invariant under ASCII mode too).
      expect(overlay).not.toContain('↳');
      // architect's full prefix still appears.
      expect(overlay).toContain('architect');
    } finally {
      if (prevAscii === undefined) {
        delete process.env['AGENT_AFK_ASCII'];
      } else {
        process.env['AGENT_AFK_ASCII'] = prevAscii;
      }
    }

  });
});

// ─── Overlay: headerEmitted nested NESTING child with no in-lane grandchildren ─
//
// Regression for a real spine bug adjacent to the "broken topology spine"
// family: when a nested skill's only descendant subagent completes,
// `flushSource` removes that subagent's subtree AND marks the nested skill
// `headerEmitted = true` (its frame header is now in scrollback) — but the
// nested skill ENTRY itself survives in the lane (it is an ancestor of the
// flushed target, not the target). On the next `getOverlay`, the nested skill
// has zero in-lane grandchildren, so `renderOverlayChildren` fell through to
// the in-progress `else` branch and RE-EMITTED its committed label as a live
// overlay row ("◆ skill(...)" + "Running…"), duplicating the scrollback header
// and displacing following siblings. The fix mirrors the root-level silence
// branch in `ToolLane.getOverlay` (~line 391): a headerEmitted NESTING child
// with no grandchildren renders nothing in the overlay.
describe('ToolLane.getOverlay — headerEmitted nested skill (no grandchildren) is silent', () => {
  function res(content: string): ToolResultChunk {
    return { type: 'tool_result', toolUseId: 'x', content, isError: false };
  }

  it('does not leak the nested skill label into the overlay after its subagent flushed', () => {
    const lane = new ToolLane();
    // skill1 → agent1 → [tool1, skill2 → agent2 → tool2]
    lane.addStartWithAgentContext('skill1', 'skill', '(outer)', undefined);
    lane.addStartWithAgentContext('agent1', 'Agent', '(review)', 'skill1');
    lane.addStartWithAgentContext('tool1', 'get_runtime_state', '', 'agent1');
    lane.addResult('tool1', res('{"ok":1}'));
    lane.addStartWithAgentContext('skill2', 'skill', '(NESTED-SKILL-LABEL)', 'agent1');
    lane.addStartWithAgentContext('agent2', 'Agent', '(inner)', 'skill2');
    lane.addStartWithAgentContext('tool2', 'bash', '', 'agent2');
    lane.addResult('tool2', res('done'));

    // Inner subagent completes mid-turn: flushSource removes agent2 + tool2 and
    // marks skill1/agent1/skill2 headerEmitted. skill2 survives with no in-lane
    // grandchildren.
    lane.flushSource('agent2');

    const overlay = stripAnsi(lane.getOverlay());
    const lines = overlay.split('\n');

    const leaked = lines.filter((l) => l.includes('NESTED-SKILL-LABEL'));
    expect(leaked, `nested skill label leaked into overlay:\n${overlay}`).toHaveLength(0);
    expect(overlay).not.toMatch(/skill\(NESTED-SKILL-LABEL\)/);
    // tool1 (agent1's real surviving child) must still render.
    expect(overlay).toContain('get_runtime_state');

    // Regression guard for the dangling-connector bug: with skill2 — the LAST
    // sibling — silenced, get_runtime_state is agent1's only VISIBLE child and
    // MUST close with the last-connector ╰─, not a mid ├─. The earlier fix
    // silenced skill2 only inside the render loop, AFTER assignConnectors had
    // already handed get_runtime_state a ├─, leaving an open continuation column
    // pointing at a row that never renders. Filtering silenced children before
    // connector assignment recomputes ╰─ onto the true last visible sibling.
    // (Indent columns are only `│`/spaces, so ├/╰ on this row can only be its
    // own connector.)
    const grsRow = lines.find((l) => l.includes('get_runtime_state'));
    expect(grsRow, `get_runtime_state row missing:\n${overlay}`).toBeDefined();
    expect(grsRow!, `surviving last sibling must close with ╰─:\n${overlay}`).toContain('╰');
    expect(grsRow!, `surviving sibling must not keep a mid ├─ dangling at the silenced row:\n${overlay}`).not.toContain('├');
  });
});

// ─── depth-2 ghost row: skill2 with only silenced descendants must itself be silenced ─
//
// Topology: skill1 → agent1 → [tool1 (visible), skill2 → agent2 → agent3 → tool3]
// After flushSource('agent3'): agent3+tool3 removed; skill1/agent1/skill2/agent2
// all get headerEmitted=true.
//
// In renderOverlayChildren for agent1's children:
//   - agent2 has 0 grandchildren → isSilencedNestingHeader(agent2) = true (base case)
//   - skill2 has 1 child (agent2, still in lane) → length=1, NOT 0
//     → old isSilencedNestingHeader check (length===0) → NOT silenced
//     → skill2 is NOT pre-filtered from toolChildren before assignConnectors
//
// Consequence: skill2 occupies a connector slot in agent1's children array.
//   - assignConnectors assigns ├─ to tool1 and ╰─ to skill2
//   - skill2 renders as an anonymous anchor (headerEmitted=true, has grandchildren)
//     producing an empty "  │ ╰─ " row with no visible content below it
//   - tool1 (get_runtime_state) keeps ├─ — a dangling mid-connector pointing at
//     the empty anchor row below it, leaving an open continuation column
//
// Fix: isSilencedNestingHeader must be recursive — a nesting header is silenced
// when ALL its children are themselves silenced (no visible descendant).

describe('ToolLane.getOverlay — depth-2 ghost row: all descendants silenced implies silence', () => {
  function res(content: string): ToolResultChunk {
    return { type: 'tool_result', toolUseId: 'x', content, isError: false };
  }

  it('skill2 with only a silenced agent2 child is pre-filtered; tool1 gets ╰─ not ├─', () => {
    const lane = new ToolLane();
    // topology: skill1 → agent1 → [tool1, skill2 → agent2 → agent3 → tool3]
    lane.addStartWithAgentContext('skill1', 'skill', '(outer)', undefined);
    lane.addStartWithAgentContext('agent1', 'Agent', '(review)', 'skill1');
    lane.addStartWithAgentContext('tool1', 'get_runtime_state', '', 'agent1');
    lane.addResult('tool1', res('{"ok":1}'));
    lane.addStartWithAgentContext('skill2', 'skill', '(DEPTH2-GHOST)', 'agent1');
    lane.addStartWithAgentContext('agent2', 'Agent', '(mid)', 'skill2');
    lane.addStartWithAgentContext('agent3', 'Agent', '(deep)', 'agent2');
    lane.addStartWithAgentContext('tool3', 'bash', '', 'agent3');
    lane.addResult('tool3', res('done'));

    // flushSource('agent3') removes agent3+tool3, marks all ancestors headerEmitted.
    // agent2 now has 0 children → base case silenced.
    // skill2 has 1 child (agent2, still in lane) → old length===0 check → NOT silenced
    // → skill2 is NOT pre-filtered → tool1 gets ├─ (dangling) instead of ╰─ (correct).
    lane.flushSource('agent3');

    const overlay = stripAnsi(lane.getOverlay());
    const lines = overlay.split('\n');

    // The key connector assertion: tool1 is the only VISIBLE child of agent1 after
    // skill2's subtree is fully silenced. It must receive the LAST connector ╰─, not
    // the mid connector ├─ (which would leave a dangling open continuation below it).
    const grsRow = lines.find((l) => l.includes('get_runtime_state'));
    expect(grsRow, `get_runtime_state row missing:\n${overlay}`).toBeDefined();
    expect(grsRow!, `tool1 must close with ╰─ (no dangling ├─ pointing at ghost):\n${overlay}`).toContain('╰');
    expect(grsRow!, `tool1 must not keep dangling ├─ connector:\n${overlay}`).not.toContain('├');

    // Negative: skill2 label must NOT appear (neither as labeled row nor ghost label).
    const ghostLines = lines.filter((l) => l.includes('DEPTH2-GHOST'));
    expect(ghostLines, `depth-2 ghost row leaked into overlay:\n${overlay}`).toHaveLength(0);

    // The anonymous empty anchor (empty ╰─ row with no body) must also NOT appear.
    // After the fix, skill2 is pre-filtered, so no connector row is allocated for it.
    const emptyAnchorLines = lines.filter((l) => /^\s+[╰]─\s*$/.test(l));
    expect(emptyAnchorLines, `empty anchor row must not remain after depth-2 fix:\n${overlay}`).toHaveLength(0);
  });

  it('skill2 with a non-silenced (visible leaf) grandchild is NOT silenced (negative guard)', () => {
    // Guard against over-broad silencing: if skill2 still has a leaf (non-nesting)
    // descendant in-flight, it must NOT be silenced — the leaf is visible content.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill1', 'skill', '(outer)', undefined);
    lane.addStartWithAgentContext('agent1', 'Agent', '(review)', 'skill1');
    lane.addStartWithAgentContext('skill2', 'skill', '(SHOULD-RENDER)', 'agent1');
    lane.addStartWithAgentContext('agent2', 'Agent', '(mid)', 'skill2');
    // leaf Read under agent2 — NOT a nesting header, not silenced
    lane.addStartWithAgentContext('read1', 'Read', '("x.ts")', 'agent2');
    // No flushSource; agent2 and read1 are in-flight, headerEmitted=false

    const overlay = stripAnsi(lane.getOverlay());
    // skill2 has a visible (non-silenced) descendant → must NOT be silenced
    expect(overlay).toContain('SHOULD-RENDER');
  });
});

// ─── Committed spine stays continuous under a live skill (anti-fragmentation) ──
//
// Invariant: a live skill's TRUE last child is its own `Done` result-summary,
// which renders below any earlier-flushed subagent carrying the skill's spine
// OPEN. So a subagent flushed while its skill is still live must keep the
// ancestor column open on its DESCENDANT rows — closing it (treating the
// subagent as the skill's last child at commit time) strands those rows above
// the skill's later closer / next-wave anchor, fragmenting col-0 into `◉│··│`.
// These tests lock that out so the rejected commit-time-last-ness approach
// cannot return.
describe('ToolLane — committed spine continuity under a live skill', () => {
  function res(content: string): ToolResultChunk {
    return { type: 'tool_result', toolUseId: 'x', content, isError: false };
  }

  it('descendant rows of a subagent flushed under a live skill keep col-0 OPEN', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(critic)', 'skill-1'); // skill's only child
    lane.addStartWithAgentContext('read-1', 'Read', '("a.ts")', 'agent-1');
    lane.addResult('read-1', res('10 lines'));
    lane.setAgentResultSummary('agent-1', 'Done');
    lane.addResult('agent-1', res('done'));

    const band = lane.flushSource('agent-1').flatMap((s) => s.split('\n')).map(stripAnsi);
    const readRow = band.find((l) => l.includes('Read'));
    expect(readRow, `Read descendant row missing:\n${band.join('\n')}`).toBeDefined();
    // Open skill column + agent spine: `│ │ ├─ …`. The rejected close was `  │ ├─`.
    expect(readRow!.startsWith('│ │ ')).toBe(true);
    expect(readRow!.startsWith('  ')).toBe(false);
  });

  it('the skill closer connects to the subagent subtree — col-0 never reopens', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(name-check)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(checker)', 'skill-1');
    lane.addStartWithAgentContext('read-1', 'Read', '("x.ts")', 'agent-1');
    lane.addResult('read-1', res('4 lines'));
    lane.setAgentResultSummary('agent-1', 'Done');
    lane.addResult('agent-1', res('done'));
    const band = lane.flushSource('agent-1').flatMap((s) => s.split('\n')); // subagent flushes (skill live)
    lane.setAgentResultSummary('skill-1', 'Done');
    lane.addResult('skill-1', res('done'));
    const closer = lane.flush().flatMap((s) => s.split('\n'));              // skill completes → its own Done

    const all = [...band, ...closer].map(stripAnsi).filter((l) => l.trim().length > 0);
    const col0 = all.map((l) => (l.length > 0 ? l[0]! : ' '));
    // Fragmentation signature `◉│··│`: a blank col-0 followed by a later `│`.
    // Once col-0 closes (goes blank) it must NEVER reopen below.
    const firstBlank = col0.findIndex((c) => c === ' ');
    if (firstBlank !== -1) {
      const reopens = col0.slice(firstBlank).some((c) => c !== ' ');
      expect(reopens, `col-0 reopened after closing (fragmentation):\n${all.join('\n')}`).toBe(false);
    }
    // And positively: the single-shot transcript is a continuous rail `◉│…│`.
    expect(col0.join('')).toBe('◉' + '│'.repeat(all.length - 1));
  });
});

// ─── Cross-encoding: band vs overlay descendant rows (the spine-seam tradeoff) ──
//
// For the SAME tree the committed scrollback block (flushSource →
// formatAgentSummary) and the live overlay (getOverlay → renderOverlayChildren)
// encode DESCENDANT-row ancestor columns differently when an ancestor is the
// current LAST child of a live parent:
//   - The BAND is append-only and anchors dispatch heads with the ◉ marker, so
//     it keeps live-ancestor columns OPEN (`'│ '`) — it cannot guess a live
//     ancestor's last child without risking fragmentation when a later wave
//     arrives (see ToolLane.flushSource + the continuity suite above).
//   - The OVERLAY is ephemeral (redrawn every frame) and anchors nested heads
//     with tree connectors, so a last-child `╰─` CLOSES its column beneath it
//     (`'  '`) — internally consistent per frame, never a `│` below a `╰─`.
// So for a LAST-child ancestor the two intentionally DIVERGE (band open, overlay
// closed); for a NON-LAST ancestor both stay open and agree. These tests pin
// both cases. (Head rows keep their incoming spine open in both — PR #642.)
describe('ToolLane — band/overlay descendant-row spine reconciliation', () => {
  function res(content: string): ToolResultChunk {
    return { type: 'tool_result', toolUseId: 'x', content, isError: false };
  }
  // Leading ancestor-column block of a child row = everything before the first
  // tree connector (├ / ╰). Connectors themselves differ (the overlay's only
  // child is `╰─`; the band adds a Done synthetic so the tool is `├─`), but the
  // ancestor columns to their LEFT must match.
  const cols = (row: string): string => row.split(/[├╰]/)[0] ?? '';

  it('last-child ancestor (live skill): overlay CLOSES col-0, band keeps it OPEN (deliberate seam)', () => {
    const make = () => {
      const l = new ToolLane();
      l.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
      l.addStartWithAgentContext('agent-1', 'Agent', '(critic)', 'skill-1'); // skill's only/last child
      l.addStartWithAgentContext('read-1', 'Read', '("a.ts")', 'agent-1');
      l.addResult('read-1', res('10 lines'));
      return l;
    };
    // Overlay (agent in-flight, skill live): the Read row.
    const overlayRow = stripAnsi(make().getOverlay()).split('\n').find((x) => x.includes('Read'))!;
    // Band (agent completes → flushSource, skill still live — the key case).
    const bl = make();
    bl.setAgentResultSummary('agent-1', 'Done'); bl.addResult('agent-1', res('done'));
    const bandRow = stripAnsi(bl.flushSource('agent-1').join('\n')).split('\n').find((x) => x.includes('Read'))!;

    expect(overlayRow, 'overlay Read row missing').toBeDefined();
    expect(bandRow, 'band Read row missing').toBeDefined();
    // Overlay: agent-1 is skill's last child, so its `╰─` CLOSES col-0 beneath it
    // (ephemeral frame, internally consistent — no `│` below a `╰─`) → `'  │ '`.
    expect(cols(overlayRow)).toBe('  │ ');
    // Band: append-only, anchors heads with ◉ and keeps live-ancestor columns
    // OPEN (cannot bake a last-child guess — would fragment on a later wave) → `'│ │ '`.
    expect(cols(bandRow)).toBe('│ │ ');
    // The two intentionally DIVERGE at the seam — see the describe-block header.
    expect(cols(overlayRow)).not.toBe(cols(bandRow));
  });

  it('non-last ancestor: descendant col-0 OPEN in both band and overlay', () => {
    const make = () => {
      const l = new ToolLane();
      l.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
      l.addStartWithAgentContext('agent-a', 'Agent', '(a)', 'skill-1');     // NOT last...
      l.addStartWithAgentContext('read-a', 'Read', '("a.ts")', 'agent-a');
      l.addResult('read-a', res('1 line'));
      l.addStartWithAgentContext('agent-b', 'Agent', '(b)', 'skill-1');     // ...agent-b comes after
      return l;
    };
    const overlayRow = stripAnsi(make().getOverlay()).split('\n').find((x) => x.includes('Read'))!;
    const bl = make();
    bl.setAgentResultSummary('agent-a', 'Done'); bl.addResult('agent-a', res('done'));
    const bandRow = stripAnsi(bl.flushSource('agent-a').join('\n')).split('\n').find((x) => x.includes('Read'))!;

    expect(overlayRow, 'overlay Read row missing').toBeDefined();
    expect(bandRow, 'band Read row missing').toBeDefined();
    // agent-a is NOT skill's last child → skill column stays OPEN → `'│ │ '`.
    expect(cols(overlayRow)).toBe('│ │ ');
    expect(cols(bandRow)).toBe('│ │ ');
    expect(cols(bandRow)).toBe(cols(overlayRow)); // the reconciliation property
  });
});

// ─── Severed-spine regression: a last-child connector closes its column ───────
//
// The reported screenshot bug: under a still-live dispatch, a NESTED sub-agent
// that owns in-lane grandchildren is rendered in the overlay with a tree
// connector (`├─`/`╰─`). When it is the last sibling it gets `╰─` ("the parent's
// column closes here"). Commit 74c999e7 then made descendant columns ALWAYS-OPEN,
// so an open `│` continued in that same column directly beneath the `╰─` — a
// self-contradicting severed spine that made the nested tool-use loop read as
// floating, detached from the skill/agent above it ("the tool-use loop is not
// showing under the skill tree").
//
// Fix (Option A): the live overlay is ephemeral, so it threads each head's real
// `isLast` — a last-child `╰─` CLOSES its column beneath it (standard-tree
// geometry; the next frame re-opens it if a sibling arrives). No `│` ever runs
// below a `╰─`. These cases (2+ nesting levels) had ZERO coverage before — they
// are the sentinel. (The committed band keeps the column open via ◉ markers; the
// two surfaces diverge at the seam by design — see the reconciliation suite.)
describe('ToolLane.getOverlay — last-child connector closes its column (severed-spine regression)', () => {
  it('anonymous nested head (headerEmitted), last child of a live root: column closes below its ╰─', () => {
    // Topology: skill (root, live) → outer Agent → inner Agent.
    // inner completes → flushSource marks skill + outer headerEmitted. The outer
    // agent's tool-use loop then continues with a live tool (the screenshot's
    // `bash ×11` / running agent). Pre-fix the outer anchor was `│ ╰─` with the
    // bash row `│ │ …` keeping col-0 OPEN below it (severed); the fix closes it.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
    lane.addStartWithAgentContext('outer', 'Agent', '(rev-correctness)', 'skill-1');
    lane.addStartWithAgentContext('inner', 'Agent', '(critic)', 'outer');
    lane.addStartWithAgentContext('inner-tool', 'Read', '("a.ts")', 'inner');
    lane.addResult('inner-tool', makeResult('10 lines'));
    lane.setAgentResultSummary('inner', 'Done (1 tool)');
    lane.addResult('inner', makeResult('done'));
    lane.flushSource('inner'); // commit inner subtree; mark skill-1 + outer headerEmitted
    // outer's loop continues — a still-live leaf tool under the outer agent.
    lane.addStartWithAgentContext('outer-tool', 'bash', '("echo hi")', 'outer');

    const lines = stripAnsi(lane.getOverlay()).split('\n').filter(Boolean);

    // Row 0: root anonymous anchor for skill — `◉` marker only.
    expect(lines[0], `root anchor; got: ${JSON.stringify(lines[0])}`).toMatch(/^◉\s*$/);

    // Row 1: nested anonymous anchor for `outer` — a tree CONNECTOR `│ ╰─`
    // (outer is skill's last live child), never the marker form.
    const outerAnchor = lines[1]!;
    expect(outerAnchor, `nested anchor must be a connector; got: ${JSON.stringify(outerAnchor)}`)
      .toMatch(/^│ (╰─|├─)\s*$/);

    // The live leaf tool hangs under `outer` with col-0 CLOSED (`  │ …`): skill's
    // spine ended at outer's `╰─` above. The severed-spine bug produced `│ │ …`.
    const toolRow = lines.find((l) => l.includes('bash'))!;
    expect(toolRow, 'live tool row missing').toBeDefined();
    expect(toolRow.startsWith('  │ '),
      `tool row col-0 not closed below the last-child ╰─ (severed spine); got: ${JSON.stringify(toolRow)}`).toBe(true);

    // The invariant, stated directly: skill's col-0 spine is present on the
    // anchor row (where outer branches via ╰─) and CLOSES on every row below it —
    // no `│` ever runs beneath the `╰─`.
    expect(lines[1]![0], 'skill spine should be present at the ╰─ anchor row').toBe('│');
    for (let i = 2; i < lines.length; i++) {
      expect(lines[i]![0], `col-0 reopened below the last-child ╰─ (severed spine) at row ${i}: ${JSON.stringify(lines[i])}`).toBe(' ');
    }
  });

  it('labeled nested head (in-flight, not headerEmitted), last child of a live root: column closes below its ╰─', () => {
    // Topology: outer Agent (root, live) → inner Agent (live) → live leaf tool.
    // Nothing flushed, so inner keeps its label — a connector head with
    // grandchildren whose last-child `╰─` closes col-0 for the tool below.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('outer', 'Agent', '(orchestrator)', undefined);
    lane.addStartWithAgentContext('inner', 'Agent', '(researcher)', 'outer');
    lane.addStartWithAgentContext('inner-tool', 'Grep', '("TODO")', 'inner'); // live, no result

    const lines = stripAnsi(lane.getOverlay()).split('\n').filter(Boolean);

    // inner is the nested dispatch head: `│ ╰─ → Agent(researcher) …` (connector + label).
    const innerRow = lines.find((l) => l.includes('researcher'))!;
    expect(innerRow, 'inner head row missing').toBeDefined();
    expect(innerRow, `labeled nested head must lead with a connector; got: ${JSON.stringify(innerRow)}`)
      .toMatch(/^│ (╰─|├─) /);

    // The grandchild tool sits one level deeper with col-0 CLOSED (`  │ …`):
    // inner is outer's last child, so outer's spine ended at inner's `╰─`.
    const toolRow = lines.find((l) => l.includes('Grep'))!;
    expect(toolRow.startsWith('  │ '),
      `grandchild col-0 not closed below the last-child ╰─; got: ${JSON.stringify(toolRow)}`).toBe(true);
  });
});
