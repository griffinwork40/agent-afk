/**
 * Regression (the "broken topology spine" screenshot): when a subagent finishes
 * inside a STILL-LIVE ancestor (e.g. a `skill` that hasn't completed),
 * `flushSource` commits the subagent's block to scrollback via the compositor.
 * The committed DESCENDANT rows must use the SAME spine-column open/closed state
 * the live overlay would draw for the same tree — otherwise the committed band
 * produces a seam where col encodings diverge.
 *
 * Fix: because a live ancestor's last child is UNKNOWABLE at flush time (the
 * ancestor may emit further waves), BOTH the overlay and the committed band keep
 * live ancestor columns OPEN (`│ `). Concretely:
 * `skill (live) → Agent (skill's only/last child) → [tool, tool]`.
 * Both overlay AND committed band render the tools as `│ │ ├─ …` (col-0 OPEN).
 * Pre-fix the branch attempted to close col-0 (`  │ ├─`) in the band while the
 * overlay kept it open — creating a different seam. The revised invariant: live
 * ancestor columns ALWAYS stay open until the ancestor itself settles.
 *
 * Invariant preserved (PR #642 floating-spine): the Agent's own HEADER row keeps
 * its incoming spine OPEN (`│ ◉ …`) so it stays connected to the live skill
 * above it. DESCENDANT rows also stay open (same spine). This test asserts both.
 *
 * This is a compositor-harness test: it commits the band through a real
 * `TerminalCompositor` and reads the composited `@xterm/headless` viewport, so
 * it exercises what actually reaches the screen — not just the string builder.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';
import { ToolLane } from './commands/interactive/tool-lane.js';
import type { ToolResultChunk } from '../agent/types/message-types.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

function makeStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true; s.columns = cols; s.rows = rows; return s;
}
function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true; s.isRaw = false; s.setRawMode = vi.fn((r: boolean) => { s.isRaw = r; return s; }); return s;
}
function collect(stream: MockStdout): () => string {
  const c: string[] = [];
  stream.on('data', (x) => c.push(String(x)));
  return () => c.join('');
}
function termWrite(t: HeadlessTerminal, d: string): Promise<void> {
  return new Promise((r) => t.write(d, r));
}
function allLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active; const o: string[] = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); }
  return o;
}
function res(content: string): ToolResultChunk {
  return { type: 'tool_result', toolUseId: 'x', content, isError: false };
}

const COLS = 100, ROWS = 24;

describe('commitAbove spine seam: committed descendant rows match the overlay (screenshot regression)', () => {
  it('committed subagent block under a live skill keeps live-ancestor col-0 OPEN (matching overlay)', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();

    // skill (live, root) → Agent (skill's last child) → [Read, Glob]; Agent completes.
    const lane = new ToolLane();
    lane.addStartWithAgentContext('skill-1', 'skill', '(diagnose)', undefined);
    lane.addStartWithAgentContext('agent-1', 'Agent', '(critic)', 'skill-1');
    lane.addStartWithAgentContext('read-1', 'Read', '("a.ts")', 'agent-1');
    lane.addResult('read-1', res('10 lines'));
    lane.addStartWithAgentContext('glob-1', 'Glob', '("**/*.ts")', 'agent-1');
    lane.addResult('glob-1', res('3 files'));
    lane.setAgentResultSummary('agent-1', 'Done (2 tools)');
    lane.addResult('agent-1', res('done'));

    // Subagent done mid-turn → commit its block to scrollback through the compositor.
    const bandLines = lane.flushSource('agent-1').flatMap((s) => s.split('\n'));
    for (const l of bandLines) c.commitAbove(l);
    // Live overlay = the surviving skill (anonymous anchor, header already in scrollback).
    c.setOverlay(lane.getOverlay());

    const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true, convertEol: true });
    await termWrite(term, all());
    const lines = allLines(term);
    const dump = lines.map((l, i) => `[${String(i).padStart(2)}] ${JSON.stringify(l.replace(/\s+$/, ''))}`).join('\n');

    const agentHeader = lines.find((l) => l.includes('Agent') && l.includes('critic'));
    const readRow = lines.find((l) => l.includes('Read') && l.includes('a.ts'));
    const globRow = lines.find((l) => l.includes('Glob'));
    expect(agentHeader, `Agent header not found:\n${dump}`).toBeDefined();
    expect(readRow, `Read descendant row not found:\n${dump}`).toBeDefined();
    expect(globRow, `Glob descendant row not found:\n${dump}`).toBeDefined();

    // (1) SEAM FIXED: committed descendant rows keep the live-ancestor col-0 OPEN.
    //     Both overlay and band use `│ │ ├─ …` — live ancestor column stays `│ `.
    //     Closing it (baking a last-child guess) would fragment the rail if the
    //     skill later emits more waves (the prior ancestorIsLastOf approach).
    expect(readRow!.startsWith('│'), `Read row missing open │ at col-0 (seam — band/overlay diverged):\n${dump}`).toBe(true);
    expect(globRow!.startsWith('│'), `Glob row missing open │ at col-0 (seam — band/overlay diverged):\n${dump}`).toBe(true);
    // The agent's own spine column is also present (two spine cols total: `│ │ `).
    expect(/^│ │ /.test(readRow!), `Read row must start with │ │  (ancestor + agent spine):\n${dump}`).toBe(true);

    // (2) FLOATING-SPINE INVARIANT (PR #642): the Agent HEADER keeps its incoming
    //     spine OPEN at col-0 (`│ ◉ …`) so it stays connected to the live skill.
    expect(agentHeader!.startsWith('│'), `Agent header lost its incoming spine (floated):\n${dump}`).toBe(true);

    term.dispose(); statusLine.stop(); c.disarm();
  }, 15_000);
});
