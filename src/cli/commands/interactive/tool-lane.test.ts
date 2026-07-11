/**
 * Tests for ToolLane — focused on the addStartWithAgentContext extension.
 *
 * The base addStart() uses an internal agentIdStack to track nested Agent/Task
 * tool calls. addStartWithAgentContext() bypasses the stack and lets the
 * caller specify the agentContext explicitly. This is needed for the skill-
 * streaming concurrent-mode renderer, which synthesizes Agent entries for
 * parallel sub-agents (where stack-based FIFO nesting breaks because child
 * events from N sources are interleaved, not strictly nested).
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { ToolLane } from './tool-lane.js';
import { displayWidth, stripAnsi } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import type { OutputEvent, SubagentProgressMeta } from '../../../agent/types.js';

function makeResult(content: string, isError = false): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 'unused',
    content,
    isError,
  };
}

describe('ToolLane.addStartWithAgentContext', () => {
  it('creates an entry with the given agentContext (does not consult agentIdStack)', () => {
    const lane = new ToolLane();
    // Sanity: nothing on the stack.
    lane.addStartWithAgentContext('tool-1', 'Read', '("foo.ts")', 'agent-A');

    // Entry's agentContext should be 'agent-A' even though no agent is on
    // the stack. The plain addStart() would have set agentContext=undefined.
    const overlay = lane.getOverlay();
    // 'agent-A' is not a real entry — child won't render at root because
    // it's tagged with an agentContext that has no corresponding root entry.
    // Verify it does NOT appear at the top level of the overlay.
    expect(overlay).not.toContain('Read');
  });

  it('does NOT push onto agentIdStack — subsequent addStart() inherits no parent', () => {
    const lane = new ToolLane();

    // Add a tool that, with the bug-prone old design, might pollute the stack.
    lane.addStartWithAgentContext('agent-1', 'Agent', '(critic-pragmatist)', undefined);

    // A subsequent regular addStart() should NOT see 'agent-1' as its parent.
    lane.addStart('child-1', 'Read', '("foo.ts")');

    // child-1 should render at the root (no agentContext).
    const overlay = lane.getOverlay();
    expect(overlay).toContain('Read');
    // child-1's entry has agentContext=undefined; agent-1 has agentContext=undefined too.
    // So both appear as siblings at the root level (no parent-child nesting).
  });

  it('renders as a child under a synthetic Agent root entry — full sub-agent simulation', () => {
    const lane = new ToolLane();

    // Synthesize a parent Agent entry at root.
    lane.addStartWithAgentContext('synth-agent-A', 'Agent', '(pragmatist)', undefined);
    // Add a child tool tagged with the synthetic agent's id.
    lane.addStartWithAgentContext('child-1', 'Read', '("foo.ts")', 'synth-agent-A');
    // Mark child as complete.
    lane.addResult('child-1', makeResult('12 lines'));

    const overlay = lane.getOverlay();
    // Root agent entry should appear.
    expect(overlay).toContain('Agent');
    expect(overlay).toContain('pragmatist');
    // Child tool should render under the agent (nested, with connector).
    expect(overlay).toContain('Read');
  });

  it('flush() groups synthetic-context children under their parent', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('synth-agent-A', 'Agent', '(pragmatist)', undefined);
    lane.addStartWithAgentContext('child-1', 'Read', '("foo.ts")', 'synth-agent-A');
    lane.addResult('child-1', makeResult('12 lines'));
    lane.addResult('synth-agent-A', makeResult('done'));

    const lines = lane.flush();
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join('\n');
    expect(joined).toContain('Agent');
    expect(joined).toContain('Read');
  });

  it('two parallel synthetic agents: each child correctly tagged, no cross-pollution', () => {
    const lane = new ToolLane();

    // Two parallel agents.
    lane.addStartWithAgentContext('synth-A', 'Agent', '(pragmatist)', undefined);
    lane.addStartWithAgentContext('synth-B', 'Agent', '(paranoid)', undefined);

    // Interleaved children — A's tool, then B's tool, then A's again.
    lane.addStartWithAgentContext('a-tool-1', 'Read', '("a.ts")', 'synth-A');
    lane.addStartWithAgentContext('b-tool-1', 'Bash', '("grep")', 'synth-B');
    lane.addStartWithAgentContext('a-tool-2', 'Glob', '("**/*.ts")', 'synth-A');

    lane.addResult('a-tool-1', makeResult('a result'));
    lane.addResult('b-tool-1', makeResult('b result'));
    lane.addResult('a-tool-2', makeResult('glob result'));
    lane.addResult('synth-A', makeResult('A done'));
    lane.addResult('synth-B', makeResult('B done'));

    const lines = lane.flush();
    const joined = lines.join('\n');

    // Both agents should appear.
    expect(joined).toContain('pragmatist');
    expect(joined).toContain('paranoid');
    // All three children should appear.
    expect(joined).toContain('Read');
    expect(joined).toContain('Bash');
    expect(joined).toContain('Glob');
  });
});

describe('ToolLane.addStartWithAgentContext idempotent update', () => {
  it('second call with same toolUseId updates toolInput and prefix without duplicating entry', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('tool-1', 'Read', '("foo.ts")', undefined);

    const overlayBefore = lane.getOverlay();
    expect(overlayBefore).toContain('foo.ts');

    lane.addStartWithAgentContext('tool-1', 'Read', '("bar.ts" — 42 lines)', undefined);

    const overlayAfter = lane.getOverlay();
    expect(overlayAfter).toContain('bar.ts');
    expect(overlayAfter).not.toContain('foo.ts');

    const lines = lane.flush();
    const readOccurrences = lines.filter((l) => l.includes('Read'));
    expect(readOccurrences).toHaveLength(1);
  });

  it('idempotent update preserves agentContext when new agentContext is undefined', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('synth-A', 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('child-1', 'Read', '("foo.ts")', 'synth-A');

    lane.addStartWithAgentContext('child-1', 'Read', '("foo.ts" — 20 lines)', undefined);

    const overlay = lane.getOverlay();
    expect(overlay).toContain('20 lines');
    expect(overlay).not.toContain('foo.ts")\n');
  });
});

