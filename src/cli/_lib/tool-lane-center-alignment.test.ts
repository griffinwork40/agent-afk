/**
 * AFK_CENTER_CONTENT: a tool row must not jump columns when it moves from the
 * live overlay into scrollback (audit item C4).
 *
 * The live overlay paints `margin + '  ' + row` (joinOverlayLines). Committed
 * text receives the margin at PAINT time inside the compositor, so the commit
 * path must add only the 2-col tool-lane indent (indentForScrollback) — never
 * the margin itself (that would double-pad).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushToolLaneToScrollback } from './stream-renderer-orchestrator-emit.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { stripAnsi } from '../display.js';
import type { OrchestratorCtx } from './stream-renderer-orchestrator.js';

const COLS = 200;
const MARGIN = 50;
let origCols: PropertyDescriptor | undefined;

beforeEach(() => {
  origCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true });
  vi.stubEnv('AFK_TEXT_MEASURE', '100');
});
afterEach(() => {
  if (origCols) Object.defineProperty(process.stdout, 'columns', origCols);
  else delete (process.stdout as { columns?: number }).columns;
  vi.unstubAllEnvs();
});

function lead(s: string): number { return s.length - s.trimStart().length; }

function liveAndCommitted(): { live: string; committed: string } {
  const toolLane = new ToolLane();
  toolLane.addStart('t1', 'Bash', '"ls -la TOOLCMD_MARK"');
  // Live (in-flight) overlay row first, then complete it and flush.
  const live = stripAnsi(toolLane.getOverlay()).split('\n').find((l) => l.includes('TOOLCMD_MARK'))!;
  toolLane.addResult('t1', { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false });
  const commitAbove = vi.fn<(text: string) => void>();
  const compositor = { setOverlay: vi.fn(), commitAbove, setSpinner: vi.fn() };
  const ctx = { toolLane, isTTY: true, compositor, overlayComposer: undefined, out: { line: vi.fn() } };
  flushToolLaneToScrollback(ctx as unknown as OrchestratorCtx);
  const committed = commitAbove.mock.calls.map((c) => stripAnsi(c[0]))
    .join('\n').split('\n').find((l) => l.includes('TOOLCMD_MARK'))!;
  return { live, committed };
}

describe('tool row live vs committed column (AFK_CENTER_CONTENT)', () => {
  it('centered: committed row (margin added at paint) lands on the live column', () => {
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    const { live, committed } = liveAndCommitted();
    expect(committed).toBeDefined();
    // The compositor prefixes MARGIN at paint; the committed text itself must
    // carry no margin (no double pad) but the same tool-lane indent.
    expect(lead(committed)).toBeLessThan(MARGIN);
    expect(MARGIN + lead(committed)).toBe(lead(live));
  });

  it('centering off: live and committed rows are unchanged and aligned', () => {
    vi.stubEnv('AFK_CENTER_CONTENT', '');
    const { live, committed } = liveAndCommitted();
    expect(lead(committed)).toBe(lead(live));
  });
});
