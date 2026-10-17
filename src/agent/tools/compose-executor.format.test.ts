/**
 * Tests for formatDAGResult in compose-executor.format.ts.
 *
 * Covers: output formatting, failed node formatting, skipped nodes, and
 * setupNotices passthrough on DAGRunResult (#3661 nice-to-have).
 */

import { describe, it, expect, vi } from 'vitest';
import { formatDAGResult } from './compose-executor.format.js';
import type { DAGRunResult } from '../dag.js';

// fs writes (spillNodeOutput) must not touch the real filesystem in unit tests.
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock('../../paths.js', () => ({ getSessionsDir: () => '/fake/sessions' }));

const OPTS = { sessionId: 'sess-1', callId: 'call-1' };

describe('formatDAGResult', () => {
  it('formats a single successful string output', () => {
    const result: DAGRunResult = {
      outputs: { A: 'node A text' },
      failed: [],
      skipped: [],
      partial: [],
    };
    const { content, truncations } = formatDAGResult(result, OPTS);
    expect(content).toContain('## A');
    expect(content).toContain('node A text');
    expect(truncations).toHaveLength(0);
  });

  it('formats a failed node with its error message', () => {
    const result: DAGRunResult = {
      outputs: {},
      failed: [{ id: 'B', error: new Error('something went wrong') }],
      skipped: [],
      partial: [],
    };
    const { content } = formatDAGResult(result, OPTS);
    expect(content).toContain('## B [FAILED]');
    expect(content).toContain('something went wrong');
  });

  it('formats skipped nodes', () => {
    const result: DAGRunResult = {
      outputs: {},
      failed: [],
      skipped: ['C', 'D'],
      partial: [],
    };
    const { content } = formatDAGResult(result, OPTS);
    expect(content).toContain('## Skipped');
    expect(content).toContain('C');
    expect(content).toContain('D');
  });

  it('serialises a non-string output as JSON', () => {
    const result: DAGRunResult = {
      outputs: { E: { score: 42, ok: true } },
      failed: [],
      skipped: [],
      partial: [],
    };
    const { content } = formatDAGResult(result, OPTS);
    expect(content).toContain('"score":42');
  });

  // -------------------------------------------------------------------------
  // Nice-to-have (#3661): setupNotices field on DAGRunResult passes through
  // the result object unchanged. formatDAGResult does not currently render
  // setupNotices (it formats outputs/failed/skipped only), so the test verifies
  // that the field is present on the result handed to formatDAGResult and that
  // the formatter does not corrupt or strip it.
  // -------------------------------------------------------------------------
  it('setupNotices on DAGRunResult is preserved — formatDAGResult does not strip it', () => {
    const result: DAGRunResult = {
      outputs: { F: 'done' },
      failed: [],
      skipped: [],
      partial: [],
      setupNotices: { F: 'Worktree setup failed: pnpm install returned exit 1' },
    };

    // formatDAGResult receives the result; the field must survive as-is.
    const { content } = formatDAGResult(result, OPTS);

    // Formatter produces output sections for the node.
    expect(content).toContain('## F');

    // The setupNotices field is still intact on the original result object —
    // formatDAGResult must not mutate or delete it.
    expect(result.setupNotices).toBeDefined();
    expect(result.setupNotices!['F']).toBe('Worktree setup failed: pnpm install returned exit 1');
  });
});