describe('ToolLane.upsertTextChild / removeTextChildrenUnder', () => {
  it('upsertTextChild creates a text child rendered under the parent Agent', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('synth-A', 'Agent', '(researcher)', undefined);
    lane.upsertTextChild('text-1', 'synth-A', 'I found something interesting.');

    const overlay = lane.getOverlay();
    expect(overlay).toContain('researcher');
    expect(overlay).toContain('I found something interesting.');
  });

  it('upsertTextChild called twice with same id replaces the text', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('synth-A', 'Agent', '(researcher)', undefined);
    lane.upsertTextChild('text-1', 'synth-A', 'first');
    lane.upsertTextChild('text-1', 'synth-A', 'first and then second');

    const overlay = lane.getOverlay();
    expect(overlay).toContain('first and then second');
    // The earlier shorter version is gone (it was replaced, not appended).
    const shortMatches = (overlay.match(/first(?! and)/g) ?? []).length;
    expect(shortMatches).toBe(0);
  });

  it('removeTextChildrenUnder removes only matching text children, leaves tools alone', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('synth-A', 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('a-tool', 'Read', '("a.ts")', 'synth-A');
    lane.upsertTextChild('text-1', 'synth-A', 'old narration');

    lane.removeTextChildrenUnder('synth-A');
    lane.upsertTextChild('text-2', 'synth-A', 'new narration');

    const overlay = lane.getOverlay();
    expect(overlay).toContain('Read');                // tool child survived
    expect(overlay).toContain('new narration');
    expect(overlay).not.toContain('old narration');
  });

  it('flush: text child renders AFTER tool children under the same Agent', () => {
    // Subagent assistant-text is its summary/handoff emitted after the
    // tool_use blocks — rendering the narration below the tools preserves
    // that temporal order and keeps the latest narration visually adjacent
    // to the eventual Done line. Inverse of the original ordering before
    // the layout change in tool-lane-render.ts.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('synth-A', 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('a-tool-1', 'Read', '("a.ts")', 'synth-A');
    lane.addResult('a-tool-1', makeResult('5 lines'));
    lane.upsertTextChild('text-1', 'synth-A', 'narration line');
    lane.addResult('synth-A', makeResult('done'));

    const lines = lane.flush();
    const joined = lines.join('\n');
    const textIdx = joined.indexOf('narration line');
    const toolIdx = joined.indexOf('Read');
    expect(textIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeLessThan(textIdx);
  });

  /**
   * Compose is in `DAG_TOOLS`, not `SUBAGENT_TOOLS` — but the nested-children
   * gates (`getOverlay`, `flush`) test the union `NESTING_TOOLS`. This proves
   * a `compose` root entry with children rendered with `agentContext = <compose
   * tool_use_id>` produces the indented child block, not a flat root line +
   * orphaned siblings.
   */
  it('renders nested children under a compose root entry (NESTING_TOOLS gate)', () => {
    const lane = new ToolLane();
    // Compose root entry. `addStartWithAgentContext` with parent=undefined
    // matches the orchestrator-handler path for a compose tool_use_detail.
    lane.addStartWithAgentContext('compose-1', 'compose', '(3 nodes)', undefined);
    // Two synthetic Agent children anchored at the compose entry.
    lane.addStartWithAgentContext('agent-a', 'Agent', '(diagnose [1/2])', 'compose-1');
    lane.addStartWithAgentContext('agent-b', 'Agent', '(verify [2/2])', 'compose-1');

    const overlay = lane.getOverlay();
    expect(overlay).toContain('compose');
    expect(overlay).toContain('diagnose');
    expect(overlay).toContain('verify');
    // Children must render INDENTED (nested-block branch fired), not as flat
    // sibling lines. We measure by content offset — the column where the
    // semantically interesting text starts (after any leading whitespace,
    // spine glyphs, or tree connectors). Post-spine-renderer, the parent
    // row is `'  ' + prefix` while the child row is `'  │ ├─ ' + prefix`,
    // so the child's content lives further to the right.
    const lines = overlay.split('\n');
    const composeLine = lines.find((l) => l.includes('compose'));
    const diagnoseLine = lines.find((l) => l.includes('diagnose'));
    expect(composeLine).toBeDefined();
    expect(diagnoseLine).toBeDefined();
    // Indent prefix = any leading whitespace + spine `│` + tree connectors `├ ╰ ─`.
    // Whatever lies BEFORE the first real content char is "indent" — we count its width.
    const indentPattern = /^[\s│├╰─└┌]*/;
    const composeIndent = composeLine!.match(indentPattern)![0]!.length;
    const diagnoseIndent = diagnoseLine!.match(indentPattern)![0]!.length;
    expect(diagnoseIndent).toBeGreaterThan(composeIndent);
  });

  it('flush() emits compose with nested-children layout (NESTING_TOOLS gate)', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('compose-1', 'compose', '(2 nodes)', undefined);
    lane.addStartWithAgentContext('agent-a', 'Agent', '(diagnose [1/2])', 'compose-1');
    lane.addResult('agent-a', makeResult('done'));
    lane.addResult('compose-1', makeResult('all nodes complete'));

    const lines = lane.flush();
    const joined = lines.join('\n');
    // Compose appears, agent child appears underneath — not as a separate
    // root tool group (which would be the SUBAGENT_TOOLS-only fallback).
    expect(joined).toContain('compose');
    expect(joined).toContain('diagnose');
  });

  it('same-tool siblings at threshold collapse into a single grouped row', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('synth-A', 'Agent', '(researcher)', undefined);
    lane.upsertTextChild('text-1', 'synth-A', 'some narration');
    for (let i = 1; i <= 4; i++) {
      lane.addStartWithAgentContext(`a-tool-${i}`, 'Read', `("f${i}.ts")`, 'synth-A');
      lane.addResult(`a-tool-${i}`, makeResult(`${i} lines`));
    }
    lane.addResult('synth-A', makeResult('done'));

    const lines = lane.flush();
    const joined = lines.join('\n');
    expect(joined).toContain('some narration');
    expect(joined).toContain('Read');
    expect(joined).toContain('×4');
    expect(joined).toContain('4 done');
    expect(joined).not.toContain('tool uses');
  });

  it('parallel Agent siblings (≥2) collapse to a grouped fan-out row', () => {
    const lane = new ToolLane();
    lane.addStart('skill-1', 'skill', '(review)');
    for (let i = 1; i <= 5; i++) {
      lane.addStartWithAgentContext(`agent-${i}`, 'Agent', '(skill-review)', 'skill-1');
    }
    for (let i = 1; i <= 3; i++) {
      lane.addResult(`agent-${i}`, makeResult('summary'));
    }
    lane.addResult('skill-1', makeResult('done'));

    const overlay = lane.getOverlay();
    expect(overlay).toContain('skill');
    expect(overlay).toContain('Agent');
    expect(overlay).toContain('(skill-review)');
    expect(overlay).toContain('×5');
    expect(overlay).toContain('3/5 done');
    expect(overlay).not.toContain('tool uses');
  });

  it('different Agent labels do NOT merge — group key includes the dispatch label', () => {
    const lane = new ToolLane();
    lane.addStart('skill-1', 'skill', '(review)');
    for (let i = 1; i <= 3; i++) {
      lane.addStartWithAgentContext(`a-${i}`, 'Agent', '(skill-review)', 'skill-1');
      lane.addResult(`a-${i}`, makeResult('done'));
    }
    for (let i = 1; i <= 2; i++) {
      lane.addStartWithAgentContext(`b-${i}`, 'Agent', '(critic-paranoid)', 'skill-1');
      lane.addResult(`b-${i}`, makeResult('done'));
    }
    lane.addResult('skill-1', makeResult('done'));

    const overlay = lane.getOverlay();
    expect(overlay).toContain('(skill-review)');
    expect(overlay).toContain('(critic-paranoid)');
    expect(overlay).toContain('×3');
    expect(overlay).toContain('×2');
  });

  it('two leaf-tool siblings do NOT collapse — under threshold-3, render individually', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('synth-A', 'Agent', '(researcher)', undefined);
    lane.addStartWithAgentContext('r-1', 'Read', '("a.ts")', 'synth-A');
    lane.addResult('r-1', makeResult('12 lines'));
    lane.addStartWithAgentContext('r-2', 'Read', '("b.ts")', 'synth-A');
    lane.addResult('r-2', makeResult('20 lines'));
    lane.addResult('synth-A', makeResult('done'));

    const lines = lane.flush();
    const joined = lines.join('\n');
    expect(joined).not.toContain('×2');
    expect(joined).toContain('a.ts');
    expect(joined).toContain('b.ts');
  });

  it('categorical overflow lists tool-name buckets when the visible budget overflows', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('synth-A', 'Agent', '(researcher)', undefined);
    // Recency window keeps the most-recent 3 visible; the OLDER head collapses
    // into the overflow line. Dispatch the intended-hidden pair (Write, Glob)
    // FIRST so they land in the older head.
    lane.addStartWithAgentContext('t-4', 'Write', '("c.ts")', 'synth-A');
    lane.addResult('t-4', makeResult('1 line'));
    lane.addStartWithAgentContext('t-5', 'Glob', '("**/*")', 'synth-A');
    lane.addResult('t-5', makeResult('1 line'));
    lane.addStartWithAgentContext('t-1', 'Read', '("a.ts")', 'synth-A');
    lane.addResult('t-1', makeResult('1 line'));
    lane.addStartWithAgentContext('t-2', 'Bash', '("ls")', 'synth-A');
    lane.addResult('t-2', makeResult('1 line'));
    lane.addStartWithAgentContext('t-3', 'Grep', '("foo")', 'synth-A');
    lane.addResult('t-3', makeResult('1 line'));
    lane.addResult('synth-A', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    // Pin the exact bucket grammar — pluralization changes are user-visible
    // string changes and must surface in this test, not silently in
    // production. Hidden = [Write, Glob] each at n=1, so no pluralization.
    expect(overlay).toMatch(/… \+2 \(1 Write, 1 Glob\)/);
    expect(overlay).not.toMatch(/\+2 tool uses/);
  });

  // ─── H2 regression: sibilant-cluster names must not gain a bare `-s` ─────
  //
  // `bash` is the most common leaf tool in the corpus. The naive plural
  // rule produces `2 bashs` which is awkward and a user-visible regression
  // from the pre-pluralization format. Verify the sibilant-cluster guard
  // (sh|ch|x|z + already-`s`) keeps these names invariant.
  it('categorical overflow keeps sibilant-cluster names invariant when n > 1', () => {
    // Hidden = [bash, bash] (2 instances, below GROUP_THRESHOLD_LEAF=3, so
    // they appear individually and land in the categorical bucket). Recency
    // window keeps the newest 3 visible, so dispatch the 2 bash calls FIRST
    // (oldest) to land them in the collapsed older head.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'Agent', '(tester)', undefined);
    lane.addStartWithAgentContext('b1', 'bash', '("ls")', 'parent');
    lane.addResult('b1', makeResult('ok'));
    lane.addStartWithAgentContext('b2', 'bash', '("pwd")', 'parent');
    lane.addResult('b2', makeResult('ok'));
    lane.addStartWithAgentContext('r1', 'Read', '("a.ts")', 'parent');
    lane.addResult('r1', makeResult('ok'));
    lane.addStartWithAgentContext('g1', 'Grep', '("TODO")', 'parent');
    lane.addResult('g1', makeResult('ok'));
    lane.addStartWithAgentContext('glob1', 'Glob', '("**/*")', 'parent');
    lane.addResult('glob1', makeResult('ok'));
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    // bash → bash (sibilant, invariant), NOT bashs.
    expect(overlay).toMatch(/… \+2 \(2 bash\)/);
    expect(overlay).not.toMatch(/bashs/);
    expect(overlay).not.toMatch(/bashes/);
  });

  describe('rendered lines respect terminal width (no tree-prefix-orphan wraps)', () => {
    const originalColumns = process.stdout.columns;

    beforeEach(() => {
      // Pin terminal width to a deterministic value for the test. The
      // overlay renderer reads `process.stdout.columns` at render time
      // via `getTerminalWidth()`; reassigning the descriptor is the
      // standard pattern for testing terminal-width-aware renderers.
      Object.defineProperty(process.stdout, 'columns', {
        configurable: true,
        writable: true,
        value: 88,
      });
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, 'columns', {
        configurable: true,
        writable: true,
        value: originalColumns,
      });
    });

    /**
     * Regression for the "broken-up rendering" bug: a subagent child whose
     * prefix is sized at `cols - 14` plus a `— ✓ <60-char preview>` outcome
     * suffix would produce a composed line of `cols + ~57` chars, which the
     * terminal hard-wraps to column 0 with no tree connector — visually
     * splitting the tree and orphaning a flush-left raw-text continuation
     * between siblings. Every rendered overlay line must fit within
     * terminal width (display-width, ANSI-stripped) so no continuation
     * appears at column 0.
     */
    it('overlay child with long prefix + long result preview fits within terminal width', () => {
      const lane = new ToolLane();
      lane.addStartWithAgentContext('synth-A', 'Agent', '(skill-research)', undefined);
      // Simulate what stream-renderer-subagent.ts does: budget the prefix
      // to `cols - 14`. Args here mirror a real memory_search call whose
      // toolInput is a long natural-language query.
      const longQuery = 'agent-afk TUI renderer streaming tool call subagent grandchild prefix overflow';
      const cols = process.stdout.columns ?? 88;
      const maxWidth = Math.max(20, cols - 14);
      lane.addStartWithAgentContext(
        'memsearch-1',
        'memory_search',
        ` ${longQuery}`,
        'synth-A',
        maxWidth,
      );
      // Result content like a JSON dump of matching facts — easily > 60 chars
      // so formatOutcome falls through to the preview slice path.
      lane.addResult(
        'memsearch-1',
        makeResult('{"type":"procedure","content":"# Telemetry surface split between AFK and Atlas"}'),
      );

      const overlay = lane.getOverlay();
      const lines = overlay.split('\n');
      // Every visible line must fit within terminal width when ANSI-stripped
      // and grapheme-measured. If any line exceeds `cols`, the terminal will
      // soft-wrap it to column 0 — reproducing the original bug.
      for (const line of lines) {
        expect(
          displayWidth(stripAnsi(line)),
          `line exceeds terminal width (${cols}): ${JSON.stringify(line)}`,
        ).toBeLessThanOrEqual(cols);
      }
      // The prefix must still be present — clamping shouldn't elide the
      // tool name, which leads the line. The outcome tail may be truncated.
      expect(stripAnsi(overlay)).toContain('memory_search');
    });

    it('overlay child with no result but long prefix fits within terminal width', () => {
      const lane = new ToolLane();
      lane.addStartWithAgentContext('synth-A', 'Agent', '(skill-research)', undefined);
      const cols = process.stdout.columns ?? 88;
      const maxWidth = Math.max(20, cols - 14);
      // No addResult — exercises the in-progress branch (two lines:
      // prefix + dim verb).
      lane.addStartWithAgentContext(
        'bash-1',
        'bash',
        ' ' + 'echo '.repeat(40),
        'synth-A',
        maxWidth,
      );
      const overlay = lane.getOverlay();
      for (const line of overlay.split('\n')) {
        expect(
          displayWidth(stripAnsi(line)),
          `line exceeds terminal width (${cols}): ${JSON.stringify(line)}`,
        ).toBeLessThanOrEqual(cols);
      }
    });

    /**
     * Regression for the orchestrator-root variant of the tree-prefix-orphan
     * bug. The screenshot in agent-afk's review of PR #350 showed:
     *
     *   $ bash gh pr view 350 --json number,title,state,headRefName,baseRefNa
     *   e,url 2>&1 | h… — ✓ {baseRefName, headRefName, number, state, …}
     *
     * The wrapped continuation `e,url 2>&1 | h…` lacks the `│ │` tree gutter
     * because `ToolLane.getOverlay()`'s root-entry path (this file, lines
     * ~280–325) pushed the composed line with no clampLineToTerminal,
     * letting the terminal soft-wrap the overflow to column 0. Sibling
     * tool-lane-render.ts paths (renderOverlayChildren, renderFlushChildren)
     * always clamp their composed lines via clampLineToTerminal; the
     * orchestrator-root path was the lone exception.
     *
     * This test pins the fix: a top-level bash entry (no agentContext) with
     * a long input and a long result must NOT wrap.
     */
    it('orchestrator-root bash with long input + long result fits within terminal width', () => {
      const lane = new ToolLane();
      const cols = process.stdout.columns ?? 88;
      // Match the screenshot's failure mode: a long bash command pushed as a
      // root entry (agentContext=undefined) with a long JSON-shaped result.
      lane.addStart(
        'bash-root-1',
        'bash',
        ' gh pr view 350 --json number,title,state,headRefName,baseRefName,url 2>&1 | head',
      );
      lane.addResult(
        'bash-root-1',
        makeResult('{baseRefName, headRefName, number, state, title, url}'),
      );

      const overlay = lane.getOverlay();
      for (const line of overlay.split('\n')) {
        expect(
          displayWidth(stripAnsi(line)),
          `root-entry line exceeds terminal width (${cols}): ${JSON.stringify(line)}`,
        ).toBeLessThanOrEqual(cols);
      }
      // Tool name must survive — clamping should elide the outcome tail, not
      // the leading prefix that carries the tool identity.
      expect(stripAnsi(overlay)).toContain('bash');
    });

    it('orchestrator-root in-progress bash with long input fits within terminal width', () => {
      const lane = new ToolLane();
      const cols = process.stdout.columns ?? 88;
      // In-progress branch: no addResult, so getOverlay pushes the
      // ' …' marker line via the unclamped root-entry path.
      lane.addStart('bash-root-2', 'bash', ' ' + 'echo hello world '.repeat(20));

      const overlay = lane.getOverlay();
      for (const line of overlay.split('\n')) {
        expect(
          displayWidth(stripAnsi(line)),
          `in-progress root line exceeds terminal width (${cols}): ${JSON.stringify(line)}`,
        ).toBeLessThanOrEqual(cols);
      }
    });

    /**
     * Regression for the "weird wrapping in the diff" + "write_file text comes
     * and goes" report: a diff body line under a subagent child (rendered via
     * renderOverlayChildren, NOT the root-entry path) was pushed RAW with no
     * clampLineToTerminal. A long line of file content then soft-wrapped to
     * column 0 with no `│` spine gutter, orphaning the continuation between
     * sibling rows. In the live overlay the same overflow also desyncs the
     * compositor's logical-line row accounting (frameLines.length, which
     * assumes 1 line = 1 visual row) from log-update's wrap-aware count,
     * making the block flicker ("comes and goes") on every repaint.
     *
     * The width assertion is the proxy for both symptoms: if every emitted
     * line fits within `cols`, the terminal never soft-wraps, so there is no
     * orphaned continuation AND no row-count desync.
     */
    it('overlay diff under a subagent child fits within terminal width (no orphan-wrap / flicker)', () => {
      const lane = new ToolLane();
      const cols = process.stdout.columns ?? 88;
      lane.addStartWithAgentContext('synth-A', 'Agent', '(skill-diagnose)', undefined);
      lane.addStartWithAgentContext('edit-1', 'edit_file', ' verification-prompt.md', 'synth-A');
      lane.addResult('edit-1', makeResult('Edited verification-prompt.md'));
      // A diff whose body line is far wider than 88 cols — the failure shape
      // from the screenshot ("- You are testing a hypothesis … propo" wrapped
      // to "sed fix resolves the failure." at column 0).
      lane.addDiff('edit-1', {
        addedLines: 1,
        removedLines: 1,
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          lines: [
            { kind: '-', text: 'You are testing a hypothesis in an isolated worktree to determine if a proposed fix resolves the failure.' },
            { kind: '+', text: 'You are performing a **static code-reading assessment** of a proposed fix in an isolated worktree to determine whether it would resolve the failure.' },
          ],
        }],
      });

      const overlay = lane.getOverlay();
      // Sanity: the diff actually rendered (so this test can fail loudly if a
      // future refactor stops emitting the block).
      expect(stripAnsi(overlay)).toContain('across 1 hunk');
      for (const line of overlay.split('\n')) {
        expect(
          displayWidth(stripAnsi(line)),
          `overlay diff line exceeds terminal width (${cols}): ${JSON.stringify(line)}`,
        ).toBeLessThanOrEqual(cols);
      }
    });

    it('scrollback (flush) diff under a subagent child fits within terminal width', () => {
      const lane = new ToolLane();
      const cols = process.stdout.columns ?? 88;
      lane.addStartWithAgentContext('synth-A', 'Agent', '(skill-diagnose)', undefined);
      lane.addStartWithAgentContext('edit-1', 'edit_file', ' verification-prompt.md', 'synth-A');
      lane.addResult('edit-1', makeResult('Edited verification-prompt.md'));
      lane.addDiff('edit-1', {
        addedLines: 1,
        removedLines: 0,
        hunks: [{
          oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
          lines: [
            { kind: '+', text: 'A reproducer command or failing test that demonstrates the regression before the fix is applied and passes cleanly afterward.' },
          ],
        }],
      });

      const flushed = lane.flush().join('\n');
      for (const line of flushed.split('\n')) {
        expect(
          displayWidth(stripAnsi(line)),
          `flush diff line exceeds terminal width (${cols}): ${JSON.stringify(line)}`,
        ).toBeLessThanOrEqual(cols);
      }
    });

    it('scrollback (flush) diff under a grouped write_file ×2 fits within terminal width', () => {
      const lane = new ToolLane();
      const cols = process.stdout.columns ?? 88;
      // Two root-level write_file calls → renderGroupedRootTools path.
      lane.addStart('tu_a', 'write_file', '(a.ts)');
      lane.addStart('tu_b', 'write_file', '(b.ts)');
      lane.addResult('tu_a', makeResult('Wrote a.ts'));
      lane.addResult('tu_b', makeResult('Wrote b.ts'));
      const longLine = 'const veryLongIdentifierForTheRegressionTest = someModule.callWithAReallyLongArgumentListThatExceedsEightyEightColumns(alpha, beta, gamma);';
      lane.addDiff('tu_a', {
        addedLines: 1, removedLines: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: '+', text: longLine }] }],
      });
      lane.addDiff('tu_b', {
        addedLines: 1, removedLines: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: '+', text: longLine }] }],
      });

      const flushed = lane.flush().join('\n');
      for (const line of flushed.split('\n')) {
        expect(
          displayWidth(stripAnsi(line)),
          `grouped flush diff line exceeds terminal width (${cols}): ${JSON.stringify(line)}`,
        ).toBeLessThanOrEqual(cols);
      }
    });
  });
});

// ─── Phase 1 failing tests ────────────────────────────────────────────────────
//
// Tests 4 and 5 are expected to FAIL on the current codebase. They gate bugs #4
// and #5 and will turn green at checkpoints 2c and 2b respectively.

// ─── Bug #4 — counter unification: progress.toolUses blindly overwrites ──────
//
// Root cause: stream-renderer-subagent.ts:156:
//   if (event.progress.toolUses) source.stats.toolUses = event.progress.toolUses
//
// This REPLACES the incrementally-maintained per-tool_use_detail counter with the
// value from the progress event. Progress events report a different quantity (SDK
// iteration count) that may be lower than the increment-only counter.
//
// Fix (checkpoint 2c): separate the counters —
//   source.stats.toolUses     = increment-only (tool_use_detail path only)
//   source.stats.progressReportedToolUses = value from progress events
//
// Test: fire 5 tool_use_detail events, assert toolUses=5. Then fire progress with
// toolUses=100. Assert toolUses still 5 (progress must NOT overwrite).
//
// FAILING on current code: after progress event, toolUses = 100 (blind replace).

describe('Bug #4 — progress event must not overwrite increment-only toolUses counter', () => {
  it('progress.toolUses=100 must not overwrite toolUses accumulated from 5 tool_use_detail events', async () => {
    const { handleSubagentEvent, synthesizeAgentEntry } = await import(
      '../../_lib/stream-renderer-subagent.js'
    );
    const { freshSourceState } = await import('../../_lib/stream-renderer-source.js');

    function makeToolStartEvent(id: string, name: string, input: string): OutputEvent {
      return {
        type: 'chunk',
        chunk: { type: 'tool_use_detail', toolUseId: id, toolName: name, toolInput: input },
      };
    }

    function makeProgressEvent(toolUses: number): OutputEvent {
      return {
        type: 'progress',
        progress: { taskId: 't', description: 'd', totalTokens: 0, toolUses, durationMs: 0 },
      };
    }

    const lane = new ToolLane();
    const { writer, lines: _lines } = { writer: { line: (_: string) => {}, raw: (_: string) => {}, success: (_: string) => {}, info: (_: string) => {}, warn: (_: string) => {}, error: (_: string) => {} }, lines: [] as string[] };
    const ctx = {
      isTTY: false,
      compositor: null,
      toolLane: lane,
      out: writer,
      streamingMarkdown: new Map(),
    };

    const source = freshSourceState('counter-test');
    synthesizeAgentEntry('src-counter', source, ctx);

    // Fire 5 tool_use_detail events — each increments source.stats.toolUses by 1
    // (stream-renderer-subagent.ts:175: source.stats.toolUses += 1)
    for (let i = 1; i <= 5; i++) {
      handleSubagentEvent(
        makeToolStartEvent(`t${i}`, 'Read', `("f${i}.ts")`),
        'src-counter', source, ctx,
      );
    }
    expect(source.stats.toolUses).toBe(5);

    // Fire one progress event with toolUses=100 (higher than the current count).
    // After fix: toolUses stays at 5 (progress value stored separately).
    // Current code: blind replace — toolUses becomes 100.
    handleSubagentEvent(makeProgressEvent(100), 'src-counter', source, ctx);

    // FAILING on current code:
    //   stream-renderer-subagent.ts:156: source.stats.toolUses = event.progress.toolUses
    //   → toolUses is now 100 instead of 5.
    //
    // After fix (checkpoint 2c):
    //   progress event stores toolUses in source.stats.progressReportedToolUses (new field)
    //   source.stats.toolUses remains the increment-only counter = 5.
    expect(source.stats.toolUses).toBe(5);
  });

  it('progress.toolUses=3 (lower than accumulated 5) must not regress the counter', async () => {
    // Complementary check: progress with a LOWER value (stale snapshot) also must
    // not overwrite a higher accumulated count.
    const { handleSubagentEvent, synthesizeAgentEntry } = await import(
      '../../_lib/stream-renderer-subagent.js'
    );
    const { freshSourceState } = await import('../../_lib/stream-renderer-source.js');

    function makeToolStartEvent(id: string, name: string, input: string): OutputEvent {
      return {
        type: 'chunk',
        chunk: { type: 'tool_use_detail', toolUseId: id, toolName: name, toolInput: input },
      };
    }

    function makeProgressEvent(toolUses: number): OutputEvent {
      return {
        type: 'progress',
        progress: { taskId: 't', description: 'd', totalTokens: 0, toolUses, durationMs: 0 },
      };
    }

    const lane = new ToolLane();
    const writer = { line: (_: string) => {}, raw: (_: string) => {}, success: (_: string) => {}, info: (_: string) => {}, warn: (_: string) => {}, error: (_: string) => {} };
    const ctx = {
      isTTY: false,
      compositor: null,
      toolLane: lane,
      out: writer,
      streamingMarkdown: new Map(),
    };

    const source = freshSourceState('counter-test-2');
    synthesizeAgentEntry('src-counter-2', source, ctx);

    for (let i = 1; i <= 5; i++) {
      handleSubagentEvent(
        makeToolStartEvent(`t${i}`, 'Read', `("f${i}.ts")`),
        'src-counter-2', source, ctx,
      );
    }
    expect(source.stats.toolUses).toBe(5);

    // Progress reports 3 (stale/lower snapshot — this is the primary failure mode)
    handleSubagentEvent(makeProgressEvent(3), 'src-counter-2', source, ctx);

    // FAILING on current code:
    //   source.stats.toolUses = 3 (blind replace with lower stale value)
    //   → assert 5 fails because current code returns 3.
    //
    // After fix: toolUses stays at 5.
    expect(source.stats.toolUses).toBe(5);
  });
});

