/**
 * Tests for `afk trace show --results` (trace-results.ts + its formatTrace
 * wiring). The message-journal reader is mocked: these tests cover the
 * label<->session bridge, rendering, truncation, and the no-journal note, not
 * the reader itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JournalBlock } from '../../agent/journal/index.js';

type ToolResultBlock = Extract<JournalBlock, { type: 'tool_result' }>;
type Found = { block: ToolResultBlock; subagentId?: string } | null;

const mockFind = vi.fn<(sessionId: string, toolUseId: string) => Found>();
const mockExists = vi.fn<(sessionId: string) => boolean>();

vi.mock('../../agent/journal/index.js', () => ({
  findToolResult: (s: string, t: string) => mockFind(s, t),
  journalExists: (s: string) => mockExists(s),
}));

import { buildTraceResults, journalSessionCandidates, renderResultBlock } from './trace-results.js';
import { formatTrace, parseTrace } from './trace.js';
import type { TraceEvent } from '../../agent/trace/index.js';

function textResult(text: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', toolUseId: 'x', isError, content: [{ type: 'text', text }] };
}

const EVENTS = [
  { ts: '2026-06-05T12:29:59.000Z', seq: 0, kind: 'session_phase', payload: { phase: 'session_id_assigned', sessionId: 'real-sess' } },
  { ts: '2026-06-05T12:30:00.000Z', seq: 1, kind: 'tool_call', payload: { phase: 'started', toolUseId: 'tu1', name: 'read_file', inputBytes: 5 } },
  { ts: '2026-06-05T12:30:01.000Z', seq: 2, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu1', name: 'read_file', resultBytes: 12, isError: false, truncated: false, durationMs: 4 } },
  { ts: '2026-06-05T12:30:02.000Z', seq: 3, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu2', name: 'bash', resultBytes: 9, isError: false, truncated: false, durationMs: 4, subagentId: 'child-1' } },
];

function parsed() {
  return parseTrace(EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

beforeEach(() => {
  mockFind.mockReset();
  mockExists.mockReset();
});

describe('journalSessionCandidates', () => {
  it('prefers session_id_assigned ids (latest first) then the selector, dropping unsafe ids', () => {
    const events = [
      { ts: 't', seq: 0, kind: 'session_phase', payload: { phase: 'session_id_assigned', sessionId: 'first' } },
      { ts: 't', seq: 1, kind: 'session_phase', payload: { phase: 'session_id_assigned', sessionId: '../evil' } },
      { ts: 't', seq: 2, kind: 'session_phase', payload: { phase: 'session_id_assigned', sessionId: 'second' } },
    ] as unknown as TraceEvent[];
    expect(journalSessionCandidates('label-uuid', events)).toEqual(['second', 'first', 'label-uuid']);
  });

  it('dedups when the selector is the assigned id', () => {
    const events = parsed().events;
    expect(journalSessionCandidates('real-sess', events)).toEqual(['real-sess']);
  });
});

describe('renderResultBlock', () => {
  it('indents every line and caps with a note naming the flag', () => {
    const out = renderResultBlock('a\nb\nc\nd', 2);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/│ a$/);
    expect(lines[1]).toMatch(/│ b$/);
    expect(lines[2]).toContain('2 more line(s) hidden; --results-lines 0 shows all');
  });

  it('shows everything when maxLines is 0', () => {
    expect(renderResultBlock('a\nb\nc', 0).split('\n')).toHaveLength(3);
  });

  it('strips terminal escapes and control bytes', () => {
    const out = renderResultBlock('\x1b[31mred\x1b[0m\x07bell', 0);
    expect(out).toContain('red bell');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
  });

  it('strips C1 controls, including an 8-bit OSC (U+009D ... U+009C)', () => {
    const out = renderResultBlock('a\u009d0;pwned\u009cb\u0085c\u009bd', 0);
    expect(out).not.toMatch(/[\u0080-\u009f]/);
    expect(out).toContain('a');
    expect(out).toContain('pwned'); // payload text survives as inert characters
  });

  it('tags error results and subagent provenance', () => {
    const out = renderResultBlock('boom', 0, { isError: true, subagentId: 'child-1' });
    expect(out).toContain('error result');
    expect(out).toContain('from subagent journal child-1');
  });

  it('marks an empty result explicitly', () => {
    expect(renderResultBlock('', 0)).toContain('(empty result)');
  });
});

describe('formatTrace with --results', () => {
  it('prints each completed tool call\'s full result under its row, including subagent calls', () => {
    mockExists.mockImplementation((id) => id === 'real-sess');
    mockFind.mockImplementation((_s, tu) =>
      tu === 'tu1'
        ? { block: textResult('file contents line 1\nline 2') }
        : { block: textResult('child output'), subagentId: 'child-1' },
    );
    const p = parsed();
    const results = buildTraceResults('label-uuid', p.events, 40);
    const out = formatTrace('label-uuid', '/w/label-uuid/trace.jsonl', p, {
      resultFor: results.resultFor,
      resultsNote: results.note,
    });
    expect(out).toContain('Results  journal real-sess · first 40 lines per result');
    const lines = out.split('\n');
    const readRow = lines.findIndex((l) => l.includes('read_file') && l.includes('ok'));
    expect(lines[readRow + 1]).toMatch(/│ file contents line 1$/);
    expect(lines[readRow + 2]).toMatch(/│ line 2$/);
    const bashRow = lines.findIndex((l) => l.includes('bash') && l.includes('[child-1]'));
    expect(lines[bashRow + 1]).toMatch(/│ child output$/);
    expect(lines[bashRow + 2]).toContain('from subagent journal child-1');
    // Only journals that exist are searched; the label itself has none.
    expect(mockFind.mock.calls.every(([s]) => s === 'real-sess')).toBe(true);
  });

  it('says once in the header when no journal exists, and adds nothing under rows', () => {
    mockExists.mockReturnValue(false);
    const p = parsed();
    const results = buildTraceResults('label-uuid', p.events);
    const out = formatTrace('label-uuid', '/p', p, { resultFor: results.resultFor, resultsNote: results.note });
    expect(out).toContain('no message journal for session real-sess, label-uuid');
    expect(out).not.toContain('│');
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('notes a call missing from an existing journal', () => {
    mockExists.mockReturnValue(true);
    mockFind.mockReturnValue(null);
    const p = parsed();
    const results = buildTraceResults('real-sess', p.events);
    const out = formatTrace('real-sess', '/p', p, { resultFor: results.resultFor, resultsNote: results.note });
    expect(out).toContain('(result not found in the journal)');
  });

  it('survives a reader that throws', () => {
    mockExists.mockImplementation(() => {
      throw new Error('boom');
    });
    const p = parsed();
    expect(() => buildTraceResults('real-sess', p.events)).not.toThrow();
  });

  it('leaves output unchanged without --results', () => {
    const p = parsed();
    expect(formatTrace('s', '/p', p)).not.toContain('Results');
    expect(mockFind).not.toHaveBeenCalled();
  });
});
