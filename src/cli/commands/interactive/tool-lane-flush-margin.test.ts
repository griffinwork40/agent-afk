/**
 * Unit tests for indentForScrollback (tool-lane-flush-margin.ts).
 *
 * Covers the per-line semantics introduced in PR #2196 review: each element
 * of the input array may be a multi-line string (e.g. the `childBlock` from
 * `ToolLane.flushSource`), and the indent must be applied to every non-empty
 * physical line within each element — not just the first.
 *
 * Also tests: '' elements stay '', element count is preserved, and the
 * separator column alignment holds when piping real flushSource output through
 * indentForScrollback.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { indentForScrollback } from './tool-lane-flush-margin.js';
import { ToolLane } from './tool-lane.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';

// ─── Env/column helpers (mirrors measure.test.ts) ────────────────────────────

function withCenterEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env['AFK_CENTER_CONTENT'];
  if (value === undefined) delete process.env['AFK_CENTER_CONTENT'];
  else process.env['AFK_CENTER_CONTENT'] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['AFK_CENTER_CONTENT'];
    else process.env['AFK_CENTER_CONTENT'] = prev;
  }
}

function withCols<T>(cols: number, fn: () => T): T {
  const prev = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
  }
}

/** Strip ANSI escape codes. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

afterEach(() => {
  delete process.env['AFK_CENTER_CONTENT'];
});

// ─── Off-path (no centering) ─────────────────────────────────────────────────

describe('indentForScrollback — centering off', () => {
  it('returns the array unchanged when AFK_CENTER_CONTENT is unset', () => {
    withCenterEnv(undefined, () => {
      const input = ['line A', 'line B\nline C', ''];
      const result = indentForScrollback(input);
      expect(result).toBe(input); // same reference
    });
  });
});

// ─── On-path (centering enabled, wide terminal) ───────────────────────────────

describe('indentForScrollback — centering on, wide terminal', () => {
  it('indents every non-empty line of a single-line element', () => {
    withCenterEnv('1', () =>
      withCols(220, () => {
        const result = indentForScrollback(['hello']);
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('  hello');
      }),
    );
  });

  it('indents EVERY non-empty line within a multi-line element', () => {
    withCenterEnv('1', () =>
      withCols(220, () => {
        const el = 'first\nsecond\nthird';
        const result = indentForScrollback([el]);
        expect(result).toHaveLength(1);
        const lines = (result[0] as string).split('\n');
        expect(lines).toHaveLength(3);
        for (const l of lines) {
          expect(l.startsWith('  '), `line "${l}" must start with 2-space indent`).toBe(true);
        }
      }),
    );
  });

  it('preserves element count (callers rely on array shape)', () => {
    withCenterEnv('1', () =>
      withCols(220, () => {
        const input = ['block line A\nblock line B', 'single', ''];
        const result = indentForScrollback(input);
        expect(result).toHaveLength(input.length);
      }),
    );
  });

  it("'' elements (root-depth separator) pass through unchanged", () => {
    withCenterEnv('1', () =>
      withCols(220, () => {
        const result = indentForScrollback(['content', '']);
        expect(result[1]).toBe('');
      }),
    );
  });

  it('empty physical lines within a multi-line element stay empty', () => {
    withCenterEnv('1', () =>
      withCols(220, () => {
        const el = 'first\n\nthird';
        const result = indentForScrollback([el]);
        const lines = (result[0] as string).split('\n');
        expect(lines[1]).toBe(''); // the embedded empty line stays ''
        expect(lines[0]).toBe('  first');
        expect(lines[2]).toBe('  third');
      }),
    );
  });
});

// ─── Separator alignment with flushSource output ─────────────────────────────

describe('indentForScrollback — separator column alignment with flushSource', () => {
  function res(content: string): ToolResultChunk {
    return { type: 'tool_result', toolUseId: 'x', content, isError: false };
  }

  it('dim separator col-0 │ aligns with the previous rows col-0 │ after indenting', () => {
    withCenterEnv('1', () =>
      withCols(220, () => {
        // Build a nested flushSource scenario: skill (live) -> Agent -> [Read, Glob]
        const lane = new ToolLane();
        lane.addStartWithAgentContext('skill-x', 'skill', '(diagnose)', undefined);
        lane.addStartWithAgentContext('agent-x', 'Agent', '(critic)', 'skill-x');
        lane.addStartWithAgentContext('read-x', 'Read', '("a.ts")', 'agent-x');
        lane.addResult('read-x', res('10 lines'));
        lane.addStartWithAgentContext('glob-x', 'Glob', '("**/*.ts")', 'agent-x');
        lane.addResult('glob-x', res('3 files'));
        lane.setAgentResultSummary('agent-x', 'Done (2 tools)');
        lane.addResult('agent-x', res('done'));

        const raw = lane.flushSource('agent-x');
        const indented = indentForScrollback(raw);

        // The last element is the separator (depth=1, non-empty dim spine).
        const lastEl = indented[indented.length - 1] as string;
        expect(lastEl, 'separator element must not be empty at depth 1').not.toBe('');

        // The separator consists of spine characters only (after ANSI strip).
        // The first physical line of the separator must start with │ at col 2
        // (the 2-space indent) — matching the col-0 │ of the block rows above.
        const sepFirstLine = stripAnsi(lastEl.split('\n')[0] ?? '').trimEnd();
        // Indented separator must start with '  │' (2-space indent + spine).
        expect(
          sepFirstLine.startsWith('  │'),
          `separator first line "${sepFirstLine}" must start with "  │" after indent`,
        ).toBe(true);

        // The block rows (second-to-last element, childBlock) must also start
        // with the indent so their │ aligns with the separator's │.
        const blockEl = indented[indented.length - 2] as string;
        const blockFirstLine = stripAnsi((blockEl ?? '').split('\n')[0] ?? '').trimEnd();
        expect(
          blockFirstLine.startsWith('  │'),
          `childBlock first line "${blockFirstLine}" must start with "  │" after indent`,
        ).toBe(true);
      }),
    );
  });
});