// ─── Bug #5 — Done result connector: ⎿ instead of └, wrong tree position ─────
//
// Root cause: tool-lane-render.ts:343-345
//   if (agent.agentResultSummary) {
//     childLines.push('    ' + palette.dim('⎿  ' + agent.agentResultSummary));
//   }
//
// Two issues:
//   1. The connector is '⎿' (tool-result glyph) instead of '└' (tree last-child connector)
//   2. agentResultSummary is appended AFTER renderFlushChildren returns — but since the
//      overflow line is the LAST line from renderFlushChildren, the summary appears after
//      the overflow (correct position), but with the wrong connector.
//
// Fix (checkpoint 2b, declarative assignConnectors):
//   agentResultSummary is added as a synthetic sibling BEFORE assignConnectors runs.
//   assignConnectors assigns '└ ' to the last item (the result summary) and '├ ' to
//   all prior items including the overflow ellipsis.
//
// Test: build agent entry with MAX_VISIBLE_CHILDREN+1 children, add agentResultSummary,
// flush, assert:
//   1. Overflow ellipsis appears BEFORE result summary line
//   2. Result summary has '└ ' connector (not '⎿' or '├ ')
//
// FAILING on current code:
//   - Result summary uses '⎿' not '└ '  → assertion 2 FAILS.

describe('Bug #5 — agentResultSummary must use └ tree connector and appear after overflow', () => {
  // Invariant: spine topology contract for agentResultSummary
  //   Column pins (matches the PR #535 thinking-tail invariant at line ~1926):
  //     col 0 = `│` (parent's live spine), col 2 = connector glyph (`├` non-last,
  //     `╰` last), col 5 = content. Drift at any column = regression.
  //   Ordering:
  //     overflow ellipsis is a sibling row, agentResultSummary is the LAST
  //     sibling. assignConnectors assigns `├` to overflow, `╰` to summary.
  //   Symbols:
  //     summary connector is `╰` (tree last-child) NOT `⎿` (tool-result glyph).
  //
  // The original Bug #5 tests asserted `toContain('╰')` / `not.toContain('⎿')`
  // — a permissive single-glyph check that would slip past column drift, glyph
  // substitution, or position reversal. These tests now layer:
  //   (a) the original semantic assertions (kept for backward-compat & doc),
  //   (b) column-pin assertions via indexOf().toBe(N) (PR #535 pattern),
  //   (c) full-topology inline snapshots (loud diff on any structural drift).
  it('overflow ellipsis appears BEFORE result summary AND result summary uses ╰ connector (not ⎿)', () => {
    const lane = new ToolLane();
    const agentId = '__synth_agent_overflow-test';
    lane.addStartWithAgentContext(agentId, 'Agent', '(overflow-tester)', undefined);

    // Use MAX_VISIBLE_CHILDREN + 1 = 4 children with DIFFERENT tool names to prevent
    // sibling grouping (grouping collapses to 1 row, eliminating overflow).
    // MAX_VISIBLE_CHILDREN = 3 (from tool-lane-format.ts). So 4 children → 3 visible + 1 overflow.
    const toolNames = ['Read', 'Bash', 'Grep', 'Glob'];
    for (let i = 0; i < 4; i++) {
      lane.addStartWithAgentContext(
        `overflow-child-${i}`, toolNames[i]!, `("file${i}.ts")`, agentId,
      );
      lane.addResult(`overflow-child-${i}`, makeResult(`result${i}`));
    }

    // Attach the Done summary (as finalizeSubagent does)
    lane.setAgentResultSummary(agentId, 'Done (4 tool calls · 2.5s)');
    lane.addResult(agentId, {
      type: 'tool_result',
      toolUseId: 'synthetic',
      content: 'Done (4 tool calls · 2.5s)',
      isError: false,
    });

    // Strip ANSI before column-pin assertions — palette escapes would skew indexOf.
    const stripped = stripAnsi(lane.flush().join('\n'));
    const allLines = stripped.split('\n');

    // Find overflow line: matches "… +N" pattern from formatCategoricalOverflow
    const overflowIdx = allLines.findIndex((l) => /….*\+\d+/.test(l));
    // Find result summary line
    const doneIdx = allLines.findIndex((l) => l.includes('Done (4 tool calls'));

    // Both lines must exist
    expect(overflowIdx, 'overflow ellipsis line must exist').toBeGreaterThanOrEqual(0);
    expect(doneIdx, 'result summary line must exist').toBeGreaterThanOrEqual(0);

    // Assertion 1: overflow must appear BEFORE result summary.
    // assignConnectors makes the summary the last sibling, so overflow (a
    // prior sibling) renders above it.
    expect(overflowIdx).toBeLessThan(doneIdx);

    const overflowLine = allLines[overflowIdx]!;
    const doneLine = allLines[doneIdx]!;

    // Assertion 2 (legacy semantic — kept as backward-compat documentation):
    // result summary uses `╰`, not `⎿` (tool-result glyph) or `├` (non-last).
    expect(doneLine).not.toContain('⎿');
    expect(doneLine).toContain('╰');

    // Assertion 3 (column-pin contract — PR #535 pattern):
    //   `│ <connector><pad><content>` — connector at col 2, content at col 5.
    //   The overflow line uses `├` (non-last sibling); summary uses `╰` (last).
    expect(overflowLine.indexOf('├')).toBe(2);
    expect(overflowLine.indexOf('…')).toBe(5);
    expect(doneLine.indexOf('╰')).toBe(2);
    expect(doneLine.indexOf('Done (4 tool calls')).toBe(5);

    // Assertion 4 (full-topology snapshot): locks the entire overlay shape.
    // Any structural drift — column position, sibling ordering, glyph
    // substitution, terminal-width wrapping, ANSI palette leak — surfaces
    // as a visible inline-snapshot diff instead of slipping past a
    // single-glyph toContain. Populated by `pnpm test -u` on first run.
    expect(stripped).toMatchInlineSnapshot(`
      "◉ → Agent(overflow-tester) [subagent] — 4 tool calls
      │ ├─ … +1 (1 Read)
      │ ├─ $ Bash("file1.ts") — ✓ result1
      │ ├─ ● Grep("file2.ts") — ✓ result2
      │ ├─ ● Glob("file3.ts") — ✓ result3
      │ ╰─ Done (4 tool calls · 2.5s)"
    `);
  });

  it('single child + agentResultSummary: result summary uses ╰ not ⎿', () => {
    // Simpler variant without overflow — the connector must still be `╰`.
    const lane = new ToolLane();
    const agentId = '__synth_agent_simple-connector';
    lane.addStartWithAgentContext(agentId, 'Agent', '(connector-tester)', undefined);

    lane.addStartWithAgentContext('c1', 'Read', '("data.ts")', agentId);
    lane.addResult('c1', makeResult('ok'));

    lane.setAgentResultSummary(agentId, 'Done (1 tool · 0.8s)');
    lane.addResult(agentId, {
      type: 'tool_result', toolUseId: 'synthetic', content: 'Done (1 tool · 0.8s)', isError: false,
    });

    // Strip ANSI before column-pin assertions (see Assertion 3 below).
    const stripped = stripAnsi(lane.flush().join('\n'));
    const allLines = stripped.split('\n');
    const doneIdx = allLines.findIndex((l) => l.includes('Done (1 tool'));
    expect(doneIdx, 'result summary line must exist').toBeGreaterThanOrEqual(0);
    const doneLine = allLines[doneIdx]!;

    // Legacy semantic assertions — kept for backward-compat documentation.
    expect(doneLine).not.toContain('⎿');
    expect(doneLine).toContain('╰');

    // Column-pin contract (PR #535 pattern):
    //   `│ ╰─ Done (…)` — `╰` at col 2 (connector column), `Done` at col 5.
    expect(doneLine.indexOf('╰')).toBe(2);
    expect(doneLine.indexOf('Done (1 tool')).toBe(5);

    // Full-topology snapshot — locks the 1-child-plus-summary shape.
    expect(stripped).toMatchInlineSnapshot(`
      "◉ → Agent(connector-tester) [subagent]
      │ ├─ ● Read("data.ts") — ✓ ok
      │ ╰─ Done (1 tool · 0.8s)"
    `);
  });
});

// ─── assignConnectors property tests (checkpoint 2b) ─────────────────────────
//
// These property tests cover the tree-connector contract (desired-state doc §4):
//   - For any non-empty list: exactly one item has '└ ' connector, it is last.
//   - For any list: no item after a '└ ' item exists.
//   - Empty input → empty output (no crash).
//   - Overflow synthetic as last item → gets '└ '.
//   - ResultSummary synthetic as last item → gets '└ '.

describe('assignConnectors — property tests', () => {
  // Import the pure functions for direct unit testing.
  // Tool-lane-render exports them for testability.
  let assignConnectors: typeof import('./tool-lane-render.js').assignConnectors;
  let addOverflowSynthetic: typeof import('./tool-lane-render.js').addOverflowSynthetic;
  let addResultSummarySynthetic: typeof import('./tool-lane-render.js').addResultSummarySynthetic;

  beforeEach(async () => {
    const mod = await import('./tool-lane-render.js');
    assignConnectors = mod.assignConnectors;
    addOverflowSynthetic = mod.addOverflowSynthetic;
    addResultSummarySynthetic = mod.addResultSummarySynthetic;
  });

  function makeToolSibling(i: number): import('./tool-lane-render.js').RenderableSibling {
    return {
      kind: 'tool' as const,
      toolUseId: `t${i}`,
      toolName: 'Read',
      toolInput: `("file${i}.ts")`,
      prefix: `● Read("file${i}.ts")`,
    };
  }

  it('empty input → empty output (no crash)', () => {
    expect(assignConnectors([])).toEqual([]);
  });

  it('single item → connector is ╰─ ', () => {
    const result = assignConnectors([makeToolSibling(0)]);
    expect(result).toHaveLength(1);
    expect(result[0]!.connector).toBe('╰─ ');
  });

  it('for any non-empty list: exactly one item has ╰─  connector and it is last', () => {
    // Property-test loop: lengths 1–30
    for (let n = 1; n <= 30; n++) {
      const siblings = Array.from({ length: n }, (_, i) => makeToolSibling(i));
      const connected = assignConnectors(siblings);

      const lastConnectors = connected.filter((c) => c.connector === '╰─ ');
      expect(lastConnectors).toHaveLength(1);
      expect(connected[connected.length - 1]!.connector).toBe('╰─ ');

      // All prior items have '├─ '
      for (let i = 0; i < connected.length - 1; i++) {
        expect(connected[i]!.connector).toBe('├─ ');
      }
    }
  });

  it('no item after a ╰─  item exists', () => {
    for (let n = 1; n <= 20; n++) {
      const siblings = Array.from({ length: n }, (_, i) => makeToolSibling(i));
      const connected = assignConnectors(siblings);
      const lastIdx = connected.findIndex((c) => c.connector === '╰─ ');
      expect(lastIdx).toBe(connected.length - 1);
    }
  });

  it('overflow synthetic as FIRST item → gets ├─ ; last visible group gets ╰─ ', () => {
    const siblings = Array.from({ length: 5 }, (_, i) => makeToolSibling(i));
    // Recency window (maxVisible=3): leading overflow (older head) + most-recent 3.
    const withOverflow = addOverflowSynthetic(siblings, 3);
    const connected = assignConnectors(withOverflow);

    // Overflow now LEADS the list (summarizes the older head) → MID connector.
    const firstItem = connected[0]!;
    expect(firstItem.sibling.kind).toBe('overflow');
    expect(firstItem.connector).toBe('├─ ');

    // A real visible group is now last → keeps the LAST connector.
    const lastItem = connected[connected.length - 1]!;
    expect(lastItem.sibling.kind).toBe('tool');
    expect(lastItem.connector).toBe('╰─ ');
  });

  it('addOverflowSynthetic keeps the most-recent maxVisible (tail) and leads with overflow', () => {
    const siblings = Array.from({ length: 5 }, (_, i) => makeToolSibling(i)); // t0..t4
    const result = addOverflowSynthetic(siblings, 3);
    expect(result).toHaveLength(4); // leading overflow + 3 visible
    expect(result[0]!.kind).toBe('overflow');
    // Visible tail = the 3 MOST-RECENT siblings, preserving dispatch order.
    const visibleIds = result
      .slice(1)
      .map((s) => (s.kind === 'tool' ? s.toolUseId : undefined));
    expect(visibleIds).toEqual(['t2', 't3', 't4']);
    // The leading overflow summarizes the older head (t0, t1).
    const overflow = result[0]!;
    expect(overflow.kind === 'overflow' && overflow.count).toBe(2);
  });

  it('resultSummary synthetic as last item → gets ╰─  connector', () => {
    const siblings = Array.from({ length: 3 }, (_, i) => makeToolSibling(i));
    const withSummary = addResultSummarySynthetic(siblings, 'Done (3 tools · 1.5s)');
    const connected = assignConnectors(withSummary);

    const lastItem = connected[connected.length - 1]!;
    expect(lastItem.sibling.kind).toBe('resultSummary');
    expect(lastItem.connector).toBe('╰─ ');
  });

  it('overflow (first) gets ├─ , resultSummary (last) gets ╰─ ', () => {
    const siblings = Array.from({ length: 5 }, (_, i) => makeToolSibling(i));
    const withOverflow = addOverflowSynthetic(siblings, 3);
    const withSummary = addResultSummarySynthetic(withOverflow, 'Done (5 tools · 2.0s)');
    const connected = assignConnectors(withSummary);

    // Overflow now LEADS the list (older-head summary) → MID connector.
    const overflowItem = connected[0]!;
    expect(overflowItem.sibling.kind).toBe('overflow');
    expect(overflowItem.connector).toBe('├─ ');

    // resultSummary remains the appended LAST sibling.
    const summaryItem = connected[connected.length - 1]!;
    expect(summaryItem.sibling.kind).toBe('resultSummary');
    expect(summaryItem.connector).toBe('╰─ ');
  });

  it('addResultSummarySynthetic is no-op when summary is undefined', () => {
    const siblings = Array.from({ length: 3 }, (_, i) => makeToolSibling(i));
    const result = addResultSummarySynthetic(siblings, undefined);
    expect(result).toHaveLength(3);
    expect(result).toStrictEqual(siblings);
  });

  it('addOverflowSynthetic is no-op when count ≤ maxVisible', () => {
    const siblings = Array.from({ length: 3 }, (_, i) => makeToolSibling(i));
    const result = addOverflowSynthetic(siblings, 3);
    expect(result).toHaveLength(3);
    const result2 = addOverflowSynthetic(siblings, 5);
    expect(result2).toHaveLength(3);
  });
});

// ─── formatCategoricalOverflow — label-aware and pluralization ────────────────
//
// New tests for the dispatch-label overflow path and tool-name pluralization
// introduced in the fix/dispatch-overflow-labels change.

describe('formatCategoricalOverflow — label-aware dispatch overflow', () => {
  it('6 Agent dispatches with distinct labels → overflow shows label list', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'skill', '(compose)', undefined);
    // 6 Agent children with distinct labels pr1…pr6
    for (let i = 1; i <= 6; i++) {
      lane.addStartWithAgentContext(`agent-${i}`, 'Agent', `(pr${i})`, 'parent');
      lane.addResult(`agent-${i}`, makeResult('done'));
    }
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    // Recency window: MAX_VISIBLE_CHILDREN = 3 keeps the MOST-RECENT pr4–pr6
    // visible; the older pr1–pr3 collapse into the leading overflow line.
    // Overflow line: … +3 more: pr1, pr2, pr3
    expect(overlay).toMatch(/… \+3 more: pr1, pr2, pr3/);
    // The label-list must NOT collapse to a categorical bucket
    expect(overlay).not.toMatch(/\+3 \(/);
  });

  it('4 distinct leaf tools → categorical overflow shows pluralized names', () => {
    // Recency window keeps the MOST-RECENT 3 visible and collapses the OLDER
    // head, so the items we want hidden (the 2 Writes) must be dispatched
    // FIRST. Order: Write, Write (oldest), then Read, Bash, Grep (newest 3).
    // Leaf threshold = 3 → 2 Writes don't group; they appear as 2 siblings,
    // both in the older head. 5 siblings, MAX_VISIBLE=3 → 3 visible, 2 hidden.
    // Hidden: [Write1, Write2]. formatCategoricalOverflow({Write, Write}) →
    // allDispatch=false → categorical → "… +2 (2 Writes)" (Write ends in 'e'
    // not 's' → pluralizes to 'Writes').
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'Agent', '(tester)', undefined);
    lane.addStartWithAgentContext('w1', 'Write', '("x.ts")', 'parent');
    lane.addResult('w1', makeResult('ok'));
    lane.addStartWithAgentContext('w2', 'Write', '("y.ts")', 'parent');
    lane.addResult('w2', makeResult('ok'));
    lane.addStartWithAgentContext('r1', 'Read', '("a.ts")', 'parent');
    lane.addResult('r1', makeResult('ok'));
    lane.addStartWithAgentContext('b1', 'Bash', '("ls")', 'parent');
    lane.addResult('b1', makeResult('ok'));
    lane.addStartWithAgentContext('g1', 'Grep', '("TODO")', 'parent');
    lane.addResult('g1', makeResult('ok'));
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    // Hidden (older head): Write ×2 → "… +2 (2 Writes)"
    expect(overlay).toMatch(/… \+2 \(2 Writes\)/);
    // Must not use the label-aware path (Write is not dispatch-class)
    expect(overlay).not.toMatch(/more:/);
  });

  it('mixed dispatch + leaf hidden → categorical fallback (heterogeneous)', () => {
    // A mixed (1 Agent + 1 bash) HIDDEN slice → allDispatch=false → categorical.
    // Recency window collapses the OLDER head, so the mixed pair must be
    // dispatched FIRST: Agent(pr1), bash (oldest, → hidden), then Read, Bash,
    // Grep (newest 3, → visible). 5 siblings, MAX_VISIBLE=3 → 2 hidden.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'Agent', '(outer)', undefined);
    // Older head (becomes hidden): 1 Agent + 1 bash → heterogeneous.
    lane.addStartWithAgentContext('inner-agent', 'Agent', '(pr1)', 'parent');
    lane.addResult('inner-agent', makeResult('done'));
    lane.addStartWithAgentContext('b2', 'bash', '("cmd")', 'parent');
    lane.addResult('b2', makeResult('ok'));
    // Most-recent 3 (stay visible):
    lane.addStartWithAgentContext('r1', 'Read', '("a.ts")', 'parent');
    lane.addResult('r1', makeResult('ok'));
    lane.addStartWithAgentContext('b1', 'Bash', '("ls")', 'parent');
    lane.addResult('b1', makeResult('ok'));
    lane.addStartWithAgentContext('g1', 'Grep', '("TODO")', 'parent');
    lane.addResult('g1', makeResult('ok'));
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    // allDispatch=false → categorical. Should NOT be label-aware.
    expect(overlay).not.toMatch(/more:/);
    // Should show categorical with counts: 1 Agent + 1 bash = 2 total
    expect(overlay).toMatch(/… \+2 \(/);
  });

  it('dispatch overflow with >LABEL_LIST_CAP labels → inline +N suffix', () => {
    // 8 distinct Agent labels → visible 3, hidden 5 (all dispatch).
    // LABEL_LIST_CAP=5, so all 5 shown with no (+N) suffix.
    // Use 9 total → 6 hidden > 5 cap → shows 5 + (+1).
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'skill', '(big-wave)', undefined);
    for (let i = 1; i <= 9; i++) {
      lane.addStartWithAgentContext(`agent-${i}`, 'Agent', `(pr${i})`, 'parent');
      lane.addResult(`agent-${i}`, makeResult('done'));
    }
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    // 9 children, MAX_VISIBLE=3 keeps newest pr7–pr9 visible; older pr1–pr6
    // collapse (hidden=6). LABEL_LIST_CAP=5 → shows pr1–pr5 + (+1) for pr6.
    expect(overlay).toMatch(/… \+6 more: pr1, pr2, pr3, pr4, pr5 \(\+1\)/);
  });

  it('getGroupKey invariant: different Agent labels do NOT merge (existing invariant preserved)', () => {
    // This test mirrors the existing "different Agent labels do NOT merge" test
    // to confirm our new path doesn't disturb getGroupKey's dispatch-key behavior.
    const lane = new ToolLane();
    lane.addStart('skill-1', 'skill', '(review)');
    for (let i = 1; i <= 3; i++) {
      lane.addStartWithAgentContext(`a-${i}`, 'Agent', '(skill-review)', 'skill-1');
      lane.addResult(`a-${i}`, makeResult('done'));
    }
    for (let i = 1; i <= 2; i++) {
      lane.addStartWithAgentContext(`b-${i}`, 'Agent', '(critic-paranoid)', 'skill-1');
      lane.addResult(`b-${i}`, makeResult('done'));
    }
    lane.addResult('skill-1', makeResult('done'));

    const overlay = lane.getOverlay();
    // Different labels → different group keys → two separate grouped rows.
    expect(overlay).toContain('(skill-review)');
    expect(overlay).toContain('(critic-paranoid)');
    expect(overlay).toContain('×3');
    expect(overlay).toContain('×2');
  });

  // ─── Regression: pre-merge placeholders must not leak as labels ─────────
  //
  // Between the early `tool.use.start` fire (translate.ts emits ' …') and
  // the subagent's first context-emit (which triggers `mergeAgentLabel` and
  // promotes toolInput to `(label)`), dispatch entries carry placeholder
  // toolInput values. The label-aware overflow path MUST fall back to the
  // categorical bucket in this window — otherwise the rendered output
  // becomes `… +N more: …, …, …` instead of identifying the dispatch type.
  //
  // The reachable scenario: mixed merged + unmerged dispatches in the hidden
  // slice. The unmerged entry's toolName (`agent`/`skill`/`compose`) differs
  // from the merged entry's toolName (`Agent`) — heterogeneous → categorical.
  it('hidden slice mixing merged Agent + unmerged agent → categorical fallback', () => {
    // 5 agent dispatches, 4 merged + 1 still pre-merge. Recency window keeps the
    // newest 3 visible; the older head (oldest 2) collapses. Dispatch the
    // pre-merge 'agent' FIRST so the hidden slice mixes it with a merged
    // 'Agent' → different toolNames → heterogeneous → categorical.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'skill', '(compose)', undefined);
    // Pre-merge entry — literal placeholder from translate.ts (oldest → hidden).
    lane.addStartWithAgentContext('agent-5', 'agent', ' …', 'parent');
    for (let i = 1; i <= 4; i++) {
      lane.addStartWithAgentContext(`agent-${i}`, 'Agent', `(pr${i})`, 'parent');
    }

    const overlay = stripAnsi(lane.getOverlay());
    // Must NOT render ellipsis or empty strings as labels.
    expect(overlay).not.toMatch(/more: …/);
    expect(overlay).not.toMatch(/more:.*, …/);
    // Must fall back to categorical (heterogeneous toolNames: Agent + agent).
    expect(overlay).toMatch(/… \+2 \(/);
  });

  it('hidden grouped dispatch with placeholder label (translate.ts ellipsis) → categorical fallback', () => {
    // The other reachable scenario: a fully pre-merge group lands in the
    // hidden slice as a single GroupedSibling row. 4 leaf siblings (visible)
    // + 1 dispatch group (hidden) — group's `label` is the shared placeholder
    // ' …', which must NOT be emitted as a label.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'skill', '(compose)', undefined);
    // 2 unmerged agents with shared ' …' toolInput → collapse to one group
    // (GROUP_THRESHOLD_DISPATCH=2). Dispatch FIRST so the group lands in the
    // collapsed older head; the 3 newest leaf entries stay visible.
    for (let i = 1; i <= 2; i++) {
      lane.addStartWithAgentContext(`agent-${i}`, 'agent', ' …', 'parent');
    }
    // 3 visible leaf entries (Read/Bash/Grep — distinct names, no grouping).
    lane.addStartWithAgentContext('r1', 'Read', '("a.ts")', 'parent');
    lane.addResult('r1', makeResult('ok'));
    lane.addStartWithAgentContext('b1', 'Bash', '("ls")', 'parent');
    lane.addResult('b1', makeResult('ok'));
    lane.addStartWithAgentContext('g1', 'Grep', '("TODO")', 'parent');
    lane.addResult('g1', makeResult('ok'));

    const overlay = stripAnsi(lane.getOverlay());
    // Must NOT render ' …' as a label.
    expect(overlay).not.toMatch(/more: …/);
    // Must fall back to categorical: `… +2 (2 agents)`.
    expect(overlay).toMatch(/… \+2 \(2 agents\)/);
  });

  // ─── Regression: heterogeneous dispatch must not blend label types ──────
  //
  // When the hidden slice mixes two distinct dispatch toolNames (e.g.
  // `Agent` + `skill`), the label-aware path would otherwise emit a flat
  // label list with no indication of which item was which type. Force
  // the categorical fallback so the user sees `1 Agent, 2 skills`.
  it('heterogeneous dispatch (Agent + skill) hidden → categorical fallback', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'compose', '(wave)', undefined);
    // Hidden (older head): 1 Agent + 2 skills — all NESTING_TOOLS, heterogeneous.
    // Dispatch FIRST so they collapse; the 3 newest leaf tools stay visible.
    lane.addStartWithAgentContext('a1', 'Agent', '(pr1)', 'parent');
    lane.addResult('a1', makeResult('done'));
    lane.addStartWithAgentContext('s1', 'skill', '(forge)', 'parent');
    lane.addResult('s1', makeResult('done'));
    lane.addStartWithAgentContext('s2', 'skill', '(resolve)', 'parent');
    lane.addResult('s2', makeResult('done'));
    // 3 most-recent Read/Bash/Grep stay visible.
    lane.addStartWithAgentContext('r1', 'Read', '("a.ts")', 'parent');
    lane.addResult('r1', makeResult('ok'));
    lane.addStartWithAgentContext('b1', 'Bash', '("ls")', 'parent');
    lane.addResult('b1', makeResult('ok'));
    lane.addStartWithAgentContext('g1', 'Grep', '("TODO")', 'parent');
    lane.addResult('g1', makeResult('ok'));
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    // MUST NOT mix Agent + skill labels into one list — the user wouldn't
    // know which type each label belonged to.
    expect(overlay).not.toMatch(/more:/);
    // Must fall back to categorical with type counts.
    expect(overlay).toMatch(/… \+3 \(/);
    expect(overlay).toMatch(/1 Agent/);
    expect(overlay).toMatch(/2 skills/);
  });

  // ─── Regression: count/label honesty when groups land in hidden slice ────
  //
  // A GroupedSibling with `entries.length > 1` is ONE row but represents
  // N entries. Pre-fix the label-aware path pushed one label and bumped
  // `total` by N, producing `… +N more: label` — claims N hidden, lists 1.
  // Post-fix: the row carries a `×N` suffix so the numbers reconcile.
  it('hidden grouped dispatch (×N) → label rendered with ×N suffix; count matches total', () => {
    // 3 visible leaf entries + 4 same-label Agent siblings → group of 4 in hidden.
    // Pre-fix output: `… +4 more: pr1` (4 vs. 1 mismatch).
    // Post-fix output: `… +4 more: pr1 ×4` (entries explicit).
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'skill', '(compose)', undefined);
    // Same-label Agents collapse to one group (GROUP_THRESHOLD_DISPATCH=2).
    // Dispatch FIRST so the group lands in the collapsed older head; the 3
    // newest leaf tools stay visible.
    for (let i = 1; i <= 4; i++) {
      lane.addStartWithAgentContext(`a-${i}`, 'Agent', '(pr1)', 'parent');
      lane.addResult(`a-${i}`, makeResult('done'));
    }
    lane.addStartWithAgentContext('r1', 'Read', '("a.ts")', 'parent');
    lane.addResult('r1', makeResult('ok'));
    lane.addStartWithAgentContext('b1', 'Bash', '("ls")', 'parent');
    lane.addResult('b1', makeResult('ok'));
    lane.addStartWithAgentContext('g1', 'Grep', '("TODO")', 'parent');
    lane.addResult('g1', makeResult('ok'));
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toMatch(/… \+4 more: pr1 ×4/);
    // Negative: must NOT emit the bare label without the count suffix.
    expect(overlay).not.toMatch(/… \+4 more: pr1$/m);
    expect(overlay).not.toMatch(/… \+4 more: pr1,/);
  });

  it('hidden mix of groups + individuals → entry count reconciles across rows', () => {
    // Hidden slice: Group(pr1, ×3) + Entry(pr2) + Entry(pr3) → 3 rows, 5 entries.
    // Output: `… +5 more: pr1 ×3, pr2, pr3` — visible-entry sum (3+1+1)
    // equals leading +5 with no trailing (+M).
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'skill', '(compose)', undefined);
    // The agent dispatches are the intended hidden slice — dispatch FIRST so
    // they collapse into the older head; the 3 newest leaf tools stay visible.
    // 3 same-label Agents → group of 3.
    for (let i = 1; i <= 3; i++) {
      lane.addStartWithAgentContext(`a-${i}`, 'Agent', '(pr1)', 'parent');
      lane.addResult(`a-${i}`, makeResult('done'));
    }
    // 2 distinct-label Agents — appear individually.
    lane.addStartWithAgentContext('a-x', 'Agent', '(pr2)', 'parent');
    lane.addResult('a-x', makeResult('done'));
    lane.addStartWithAgentContext('a-y', 'Agent', '(pr3)', 'parent');
    lane.addResult('a-y', makeResult('done'));
    lane.addStartWithAgentContext('r1', 'Read', '("a.ts")', 'parent');
    lane.addResult('r1', makeResult('ok'));
    lane.addStartWithAgentContext('b1', 'Bash', '("ls")', 'parent');
    lane.addResult('b1', makeResult('ok'));
    lane.addStartWithAgentContext('g1', 'Grep', '("TODO")', 'parent');
    lane.addResult('g1', makeResult('ok'));
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toMatch(/… \+5 more: pr1 ×3, pr2, pr3(?!\s*\(\+)/);
  });

  it('hidden labels overflow LABEL_LIST_CAP with a group → (+M) counts ENTRIES, not rows', () => {
    // Hidden slice: Group(pr1, ×3) + 5 distinct individuals (pr2..pr6) →
    // 6 rows, 8 entries. LABEL_LIST_CAP=5 → visible rows = first 5.
    // visible entry-sum = 3+1+1+1+1 = 7. (+M) = 8 - 7 = 1.
    // Output: `… +8 more: pr1 ×3, pr2, pr3, pr4, pr5 (+1)`.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'skill', '(compose)', undefined);
    // The agent dispatches are the intended hidden slice — dispatch FIRST so
    // they collapse into the older head; the 3 newest leaf tools stay visible.
    // 3 same-label Agents → group of 3.
    for (let i = 1; i <= 3; i++) {
      lane.addStartWithAgentContext(`a-${i}`, 'Agent', '(pr1)', 'parent');
      lane.addResult(`a-${i}`, makeResult('done'));
    }
    // 5 distinct labels — appear individually.
    for (let i = 2; i <= 6; i++) {
      lane.addStartWithAgentContext(`a-${i}-uniq`, 'Agent', `(pr${i})`, 'parent');
      lane.addResult(`a-${i}-uniq`, makeResult('done'));
    }
    lane.addStartWithAgentContext('r1', 'Read', '("a.ts")', 'parent');
    lane.addResult('r1', makeResult('ok'));
    lane.addStartWithAgentContext('b1', 'Bash', '("ls")', 'parent');
    lane.addResult('b1', makeResult('ok'));
    lane.addStartWithAgentContext('g1', 'Grep', '("TODO")', 'parent');
    lane.addResult('g1', makeResult('ok'));
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toMatch(/… \+8 more: pr1 ×3, pr2, pr3, pr4, pr5 \(\+1\)/);
  });

  // ─── M1: terminal-injection sanitization ───────────────────────────────
  //
  // Labels are derived from LLM-generated tool input and may contain CR,
  // LF, or ANSI ESC sequences. These would otherwise corrupt the rendered
  // overflow line (line breaks splitting the row, ESC repositioning the
  // cursor). Verify defensive sanitization strips them.
  it('label-aware overflow strips CR/LF/ESC control characters from labels', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'skill', '(compose)', undefined);
    // 6 distinct Agent labels — hidden (older head) = pr4, pr5, pr6 (3 rows).
    // Recency window keeps the newest 3 visible, so dispatch the injected
    // labels FIRST so they land in the collapsed (and sanitized) overflow line.
    // pr4 carries CR+LF; pr5 carries ANSI CSI sequence; pr6 is clean.
    lane.addStartWithAgentContext('a-4', 'Agent', '(pr4\r\nINJECTED)', 'parent');
    lane.addResult('a-4', makeResult('done'));
    lane.addStartWithAgentContext('a-5', 'Agent', '(pr5\x1b[31mRED)', 'parent');
    lane.addResult('a-5', makeResult('done'));
    lane.addStartWithAgentContext('a-6', 'Agent', '(pr6)', 'parent');
    lane.addResult('a-6', makeResult('done'));
    lane.addStartWithAgentContext('a-1', 'Agent', '(pr1)', 'parent');
    lane.addResult('a-1', makeResult('done'));
    lane.addStartWithAgentContext('a-2', 'Agent', '(pr2)', 'parent');
    lane.addResult('a-2', makeResult('done'));
    lane.addStartWithAgentContext('a-3', 'Agent', '(pr3)', 'parent');
    lane.addResult('a-3', makeResult('done'));
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    // Find the overflow line specifically.
    const overflowLine = overlay.split('\n').find((line) => /\+3 more:/.test(line)) ?? '';
    // Sanitization replaces control chars with space → contiguous tokens
    // become space-separated: `pr4 INJECTED`, `pr5 [31mRED`.
    expect(overflowLine).toContain('pr4 INJECTED');
    expect(overflowLine).toContain('pr6');
    // No literal CR/LF/ESC must remain in the rendered line.
    expect(overflowLine).not.toMatch(/[\r\n\x1b]/);
    // The sanitized line must still be a single visual row.
    const overflowLines = overlay.split('\n').filter((line) => /\+3 more:/.test(line));
    expect(overflowLines).toHaveLength(1);
  });

  // ─── M2: per-label length truncation ───────────────────────────────────
  //
  // A multi-KB toolInput must not produce a multi-KB overflow line.
  // LABEL_DISPLAY_MAX caps each label at 60 display chars with an ellipsis.
  it('label-aware overflow truncates a runaway label to LABEL_DISPLAY_MAX with ellipsis', () => {
    const longLabel = 'x'.repeat(500);
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'skill', '(compose)', undefined);
    // 3 visible distinct dispatches + 1 hidden with the runaway label.
    // Hidden has 1 item but the homogeneity check needs all same toolName →
    // make all 4 Agents with distinct labels so pr4 (long one) goes hidden.
    lane.addStartWithAgentContext('a-1', 'Agent', '(pr1)', 'parent');
    lane.addResult('a-1', makeResult('done'));
    lane.addStartWithAgentContext('a-2', 'Agent', '(pr2)', 'parent');
    lane.addResult('a-2', makeResult('done'));
    lane.addStartWithAgentContext('a-3', 'Agent', '(pr3)', 'parent');
    lane.addResult('a-3', makeResult('done'));
    lane.addStartWithAgentContext('a-4', 'Agent', `(${longLabel})`, 'parent');
    lane.addResult('a-4', makeResult('done'));
    lane.addResult('parent', makeResult('done'));

    const overlay = stripAnsi(lane.getOverlay());
    const overflowLine = overlay.split('\n').find((line) => /\+1 more:/.test(line)) ?? '';
    // Truncated label must end with ellipsis and be no longer than 60 chars
    // (LABEL_DISPLAY_MAX), counting the trailing ellipsis as 1 char.
    expect(overflowLine).toContain('…');
    // Extract the label portion after `more: `.
    const labelPortion = overflowLine.split('more: ')[1] ?? '';
    expect(labelPortion.length).toBeLessThanOrEqual(60);
    // The original 500-char label must NOT appear in full.
    expect(overflowLine).not.toContain('x'.repeat(100));
  });
});

// ─── Snapshot pins — visual baseline for tool-lane-render.ts outputs ──────────
//
// These tests capture the current rendered output as baseline snapshots.
// They must pass at the start of EVERY checkpoint and at PR merge.
// They pin the visual shape so refactoring does not accidentally change
// unrelated output. Run once with current code to capture baselines;
// subsequent runs verify no regression.
//
// Snapshots complement (not replace) the existing string-content assertions above.

describe('Snapshot pins — tool-lane-render.ts representative outputs', () => {
  // Scenario 1: single tool entry, completed cleanly
  it('scenario 1 — single completed tool entry', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('t1', 'Read', '("README.md")', undefined);
    lane.addResult('t1', makeResult('42 lines'));
    expect(stripAnsi(lane.flush().join('\n'))).toMatchSnapshot();
  });

  // Scenario 2: multi-tool entry (3 tools), all completed
  it('scenario 2 — multi-tool entry (3 tools, all completed)', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('t1', 'Read', '("a.ts")', undefined);
    lane.addResult('t1', makeResult('10 lines'));
    lane.addStartWithAgentContext('t2', 'Bash', '("ls -la")', undefined);
    lane.addResult('t2', makeResult('5 lines'));
    lane.addStartWithAgentContext('t3', 'Glob', '("**/*.ts")', undefined);
    lane.addResult('t3', makeResult('23 paths'));
    expect(stripAnsi(lane.flush().join('\n'))).toMatchSnapshot();
  });

  // Scenario 3: tool entry that errored (red result)
  it('scenario 3 — tool entry with error result', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('t1', 'Bash', '("npm test")', undefined);
    lane.addResult('t1', makeResult('Error: 3 tests failed', /* isError */ true));
    expect(stripAnsi(lane.flush().join('\n'))).toMatchSnapshot();
  });

  // Scenario 4: subagent entry with children, completed
  it('scenario 4 — subagent Agent entry with children, completed', () => {
    const lane = new ToolLane();
    const agentId = '__synth_agent_snap4';
    lane.addStartWithAgentContext(agentId, 'Agent', '(snap-researcher)', undefined);
    lane.addStartWithAgentContext('c1', 'Read', '("src/main.ts")', agentId);
    lane.addResult('c1', makeResult('88 lines'));
    lane.addStartWithAgentContext('c2', 'Grep', '("TODO")', agentId);
    lane.addResult('c2', makeResult('7 matches'));
    lane.setAgentResultSummary(agentId, 'Done (2 tools · 3.1s)');
    lane.addResult(agentId, {
      type: 'tool_result', toolUseId: 'synthetic', content: 'Done (2 tools · 3.1s)', isError: false,
    });
    expect(stripAnsi(lane.flush().join('\n'))).toMatchSnapshot();
  });

  // Scenario 5: subagent entry with overflow (>MAX_VISIBLE_CHILDREN children)
  it('scenario 5 — subagent Agent entry with overflow (4 children, MAX=3)', () => {
    const lane = new ToolLane();
    const agentId = '__synth_agent_snap5';
    lane.addStartWithAgentContext(agentId, 'Agent', '(snap-overflower)', undefined);
    // 4 different tool names to prevent grouping
    const names = ['Read', 'Bash', 'Grep', 'Glob'];
    for (let i = 0; i < 4; i++) {
      lane.addStartWithAgentContext(`sc${i}`, names[i]!, `("snap${i}.ts")`, agentId);
      lane.addResult(`sc${i}`, makeResult(`snap-result-${i}`));
    }
    lane.setAgentResultSummary(agentId, 'Done (4 tool calls · 4.0s)');
    lane.addResult(agentId, {
      type: 'tool_result', toolUseId: 'synthetic', content: 'Done (4 tool calls · 4.0s)', isError: false,
    });
    expect(stripAnsi(lane.flush().join('\n'))).toMatchSnapshot();
  });
});

// ─── flushSource (per-source flush) ─────────────────────────────────────────

describe('ToolLane.flushSource', () => {
  it('extracts only the targeted source and its children, leaving others intact', () => {
    const lane = new ToolLane();

    lane.addStartWithAgentContext('synth-A', 'Agent', '(research)', undefined);
    lane.addStartWithAgentContext('synth-B', 'Agent', '(review)', undefined);

    lane.addStartWithAgentContext('a-tool-1', 'Read', '("a.ts")', 'synth-A');
    lane.addStartWithAgentContext('b-tool-1', 'Bash', '("test")', 'synth-B');
    lane.addResult('a-tool-1', makeResult('a content'));
    lane.addResult('b-tool-1', makeResult('b content'));
    lane.setAgentResultSummary('synth-A', 'Done (1 tools · 100 tok)');
    lane.addResult('synth-A', makeResult('A done'));

    // Flush only source A
    const lines = lane.flushSource('synth-A');
    const joined = lines.join('\n');

    // Source A and its child should appear in the flushed output
    expect(joined).toContain('research');
    expect(joined).toContain('Read');

    // Source B should NOT appear in flushed output
    expect(joined).not.toContain('review');
    expect(joined).not.toContain('Bash');

    // Source B should still be in the lane (hasPending, getOverlay)
    expect(lane.hasPending()).toBe(true);
    const overlay = lane.getOverlay();
    expect(overlay).toContain('review');
    expect(overlay).toContain('Bash');
  });

  it('returns empty array when parentId does not exist', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('synth-A', 'Agent', '(research)', undefined);

    const lines = lane.flushSource('nonexistent');
    expect(lines).toEqual([]);
    // Original entry should be untouched
    expect(lane.hasPending()).toBe(true);
  });

  it('collects grandchildren recursively', () => {
    const lane = new ToolLane();

    lane.addStartWithAgentContext('synth-A', 'Agent', '(outer)', undefined);
    // Nested agent under synth-A
    lane.addStartWithAgentContext('nested-agent', 'Agent', '(inner)', 'synth-A');
    // Tool under the nested agent
    lane.addStartWithAgentContext('inner-tool', 'Read', '("deep.ts")', 'nested-agent');
    lane.addResult('inner-tool', makeResult('deep content'));
    lane.addResult('nested-agent', makeResult('inner done'));
    lane.setAgentResultSummary('synth-A', 'Done (2 tools)');
    lane.addResult('synth-A', makeResult('A done'));

    const lines = lane.flushSource('synth-A');
    const joined = lines.join('\n');

    // All three levels should appear
    expect(joined).toContain('outer');
    expect(joined).toContain('inner');
    expect(joined).toContain('Read');

    // Lane should be empty after flushing the only source
    expect(lane.hasPending()).toBe(false);
  });

  it('does not affect text entries from other sources', () => {
    const lane = new ToolLane();

    lane.addStartWithAgentContext('synth-A', 'Agent', '(research)', undefined);
    lane.addStartWithAgentContext('synth-B', 'Agent', '(review)', undefined);

    lane.addStartWithAgentContext('a-tool', 'Read', '("a.ts")', 'synth-A');
    lane.addResult('a-tool', makeResult('a content'));
    lane.setAgentResultSummary('synth-A', 'Done');
    lane.addResult('synth-A', makeResult('A done'));

    // Text child under B
    lane.upsertTextChild('b-text', 'synth-B', 'some narration text');

    lane.flushSource('synth-A');

    // B's text child should survive
    expect(lane.hasPending()).toBe(true);
  });
});

describe('ToolLane flush — heredoc bash prefix newline safety', () => {
  it('produces no line strings containing literal \\n when bash input is a heredoc', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext(
      'bash-heredoc-1',
      'bash',
      ' cd /repo && cat <<EOF\nline1\nline2\nEOF',
      undefined,
    );
    lane.addResult('bash-heredoc-1', makeResult('line1\nline2'));
    const lines = lane.flush();
    // Every emitted line must be free of embedded newlines.
    // A mid-string \n would indicate the prefix escaped sanitization
    // and the tree connector for a sibling row would be orphaned at column 0.
    expect(lines.every(l => !l.includes('\n'))).toBe(true);
  });
});

// H5: ToolLane.mergeAgentLabel — direct unit tests covering every guard
// and the success path. Without these, any guard could be silently
// removed without a test failure.
describe('ToolLane.mergeAgentLabel', () => {
  it('returns false for an unknown id', () => {
    const lane = new ToolLane();
    expect(lane.mergeAgentLabel('does-not-exist', 'researcher')).toBe(false);
  });

  it('returns false for a text entry (kind !== "tool")', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('parent', 'Agent', '(ctx)', undefined);
    lane.upsertTextChild('txt-1', 'parent', 'some text');
    expect(lane.mergeAgentLabel('txt-1', 'researcher')).toBe(false);
  });

  it('returns false when entry toolName is not in SUBAGENT_TOOLS (e.g. compose)', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('compose-1', 'compose', '(3 nodes)', undefined);
    expect(lane.mergeAgentLabel('compose-1', 'researcher')).toBe(false);
  });

  it('returns false when entry is already merged (toolName === "Agent")', () => {
    const lane = new ToolLane();
    // 'Agent' is itself in SUBAGENT_TOOLS, but the guard rejects it to
    // prevent grandchild-event overwrite of an already-merged label.
    lane.addStartWithAgentContext('agent-1', 'Agent', '(already)', undefined);
    expect(lane.mergeAgentLabel('agent-1', 'new-label')).toBe(false);
  });

  it('returns true and mutates toolName/toolInput/prefix for a valid "agent" entry', () => {
    const lane = new ToolLane();
    lane.addStart('dispatch-1', 'agent', '("analyze codebase")');

    const merged = lane.mergeAgentLabel('dispatch-1', 'pragmatist');
    expect(merged).toBe(true);

    // Overlay should reflect the new label
    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toContain('Agent');
    expect(overlay).toContain('pragmatist');
    expect(overlay).not.toContain('agent("analyze');
  });

  it('returns true for "Task" entries (other SUBAGENT_TOOLS member)', () => {
    const lane = new ToolLane();
    lane.addStart('task-1', 'Task', '("do thing")');
    expect(lane.mergeAgentLabel('task-1', 'reviewer')).toBe(true);
    expect(stripAnsi(lane.getOverlay())).toContain('Agent');
    expect(stripAnsi(lane.getOverlay())).toContain('reviewer');
  });

  it('preserves agentContext, agentIdStack relationships, and toolUseId key after merge', () => {
    const lane = new ToolLane();
    // Parent dispatch — 'agent' (in SUBAGENT_TOOLS) — addStart pushes onto agentIdStack
    lane.addStart('dispatch-1', 'agent', '(task)');
    // Child Read inherits 'dispatch-1' via the stack
    lane.addStart('child-1', 'Read', '("a.ts")');
    lane.addResult('child-1', makeResult('a contents'));

    lane.mergeAgentLabel('dispatch-1', 'researcher');

    // Flush: the child Read MUST still nest under the merged Agent entry.
    lane.addResult('dispatch-1', makeResult('dispatch done'));
    const lines = lane.flush();
    const joined = stripAnsi(lines.join('\n'));
    expect(joined).toContain('researcher');
    expect(joined).toContain('Read');
  });

  it('truncates the merged prefix to maxWidth when supplied', () => {
    const lane = new ToolLane();
    lane.addStart('dispatch-1', 'agent', '(x)');

    // Very narrow width — must force truncation in the resulting prefix
    const merged = lane.mergeAgentLabel('dispatch-1', 'a-very-long-agent-label-name', 20);
    expect(merged).toBe(true);

    const overlay = stripAnsi(lane.getOverlay());
    // displayWidth of the overlay line should not exceed the budget by much
    // (allowing for glyph + indent on top of the toolName/input slice).
    const firstLine = overlay.split('\n').find((l) => l.includes('Agent')) ?? '';
    expect(displayWidth(firstLine)).toBeLessThanOrEqual(20 + 8); // a small slack for prefix glyphs/indent
  });

  it('is idempotent on the no-op path: re-calling after merge returns false and does not re-mutate', () => {
    const lane = new ToolLane();
    lane.addStart('dispatch-1', 'agent', '(x)');
    expect(lane.mergeAgentLabel('dispatch-1', 'first')).toBe(true);
    const overlayAfterFirst = stripAnsi(lane.getOverlay());
    // Second call: already 'Agent', guard rejects it
    expect(lane.mergeAgentLabel('dispatch-1', 'second')).toBe(false);
    const overlayAfterSecond = stripAnsi(lane.getOverlay());
    expect(overlayAfterSecond).toBe(overlayAfterFirst);
    expect(overlayAfterSecond).toContain('first');
    expect(overlayAfterSecond).not.toContain('second');
  });
});

describe('ToolLane.addDiff — render-only diff sidechannel', () => {
  it('attaches a diff payload to an existing tool entry and renders it in flush', () => {
    const lane = new ToolLane();
    lane.addStart('tu_1', 'edit_file', '(foo.ts)');
    lane.addResult('tu_1', makeResult('Replaced 1 occurrence in foo.ts'));
    lane.addDiff('tu_1', {
      addedLines: 1,
      removedLines: 1,
      hunks: [{
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: [{ kind: '-', text: 'before' }, { kind: '+', text: 'after' }],
      }],
    });

    const flushed = stripAnsi(lane.flush().join('\n'));
    expect(flushed).toContain('Replaced 1 occurrence');
    expect(flushed).toContain('@@ -1,1 +1,1 @@');
    expect(flushed).toContain('- before');
    expect(flushed).toContain('+ after');
  });

  it('renders diff in the live overlay too (truncated)', () => {
    const lane = new ToolLane();
    lane.addStart('tu_2', 'edit_file', '(bar.ts)');
    lane.addResult('tu_2', makeResult('Replaced 1 occurrence in bar.ts'));
    lane.addDiff('tu_2', {
      addedLines: 1,
      removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
        lines: [{ kind: '+', text: 'new line' }],
      }],
    });

    const overlay = stripAnsi(lane.getOverlay());
    expect(overlay).toContain('+ new line');
  });

  it('no-ops silently when toolUseId does not exist (late-arriving diff after flush)', () => {
    const lane = new ToolLane();
    // No entry registered for this id.
    expect(() => {
      lane.addDiff('unknown_id', {
        addedLines: 0,
        removedLines: 0,
        hunks: [],
      });
    }).not.toThrow();
  });

  it('does NOT render diff when the tool result is an error', () => {
    // Error results render the error message; piling a diff on top would
    // be misleading (the write may have failed). Production renderer gates
    // diff display on `!entry.result.isError`.
    const lane = new ToolLane();
    lane.addStart('tu_err', 'edit_file', '(broken.ts)');
    lane.addResult('tu_err', makeResult('Permission denied', true));
    lane.addDiff('tu_err', {
      addedLines: 1,
      removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
        lines: [{ kind: '+', text: 'should not appear' }],
      }],
    });
    const flushed = stripAnsi(lane.flush().join('\n'));
    expect(flushed).toContain('Permission denied');
    expect(flushed).not.toContain('should not appear');
  });

  it('F3: emits per-entry diffs in flush when multiple same-tool entries are grouped', () => {
    // Two write_file calls in the same turn → renderGroupedRootTools emits
    // a `×2` header. Prior to the F3 fix, diffs were silently dropped in
    // the multi-entry branch. This test verifies that each entry's diff
    // block appears in the flushed output.
    const lane = new ToolLane();
    lane.addStart('tu_a', 'write_file', '(a.ts)');
    lane.addStart('tu_b', 'write_file', '(b.ts)');
    lane.addResult('tu_a', makeResult('Wrote 10 bytes to a.ts'));
    lane.addResult('tu_b', makeResult('Wrote 20 bytes to b.ts'));
    lane.addDiff('tu_a', {
      addedLines: 1,
      removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
        lines: [{ kind: '+', text: 'line from A' }],
      }],
    });
    lane.addDiff('tu_b', {
      addedLines: 1,
      removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
        lines: [{ kind: '+', text: 'line from B' }],
      }],
    });

    const flushed = stripAnsi(lane.flush().join('\n'));
    // Both diffs must appear in the scrollback output.
    expect(flushed).toContain('+ line from A');
    expect(flushed).toContain('+ line from B');
  });

  it('F3b: grouped write_file ×2 inserts a per-file divider so blocks do not fuse', () => {
    // Regression for audit RC-3: when N>1 grouped entries each contribute a
    // diff, the blocks must be visually separated by a labeled divider so a
    // reader can attribute hunks to specific files. Without the divider the
    // two diff blocks would render as one unbroken stream.
    const lane = new ToolLane();
    lane.addStart('tu_a', 'write_file', '(globals.css)');
    lane.addStart('tu_b', 'write_file', '(layout.tsx)');
    lane.addResult('tu_a', makeResult('Wrote 100 bytes to globals.css'));
    lane.addResult('tu_b', makeResult('Wrote 200 bytes to layout.tsx'));
    lane.addDiff('tu_a', {
      addedLines: 3, removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 3,
        lines: [
          { kind: '+', text: '@tailwind base;' },
          { kind: '+', text: '@tailwind components;' },
          { kind: '+', text: '@tailwind utilities;' },
        ],
      }],
    });
    lane.addDiff('tu_b', {
      addedLines: 2, removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 2,
        lines: [
          { kind: '+', text: 'import React from "react";' },
          { kind: '+', text: 'export default function Layout() {}' },
        ],
      }],
    });

    const flushed = stripAnsi(lane.flush().join('\n'));
    const cssBodyIdx = flushed.indexOf('@tailwind base;');
    const tsxBodyIdx = flushed.indexOf('import React');
    expect(cssBodyIdx).toBeGreaterThan(-1);
    expect(tsxBodyIdx).toBeGreaterThan(cssBodyIdx);

    // Between the two diff bodies there MUST be a labeled separator for the
    // second file. The exact divider glyph is implementation-defined; we
    // require only that (a) some kind of visual separator (── … ──) appears
    // AND (b) the second file's name appears in that span.
    const between = flushed.slice(cssBodyIdx, tsxBodyIdx);
    expect(between).toContain('layout.tsx');
    expect(between).toMatch(/──/);
  });

  it('F3b: a single contributing diff in a grouped entry does NOT add a divider', () => {
    // When only one entry actually has a diff (e.g. one write failed, one
    // succeeded), the lone diff should render without an unnecessary label
    // — the existing tool header already names the file.
    const lane = new ToolLane();
    lane.addStart('tu_ok', 'write_file', '(a.ts)');
    lane.addStart('tu_err', 'write_file', '(b.ts)');
    lane.addResult('tu_ok', makeResult('Wrote 10 bytes to a.ts'));
    lane.addResult('tu_err', makeResult('Permission denied', true));
    lane.addDiff('tu_ok', {
      addedLines: 1, removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
        lines: [{ kind: '+', text: 'only line' }],
      }],
    });

    const flushed = stripAnsi(lane.flush().join('\n'));
    expect(flushed).toContain('+ only line');
    // No divider should appear — there's only one diff to attribute.
    expect(flushed).not.toMatch(/── .* ──/);
  });

  it('ASCII mode — diffIndent in flush path uses spineClosed ("  ") for last-sibling and spine ("| ") for mid-sibling', () => {
    // Nit 3: verify that the diff-block path in renderFlushChildren uses
    // g.spineClosed / g.spine (from the glyph set) rather than hardcoded
    // strings. In ASCII mode spineClosed = '  ' (two spaces) and spine = '| '.
    //
    // Note: root-level tools (no Agent wrapper) go through renderGroupedRootTools
    // which uses a hardcoded '    ' indent — not the glyph set. The path that uses
    // g.spineClosed / g.spine is renderFlushChildren, so tools MUST be children of
    // an Agent entry to exercise this code path.
    const prevAscii = process.env['AGENT_AFK_ASCII'];
    process.env['AGENT_AFK_ASCII'] = '1';
    try {
      // Scenario A: single child under an Agent (is last-sibling in renderFlushChildren)
      // → diffIndent uses spineClosed ('  ') after the agent's spine column.
      const laneA = new ToolLane();
      const agentA = '__nit3_agent_a';
      laneA.addStartWithAgentContext(agentA, 'Agent', '(nit3-a)', undefined);
      laneA.addStartWithAgentContext('tu_last', 'edit_file', '(last.ts)', agentA);
      laneA.addResult('tu_last', makeResult('Replaced 1 occurrence in last.ts'));
      laneA.addDiff('tu_last', {
        addedLines: 1,
        removedLines: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: '+', text: 'added' }] }],
      });
      laneA.addResult(agentA, {
        type: 'tool_result', toolUseId: 'synthetic', content: 'done', isError: false,
      });
      const flushedA = stripAnsi(laneA.flush().join('\n'));
      // The hunk header must appear.
      expect(flushedA).toContain('@@ ');
      expect(flushedA).toContain('+ added');
      // For a last-sibling tool under an Agent, diffIndent = '| ' (agent spine) + spineClosed ('  ') + '  '.
      // In ASCII mode: '|   ' + '  ' = '|     ' — no second '| ' from this column.
      // Confirm box-drawing glyphs are absent (ASCII mode is active).
      expect(flushedA).not.toMatch(/[│├╰]/);

      // Scenario B: two tool siblings under an Agent — first (edit_file) is a
      // mid-sibling → diffIndent uses g.spine ('| ') for that child's column.
      const laneB = new ToolLane();
      const agentB = '__nit3_agent_b';
      laneB.addStartWithAgentContext(agentB, 'Agent', '(nit3-b)', undefined);
      laneB.addStartWithAgentContext('tu_mid', 'edit_file', '(mid.ts)', agentB);
      laneB.addStartWithAgentContext('tu_second', 'read_file', '(second.ts)', agentB);
      laneB.addResult('tu_mid', makeResult('Replaced 1 occurrence in mid.ts'));
      laneB.addResult('tu_second', makeResult('10 lines'));
      laneB.addDiff('tu_mid', {
        addedLines: 1,
        removedLines: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: '+', text: 'mid-added' }] }],
      });
      laneB.addResult(agentB, {
        type: 'tool_result', toolUseId: 'synthetic', content: 'done', isError: false,
      });
      const flushedB = stripAnsi(laneB.flush().join('\n'));
      // The hunk header and diff content must appear.
      expect(flushedB).toContain('@@ ');
      expect(flushedB).toContain('+ mid-added');
      // For a mid-sibling under an Agent, diffIndent = '| ' (agent spine) + g.spine ('| ') + '  '.
      // In ASCII mode this is '| | ' + '  ' = '| |   '. At least one line must start
      // with '| | ' confirming g.spine (not spineClosed) is used for the mid-sibling column.
      const spineLines = flushedB.split('\n').filter((l) => l.startsWith('| | '));
      expect(spineLines.length).toBeGreaterThan(0);
      // And box-drawing glyphs must be absent.
      expect(flushedB).not.toMatch(/[│├╰]/);
    } finally {
      if (prevAscii === undefined) {
        delete process.env['AGENT_AFK_ASCII'];
      } else {
        process.env['AGENT_AFK_ASCII'] = prevAscii;
      }
    }
  });
});

// ─── flushSource preserves nesting depth (subagent done inside a live skill) ──

/**
 * Regression: when a subagent finishes inside a still-in-flight parent
 * (a `skill` ToolEntry or any other NESTING_TOOLS entry), `flushSource`
 * commits the subagent's block to scrollback. Pre-fix that block landed at
 * the root indent ('  ' + prefix), visually unparenting the subagent the
 * moment it transitioned to Done — even though the live overlay still
 * showed sibling in-flight subagents correctly nested under the skill.
 *
 * Post-fix: `flushSource` walks the surviving `agentContext` chain in the
 * lane, counts how many ancestor tool entries are still alive, and prepends
 * `'  '.repeat(depth)` to every line of the committed block. The Done
 * scrollback now visually aligns with the live overlay.
 */
describe('ToolLane.flushSource — nesting-aware indent', () => {
  // Spine renderer encoding (post-0a3a841):
  //
  //   header row  = (live-ancestor spine slots) + '◉ ' + agent.prefix
  //   child row   = (live-ancestor spine slots) + '│ ' + connector + child.prefix
  //
  // Where each slot is 2 cells: `'│ '` for a live external ancestor
  // (extraDepth > 0), `'◉ '` for the turn-root marker, `'│ '` for the
  // Agent's own spine column under which children render. Pre-spine,
  // the encoding was `'  '.repeat(extraDepth + 1) + prefix` — pure
  // whitespace — so the original tests counted leading spaces. Spine
  // tests count topology slots instead.
  it('subagent finishing inside a live skill parent flushes at +1 spine slot', () => {
    const lane = new ToolLane();
    // Skill parent (still live — no result, nothing flushed yet)
    lane.addStartWithAgentContext('skill-call-1', 'skill', '(diagnose)', undefined);
    // Subagent under the skill — completes first
    lane.addStartWithAgentContext('synth-agent', 'Agent', '(critic-pragmatist)', 'skill-call-1');
    lane.addStartWithAgentContext('child-tool', 'Read', '("foo.ts")', 'synth-agent');
    lane.addResult('child-tool', makeResult('contents'));
    lane.setAgentResultSummary('synth-agent', 'Done (1 tools · 25s)');
    lane.addResult('synth-agent', makeResult('done'));

    const flushed = lane.flushSource('synth-agent');
    // With eager ancestor-header emission flushSource returns:
    //   [0] skill ancestor header (eagerly emitted)
    //   [1] the subagent block (Agent + children)
    expect(flushed).toHaveLength(2);

    // First element: the skill ancestor header at root depth — uses the
    // same spine-encoded head-row shape as formatAgentSummary: `◉ ` at col 0
    // (turn-root marker, 0 live-ancestor spine slots). Pre-fix this was
    // `'  '` (2 spaces) — the encoding mismatch with descendants below it
    // was the visible "broken topology spine" the renderer was emitting
    // (Bug A, scrollback path).
    const ancestorHeader = stripAnsi(flushed[0]!);
    expect(ancestorHeader.startsWith('◉ ')).toBe(true);
    expect(ancestorHeader).toContain('skill');
    expect(ancestorHeader).toContain('diagnose');

    // Second element: the Agent block itself, indented at +1 depth (4 spaces).
    const block = stripAnsi(flushed[1]!);
    const lines = block.split('\n');

    // Header at +1 spine depth: `'│ '` (live skill ancestor) + `'◉ '`
    // (turn-root) + prefix. Pre-spine, this was `'    '` (4 spaces).
    expect(lines[0]!.startsWith('│ ◉ ')).toBe(true);
    expect(lines[0]!).toContain('Agent');
    expect(lines[0]!).toContain('critic-pragmatist');
    // Negative assertion: header does NOT start with `'◉ '` at col 0
    // (the root-depth shape — would mean the ancestor spine was dropped).
    expect(/^◉ /.test(lines[0]!)).toBe(false);

    // Spine-seam fix (revised): the skill ancestor is still LIVE when the
    // subagent flushes — so its column stays OPEN (`'│ '`) in the committed
    // band. A live ancestor may emit further waves; closing it at flush time
    // bakes a false last-child guess and fragments col-0. The Agent's own
    // spine column `'│ '` also continues: `'│ │ ├─ '`. Head row above keeps
    // its incoming spine open (`'│ ◉ '`, PR #642 invariant preserved).
    const childLine = lines.find((l) => l.includes('Read'));
    expect(childLine).toBeDefined();
    expect(childLine!.startsWith('│ │ ├─ ')).toBe(true);

    // The skill parent should still be in the lane — only the subagent
    // and its tools were collected.
    expect(lane.hasPending()).toBe(true);
    expect(lane.hasEntry('skill-call-1')).toBe(true);
  });

  it('top-level subagent (no live parent) flushes at root spine depth (0 ancestors)', () => {
    const lane = new ToolLane();
    // Subagent registered at root with undefined agentContext
    lane.addStartWithAgentContext('synth-agent', 'Agent', '(research)', undefined);
    lane.addStartWithAgentContext('child-tool', 'Read', '("a.ts")', 'synth-agent');
    lane.addResult('child-tool', makeResult('contents'));
    lane.setAgentResultSummary('synth-agent', 'Done (1 tools)');
    lane.addResult('synth-agent', makeResult('done'));

    const flushed = lane.flushSource('synth-agent');
    const block = stripAnsi(flushed[0]!);
    const headerLine = block.split('\n')[0]!;

    // Root-level subagent: header starts with `'◉ '` at col 0 — no live
    // ancestor spine. Pre-spine, this was `'  '` (2 spaces).
    expect(headerLine.startsWith('◉ ')).toBe(true);
    // Negative: no leading spine slot would mean we accidentally double-indented.
    expect(/^│ /.test(headerLine)).toBe(false);
  });

  it('grandchild subagent finishing inside Agent inside skill flushes at +2 spine slots', () => {
    const lane = new ToolLane();
    // skill → outer Agent → inner Agent (all alive, only inner completes)
    lane.addStartWithAgentContext('skill-call-1', 'skill', '(devils-advocate)', undefined);
    lane.addStartWithAgentContext('outer-agent', 'Agent', '(devils-advocate)', 'skill-call-1');
    lane.addStartWithAgentContext('inner-agent', 'Agent', '(critic-pragmatist)', 'outer-agent');
    lane.addStartWithAgentContext('child-tool', 'Read', '("x.ts")', 'inner-agent');
    lane.addResult('child-tool', makeResult('contents'));
    lane.setAgentResultSummary('inner-agent', 'Done (1 tools)');
    lane.addResult('inner-agent', makeResult('done'));

    const flushed = lane.flushSource('inner-agent');
    // With eager ancestor-header emission:
    //   [0] skill ancestor header (depth 0 → ◉ at col 0)
    //   [1] outer-agent ancestor header (depth 1 → │ ◉)
    //   [2] inner-agent block (depth 2 → │ │ ◉ head)
    expect(flushed).toHaveLength(3);

    // [0] skill at root indent — spine-encoded head row, `◉ ` at col 0
    // (0 live-ancestor spine slots, turn-root marker). Pre-fix this was
    // `'  '` (2 spaces) — a naked-space indent that broke the spine column
    // running down through descendant rows.
    const skillHeader = stripAnsi(flushed[0]!);
    expect(skillHeader.startsWith('◉ ')).toBe(true);
    expect(skillHeader).toContain('skill');

    // [1] outer-agent at +1 depth — spine-encoded head row,
    // `│ ◉ ` (1 live-ancestor spine slot for skill, then turn-root for
    // outer-agent's own frame). Pre-fix this was `'    '` (4 spaces) —
    // floated above its children with no spine column tying it to either
    // the skill above or the inner-agent block below.
    const outerHeader = stripAnsi(flushed[1]!);
    expect(outerHeader.startsWith('│ ◉ ')).toBe(true);
    expect(outerHeader).toContain('devils-advocate');

    // [2] inner-agent block — its header is at +2 depth (6 spaces)
    const block = stripAnsi(flushed[2]!);
    const headerLine = block.split('\n')[0]!;

    // Two live ancestors → +2 spine slots prepended → `'│ │ ◉ '` head.
    // Pre-spine this was `'      '` (6 spaces).
    expect(headerLine.startsWith('│ │ ◉ ')).toBe(true);
    expect(headerLine).toContain('critic-pragmatist');

    // Both ancestors should survive the flush.
    expect(lane.hasEntry('skill-call-1')).toBe(true);
    expect(lane.hasEntry('outer-agent')).toBe(true);
  });

  it('issue #20: extraDepth≥2 (outer-skill → inner-skill → agent → child-tool) emits 2-unit head + 3-unit child rows', () => {
    // Coverage for the tool-lane-render flush-path formatters
    // (formatAgentHeader / formatAgentChildren, which prepend `extraDepth`
    // spine units) at extraDepth ≥ 2. The rest of the suite only exercised
    // extraDepth 0 and 1; a miscount at depth ≥2 would otherwise slip past CI.
    //
    // Topology is the issue's exact shape — an outer skill spawns an inner
    // skill, which spawns an Agent, which runs a leaf tool. flushSource is the
    // live REPL's settle-subtree-to-scrollback path; with both skill ancestors
    // still open, each LIVE ancestor prepends one spine unit, so the agent head
    // lands at two units (`│ │ ◉ `) and its children at three (`│ │ │ …`).
    const lane = new ToolLane();
    lane.addStartWithAgentContext('outer-skill', 'skill', '(devils-advocate)', undefined);
    lane.addStartWithAgentContext('inner-skill', 'skill', '(compete)', 'outer-skill');
    lane.addStartWithAgentContext('agent', 'Agent', '(critic-pragmatist)', 'inner-skill');
    lane.addStartWithAgentContext('child-tool', 'Read', '("x.ts")', 'agent');
    lane.addResult('child-tool', makeResult('1 line'));
    lane.setAgentResultSummary('agent', 'Done (1 tools)');
    lane.addResult('agent', makeResult('done'));

    // Two live ancestors → eager ancestor headers + agent block:
    //   [0] outer-skill header (depth 0 → ◉ at col 0)
    //   [1] inner-skill header (depth 1 → │ ◉)
    //   [2] agent block (depth 2 → │ │ ◉ head, │ │ │ … children)
    const flushed = lane.flushSource('agent');
    expect(flushed).toHaveLength(3);

    const block = stripAnsi(flushed[2]!);
    const rows = block.split('\n');
    const headRow = rows[0]!;
    const childRow = rows.find((r) => r.includes('Read'));

    // ask #3: agent head row = two leading spine units + agent glyph.
    expect(headRow.startsWith('│ │ ◉ '), `head row: ${JSON.stringify(headRow)}`).toBe(true);

    // ask #4: child-tool row = three leading spine units + branch connector.
    expect(childRow, `child row missing in block:\n${block}`).toBeDefined();
    expect(
      /^│ │ │ [├╰]─/.test(childRow!),
      `child row: ${JSON.stringify(childRow)}`,
    ).toBe(true);

    // Both skill ancestors survive the flush (only the agent subtree settled).
    expect(lane.hasEntry('outer-skill')).toBe(true);
    expect(lane.hasEntry('inner-skill')).toBe(true);
  });

  it('dangling agentContext (parent already gone from lane) renders at root', () => {
    const lane = new ToolLane();
    // Subagent claims agentContext pointing at an id that does NOT exist
    // in the lane (parent already flushed earlier, or registration was
    // out-of-order). The ancestor walk should treat this as 0 depth and
    // flush at root indent — defensive behavior, not crash, not double-indent.
    lane.addStartWithAgentContext('synth-agent', 'Agent', '(orphan)', 'nonexistent-parent');
    lane.addResult('synth-agent', makeResult('done'));

    const flushed = lane.flushSource('synth-agent');
    const block = stripAnsi(flushed[0]!);
    const headerLine = block.split('\n')[0]!;

    // Dangling reference → depth=0 → root spine shape (`'◉ '` at col 0).
    expect(headerLine.startsWith('◉ ')).toBe(true);
    expect(/^│ /.test(headerLine)).toBe(false);
  });

});

// ─── flush() after flushSource has drained the children ─────────────────────
//
// Regression test for the "subagents escape the skill frame at done-time" bug.
//
// With the eager-header feature: flushSource now eagerly emits the skill
// header on the FIRST child completion (marking skill.headerEmitted = true).
// Dispose-time flush() detects headerEmitted and emits only the closer
// (agentResultSummary if set, else nothing). The combined output (flushSource
// + flush) always contains the skill header exactly once, and the flat-leaf
// regression guard holds.
describe('ToolLane.flush — skill frame survives child flushSource drain', () => {
  it('skill header emitted eagerly by flushSource; flush() emits only the closer', () => {
    const lane = new ToolLane();
    // Skill parent + a subagent under it
    lane.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(critic-pragmatist)', 'skill-1');
    lane.addStartWithAgentContext('tool-1', 'Read', '("foo.ts")', 'agent-1');
    lane.addResult('tool-1', makeResult('contents'));
    lane.setAgentResultSummary('agent-1', 'Done (1 tools)');
    lane.addResult('agent-1', makeResult('agent done'));

    // Subagent completes mid-turn: flushSource removes agent-1 + tool-1 from
    // the lane AND eagerly emits the skill-1 header (headerEmitted = true).
    const midTurnLines = lane.flushSource('agent-1');
    const midTurnBlock = stripAnsi(midTurnLines.join('\n'));

    // The mid-turn output MUST contain the skill header.
    expect(midTurnBlock).toContain('skill');
    expect(midTurnBlock).toContain('(diagnose)');
    // Regression guard: skill header must be on its own line (frame
    // rendering), NOT as a flat leaf with ` — ✓ ` appended.
    const midTurnSkillLine = midTurnBlock.split('\n')
      .find((l) => l.includes('skill') && l.includes('diagnose'));
    expect(midTurnSkillLine).toBeDefined();
    expect(midTurnSkillLine).not.toMatch(/skill.*\(diagnose\).*— ✓/);

    // Skill resolves last
    lane.addResult('skill-1', makeResult('skill done'));

    // Dispose-time flush() sees headerEmitted = true and emits only the
    // closer (agentResultSummary if set, otherwise nothing). Since skill-1
    // has no agentResultSummary, flush() returns an empty array — the header
    // is already in scrollback from flushSource, no duplication.
    const disposeLines = lane.flush();
    const disposeBlock = stripAnsi(disposeLines.join('\n'));
    // flush() must NOT re-emit the skill header or flat-leaf downgrade it.
    expect(disposeBlock).not.toMatch(/skill.*\(diagnose\)/);
    expect(disposeBlock).not.toMatch(/skill.*\(diagnose\).*— ✓/);
  });

  it('skill renders frame header when its children list is empty (NESTING_TOOLS membership is sufficient)', () => {
    // Direct unit-level proof: a skill entry with zero children in the lane
    // (childMap.get(skillId) === undefined) still routes through
    // formatAgentSummary. Locks in the gate-clause removal.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(empty)', undefined);
    lane.setAgentResultSummary('skill-1', 'Done (0 tools)');
    lane.addResult('skill-1', makeResult('done'));

    const block = stripAnsi(lane.flush().join('\n'));

    // Frame contract: prefix is on its own line — no trailing outcome glued
    // after the parenthesized label like the grouped-tool leaf path emits.
    const skillLine = block.split('\n').find((l) => l.includes('skill') && l.includes('empty'));
    expect(skillLine).toBeDefined();
    expect(skillLine).not.toMatch(/skill.*\(empty\).*— ✓/);
  });
});

describe('ToolLane.flushSource — suppresses self-header when parentEntry.headerEmitted=true', () => {
  it('flushSource on a headerEmitted ancestor emits only its children, not a duplicate header', () => {
    // Topology: skill → devils-advocate → [paranoid (completes), architect (completes after)]
    // Sequence: paranoid completes first → flushSource sets devils-advocate.headerEmitted=true.
    // Later devils-advocate itself completes → flushSource(devils-advocate) MUST NOT re-emit
    // the devils-advocate header (it's already in scrollback from the earlier paranoid commit).
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(orchestrator)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(devils-advocate)', 'skill-1');
    lane.addStartWithAgentContext('paranoid-1', 'Agent', '(paranoid)', 'agent-1');
    lane.addStartWithAgentContext('p-tool-1', 'Read', '("foo.ts")', 'paranoid-1');
    lane.addResult('p-tool-1', makeResult('contents'));
    lane.setAgentResultSummary('paranoid-1', 'Done (1 tool)');
    lane.addResult('paranoid-1', makeResult('paranoid done'));

    // First commit: paranoid's flushSource emits skill + devils-advocate headers
    // (marking both headerEmitted=true) followed by paranoid's block.
    const firstCommit = stripAnsi(lane.flushSource('paranoid-1').join('\n'));
    // Count occurrences of '(devils-advocate)' in the first commit — exactly 1 (header).
    const firstAdvCount = (firstCommit.match(/\(devils-advocate\)/g) ?? []).length;
    expect(firstAdvCount).toBe(1);

    // Now devils-advocate itself completes — say there's an architect child but
    // we'll skip that for simplicity; the bug is about the agent-1 header.
    lane.setAgentResultSummary('agent-1', 'Done (1 child)');
    lane.addResult('agent-1', makeResult('agent done'));

    // Second commit: flushSource(agent-1). agent-1.headerEmitted is true (from
    // paranoid's earlier commit). The fix: emit ONLY the closer (resultSummary
    // child + tree connectors via formatAgentChildren), NOT the agent-1 header.
    const secondCommit = stripAnsi(lane.flushSource('agent-1').join('\n'));
    // Pre-fix: secondCommit contains 'Agent(devils-advocate)' (duplicate).
    // Post-fix: secondCommit does NOT contain a new devils-advocate header.
    const secondAdvCount = (secondCommit.match(/\(devils-advocate\)/g) ?? []).length;
    expect(secondAdvCount, `flushSource re-emitted headerEmitted header: ${JSON.stringify(secondCommit)}`).toBe(0);
    // But the agentResultSummary closer ('Done (1 child)') must appear.
    expect(secondCommit).toContain('Done (1 child)');
  });
});

// ─── Bug A (scrollback path): formatAgentHeader uses ◉ + dim │ spine ────────
//
// `formatAgentHeader` (called by flushSource for eager ancestor emission) was
// using `'  '.repeat(extraDepth) + '  ' + agent.prefix` — plain spaces —
// instead of the dim `│ ` spine glyphs + `◉` turn-root marker that
// `formatAgentSummary` produces for the same logical row. Result: eagerly-
// committed ancestor headers appeared visually disconnected from their children
// (no ◉ marker, no │ columns) while their children used the spine renderer.
describe('ToolLane.flushSource — formatAgentHeader emits ◉ + dim │ spine (Bug A scrollback)', () => {
  it('eagerly-emitted ancestor header uses ◉ turn-root marker (not plain spaces)', () => {
    const lane = new ToolLane();
    // Skill at root — will be eagerly emitted when the subagent completes
    lane.addStartWithAgentContext('skill-1', 'skill', '(orchestrate)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(analyst)', 'skill-1');
    lane.addStartWithAgentContext('tool-1', 'Read', '("x.ts")', 'agent-1');
    lane.addResult('tool-1', makeResult('contents'));
    lane.setAgentResultSummary('agent-1', 'Done (1 tool)');
    lane.addResult('agent-1', makeResult('done'));

    const lines = lane.flushSource('agent-1');
    // lines[0] = ancestor header for skill-1 (eagerly emitted)
    // lines[1] = agent-1 block (already has ◉ from formatAgentSummary, covered elsewhere)
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const skillHeader = stripAnsi(lines[0]!);
    // ◉ turn-root marker must be present in the eagerly-emitted skill header
    expect(
      skillHeader,
      `formatAgentHeader must include ◉ turn-root marker; got: ${JSON.stringify(skillHeader)}`
    ).toContain('◉ ');
    // Skill prefix must follow ◉
    expect(skillHeader).toContain('orchestrate');
  });

  it('nested eagerly-emitted ancestor (extraDepth > 0) uses dim │ spine prefix + ◉', () => {
    // outer-skill → inner-skill → agent.  agent completes first.
    // inner-skill and outer-skill are both eagerly emitted.
    // inner-skill header must have: `│ ` (outer ancestor) + `◉ ` (turn-root)
    const lane = new ToolLane();
    lane.addStartWithAgentContext('outer-skill', 'skill', '(outer)', undefined);
    lane.addStartWithAgentContext('inner-skill', 'skill', '(inner)', 'outer-skill');
    lane.addStartWithAgentContext('agent-1', 'Agent', '(worker)', 'inner-skill');
    lane.addStartWithAgentContext('tool-1', 'Read', '("y.ts")', 'agent-1');
    lane.addResult('tool-1', makeResult('contents'));
    lane.setAgentResultSummary('agent-1', 'Done (1 tool)');
    lane.addResult('agent-1', makeResult('done'));

    const lines = lane.flushSource('agent-1');
    // lines[0] = outer-skill header (depth 0 → just ◉ + prefix)
    // lines[1] = inner-skill header (depth 1 → │ + ◉ + prefix)
    // lines[2] = agent-1 block
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const outerHeader = stripAnsi(lines[0]!);
    const innerHeader = stripAnsi(lines[1]!);

    // outer-skill at depth 0 → `◉ ` at column 0
    expect(outerHeader, `outer-skill header must start with ◉; got: ${JSON.stringify(outerHeader)}`)
      .toMatch(/^◉ /);

    // inner-skill at depth 1 → `│ ◉ ` (ancestor spine + turn-root)
    expect(innerHeader, `inner-skill header must start with │ ◉; got: ${JSON.stringify(innerHeader)}`)
      .toMatch(/^│ ◉ /);
    expect(innerHeader).toContain('inner');
  });
});

// ─── Bug B (flush path): formatAgentChildren passes externalAncestors ────────
//
// `formatAgentChildren` (used when `parentEntry.headerEmitted === true`) was
// calling `renderFlushChildren` with `ancestorIsLast` defaulting to `[]`,
// omitting the `externalAncestors` vector that `formatAgentSummary` correctly
// builds as `Array.from({length: extraDepth}, () => false)`.
//
// Result: children of eagerly-committed parents rendered with zero external
// ancestor spine slots in scrollback — connectors started at col 0 regardless
// of nesting depth (orphan connectors detached from the ancestor spine).
describe('ToolLane.flushSource — formatAgentChildren passes externalAncestors (Bug B flush)', () => {
  it('children of an headerEmitted ancestor at extraDepth > 0 render with correct spine slots', () => {
    // Topology: skill → [paranoid (completes first), architect (completes second)]
    // skill.headerEmitted = true after paranoid's commit.
    // architect completes second → flushSource(architect) uses formatAgentChildren.
    // architect's children must have │ (ancestor spine) prefix, not start at col 0.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(outer)', undefined);
    lane.addStartWithAgentContext('paranoid-1', 'Agent', '(paranoid)', 'skill-1');
    lane.addStartWithAgentContext('architect-1', 'Agent', '(architect)', 'skill-1');
    lane.addStartWithAgentContext('p-tool-1', 'Read', '("foo.ts")', 'paranoid-1');
    lane.addResult('p-tool-1', makeResult('contents'));
    lane.setAgentResultSummary('paranoid-1', 'Done (1 tool)');
    lane.addResult('paranoid-1', makeResult('done'));

    // First commit: paranoid → skill.headerEmitted = true
    lane.flushSource('paranoid-1');

    // architect does some work then completes
    lane.addStartWithAgentContext('a-tool-1', 'bash', '(ls -la)', 'architect-1');
    lane.addResult('a-tool-1', makeResult('total 4\nfoo.ts'));
    lane.setAgentResultSummary('architect-1', 'Done (1 tool)');
    lane.addResult('architect-1', makeResult('architect done'));

    // Second commit: architect's flushSource will use formatAgentChildren
    // because skill-1.headerEmitted = true. architect is at extraDepth=1.
    const secondLines = lane.flushSource('architect-1');
    const block = stripAnsi(secondLines.join('\n'));
    const blockLines = block.split('\n').filter(Boolean);

    // architect block head row: `│ ◉ ` (ancestor spine │ + turn-root ◉)
    const headRow = blockLines[0]!;
    expect(
      headRow,
      `architect head row must start with │ ◉ (extraDepth=1 spine slot); got: ${JSON.stringify(headRow)}`
    ).toMatch(/^│ ◉ /);

    // Children of architect: spine-seam fix (revised) — architect is skill's
    // LAST inserted child, but the skill is still LIVE at flush time, so its
    // column stays OPEN (`'│ '`) in the committed band. Both ancestor and
    // architect's own spine column continue: `'│ │ ├─'` / `'│ │ ╰─'`. Bug B's
    // invariant (children are INDENTED, never at col 0) still holds — the row
    // leads with 4 cells of gutter. Head row keeps its incoming spine open
    // (`│ ◉ `, line ~3733 — PR #642 floating-spine invariant preserved).
    const toolRow = blockLines.find((l) => l.includes('bash') || l.includes('ls'));
    expect(toolRow, 'architect child tool row must be present').toBeDefined();
    expect(
      toolRow!,
      `architect child must start with '│ │ ' (open live-ancestor col + architect spine); got: ${JSON.stringify(toolRow)}`
    ).toMatch(/^│ │ [├╰]/);
  });

  it('formatAgentChildren at extraDepth=0 produces correct col-0 ◉ head (no regression)', () => {
    // Control: when extraDepth=0 (root-level agent), formatAgentChildren must
    // produce the same shape as formatAgentSummary — ◉ at col 0.
    const lane = new ToolLane();
    // Two root-level agents; one completes first, the other second.
    lane.addStartWithAgentContext('agent-a', 'Agent', '(alpha)', undefined);
    lane.addStartWithAgentContext('agent-b', 'Agent', '(beta)', undefined);
    lane.addStartWithAgentContext('a-tool-1', 'Read', '("a.ts")', 'agent-a');
    lane.addResult('a-tool-1', makeResult('contents'));
    lane.setAgentResultSummary('agent-a', 'Done (1 tool)');
    lane.addResult('agent-a', makeResult('done'));

    // Complete agent-a (no skill ancestor, so no eager header emission for a parent)
    lane.flushSource('agent-a');

    // agent-b does work and completes; it is at extraDepth=0
    lane.addStartWithAgentContext('b-tool-1', 'bash', '(whoami)', 'agent-b');
    lane.addResult('b-tool-1', makeResult('griffin'));
    lane.setAgentResultSummary('agent-b', 'Done (1 tool)');
    lane.addResult('agent-b', makeResult('done'));

    const lines = lane.flushSource('agent-b');
    const block = stripAnsi(lines[0]!);
    const headRow = block.split('\n')[0]!;

    // Root-level agent: ◉ at col 0 (no ancestor spine)
    expect(headRow, `root-level agent head must start with ◉; got: ${JSON.stringify(headRow)}`)
      .toMatch(/^◉ /);
  });
});

describe('ToolLane.flushCompletedRoots', () => {
  // Regression suite for H3 of PR #424 follow-up. The bug: every orchestrator
  // content chunk triggered flushToolLaneToScrollback → toolLane.flush(),
  // which nuked entries / order / agentIdStack. In-flight subagent rows
  // vanished from the overlay mid-execution.
  //
  // flushCompletedRoots is the surgical replacement: walks roots, flushes
  // only the ones with entry.result !== undefined, BFS-removes flushed roots
  // + descendants only. In-flight roots + their subtrees survive.

  it('returns [] and leaves the lane untouched when no roots have completed', () => {
    const lane = new ToolLane();
    // Orchestrator dispatches a subagent (NESTING_TOOL Task root, in-flight)
    lane.addStart('task-1', 'Task', JSON.stringify({ subagent_type: 'critic' }));
    // Subagent's child tool registers via addStartWithAgentContext
    lane.addStartWithAgentContext('bash-1', 'Bash', '"ls"', 'task-1');

    const lines = lane.flushCompletedRoots();

    expect(lines).toEqual([]);
    // Both entries must remain in the lane — overlay still has work to render.
    expect(lane.hasEntry('task-1')).toBe(true);
    expect(lane.hasEntry('bash-1')).toBe(true);
    expect(lane.hasPending()).toBe(true);
  });

  it('flushes a completed leaf-tool root and removes it from the lane', () => {
    const lane = new ToolLane();
    lane.addStart('bash-1', 'Bash', '"ls"');
    lane.addResult('bash-1', makeResult('file1.txt\nfile2.txt'));

    const lines = lane.flushCompletedRoots();

    expect(lines.length).toBeGreaterThan(0);
    expect(lane.hasEntry('bash-1')).toBe(false);
    expect(lane.hasPending()).toBe(false);
  });

  it('mixed: flushes completed leaf root, leaves in-flight subagent root + its children intact', () => {
    const lane = new ToolLane();
    // Completed root: a bash call the orchestrator made
    lane.addStart('bash-1', 'Bash', '"echo hello"');
    lane.addResult('bash-1', makeResult('hello'));

    // In-flight root: a subagent dispatch (no result yet)
    lane.addStart('task-1', 'Task', JSON.stringify({ subagent_type: 'researcher' }));
    // Subagent's children
    lane.addStartWithAgentContext('bash-2', 'Bash', '"grep foo"', 'task-1');
    lane.addStartWithAgentContext('bash-3', 'Bash', '"cat README"', 'task-1');
    // One child completed, one still in-flight
    lane.addResult('bash-2', makeResult('matched: foo'));

    const lines = lane.flushCompletedRoots();

    // The bash root should have been flushed
    expect(lines.length).toBeGreaterThan(0);
    expect(lane.hasEntry('bash-1')).toBe(false);

    // The subagent root and ALL its children (completed or not) must survive.
    // This is the critical assertion for the H3 regression — pre-fix, the
    // nuclear flush() would have removed all three of these.
    expect(lane.hasEntry('task-1'), 'in-flight subagent root must survive').toBe(true);
    expect(lane.hasEntry('bash-2'), 'completed subagent child must survive (parent in-flight)').toBe(true);
    expect(lane.hasEntry('bash-3'), 'in-flight subagent child must survive').toBe(true);
  });

  it('completed NESTING_TOOL root with completed children: both flush, lane empty', () => {
    const lane = new ToolLane();
    lane.addStart('task-1', 'Task', JSON.stringify({ subagent_type: 'researcher' }));
    lane.addStartWithAgentContext('bash-1', 'Bash', '"ls"', 'task-1');
    lane.addResult('bash-1', makeResult('out'));
    lane.addResult('task-1', makeResult('subagent finished'));

    const lines = lane.flushCompletedRoots();

    expect(lines.length).toBeGreaterThan(0);
    expect(lane.hasEntry('task-1')).toBe(false);
    expect(lane.hasEntry('bash-1')).toBe(false);
    expect(lane.hasPending()).toBe(false);
  });

  it('getOverlay() after flushCompletedRoots() reflects only surviving in-flight rows', () => {
    const lane = new ToolLane();
    // Completed root
    lane.addStart('bash-1', 'Bash', '"echo first"');
    lane.addResult('bash-1', makeResult('first'));
    // In-flight subagent
    lane.addStart('task-1', 'Task', JSON.stringify({ subagent_type: 'critic' }));
    lane.mergeAgentLabel('task-1', 'critic-pragmatist');
    lane.addStartWithAgentContext('bash-2', 'Bash', '"grep something"', 'task-1');

    lane.flushCompletedRoots();

    const overlay = stripAnsi(lane.getOverlay());
    // bash-1 is gone (flushed to scrollback by the caller)
    expect(overlay).not.toContain('echo first');
    // task-1 + bash-2 still render — this is the visible "live spinner row"
    // that the pre-fix path was wiping. Critical for H3.
    expect(overlay).toContain('critic-pragmatist');
    expect(overlay).toContain('grep something');
  });

  it('multiple in-flight roots: all survive, no spurious lines emitted', () => {
    const lane = new ToolLane();
    lane.addStart('task-1', 'Task', JSON.stringify({ subagent_type: 'a' }));
    lane.addStart('task-2', 'Task', JSON.stringify({ subagent_type: 'b' }));
    lane.addStart('task-3', 'Task', JSON.stringify({ subagent_type: 'c' }));

    const lines = lane.flushCompletedRoots();

    expect(lines).toEqual([]);
    expect(lane.hasEntry('task-1')).toBe(true);
    expect(lane.hasEntry('task-2')).toBe(true);
    expect(lane.hasEntry('task-3')).toBe(true);
  });

  it('repeated calls: each flush surgically removes only newly-completed roots', () => {
    const lane = new ToolLane();
    lane.addStart('bash-1', 'Bash', '"a"');
    lane.addStart('bash-2', 'Bash', '"b"');
    lane.addStart('bash-3', 'Bash', '"c"');

    // First flush: only bash-1 completed
    lane.addResult('bash-1', makeResult('a-out'));
    const first = lane.flushCompletedRoots();
    expect(first.length).toBeGreaterThan(0);
    expect(lane.hasEntry('bash-1')).toBe(false);
    expect(lane.hasEntry('bash-2')).toBe(true);
    expect(lane.hasEntry('bash-3')).toBe(true);

    // Second flush: bash-2 still in-flight, no-op
    const second = lane.flushCompletedRoots();
    expect(second).toEqual([]);

    // Third flush: bash-2 + bash-3 complete, both flush
    lane.addResult('bash-2', makeResult('b-out'));
    lane.addResult('bash-3', makeResult('c-out'));
    const third = lane.flushCompletedRoots();
    expect(third.length).toBeGreaterThan(0);
    expect(lane.hasPending()).toBe(false);
  });
});

describe('ToolLane.peekTrailingCompletedRootToolName — cross-flush run gate', () => {
  it('returns undefined for an empty lane', () => {
    const lane = new ToolLane();
    expect(lane.peekTrailingCompletedRootToolName()).toBeUndefined();
  });

  it('returns the toolName of the trailing completed flat root', () => {
    const lane = new ToolLane();
    lane.addStart('b1', 'Bash', '"echo a"');
    lane.addResult('b1', makeResult('a'));
    expect(lane.peekTrailingCompletedRootToolName()).toBe('Bash');
  });

  it('returns undefined when the trailing flat root is still in-flight', () => {
    const lane = new ToolLane();
    lane.addStart('b1', 'Bash', '"echo a"');
    lane.addResult('b1', makeResult('a'));
    lane.addStart('b2', 'Bash', '"echo b"'); // registered, no result yet
    expect(lane.peekTrailingCompletedRootToolName()).toBeUndefined();
  });

  it('returns undefined when the trailing root is a NESTING tool (own commit path)', () => {
    const lane = new ToolLane();
    lane.addStart('a1', 'Agent', '(researcher)');
    lane.addResult('a1', makeResult('done'));
    expect(lane.peekTrailingCompletedRootToolName()).toBeUndefined();
  });

  it('skips nested (agentContext) children to report the trailing ROOT tool', () => {
    const lane = new ToolLane();
    lane.addStart('b1', 'Bash', '"echo a"');
    lane.addResult('b1', makeResult('a'));
    // A completed child bound to an agent context — must be skipped (not a root).
    lane.addStartWithAgentContext('child-1', 'Read', '("x.ts")', 'some-agent');
    lane.addResult('child-1', makeResult('1 line'));
    expect(lane.peekTrailingCompletedRootToolName()).toBe('Bash');
  });

  it('reports the MOST-RECENT completed flat root when several tool names differ', () => {
    const lane = new ToolLane();
    lane.addStart('b1', 'Bash', '"a"');
    lane.addResult('b1', makeResult('a'));
    lane.addStart('r1', 'Read', '("x.ts")');
    lane.addResult('r1', makeResult('1 line'));
    expect(lane.peekTrailingCompletedRootToolName()).toBe('Read');
  });
});
