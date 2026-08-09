/**
 * Unit tests for the `ttfb_timeout` trace-phase renderer.
 *
 * Invariant: the rendered line must not assert a re-drive COUNT the event does
 * not carry. Under the counted TTFB budget one round can be re-driven more than
 * once, so the renderer reports the 1-based `metadata.attempt` index when the
 * event has one and stays silent about the count when it does not — traces
 * written before the counted budget carry no `attempt`, and defaulting would
 * assert a fact the event never recorded. The previous hardcoded "once" was
 * true only under the old boolean one-shot regime.
 *
 * @module cli/commands/trace-ttfb-render.test
 */

import { describe, it, expect } from 'vitest';
import { parseTrace, formatTrace } from './trace.js';

function render(metadata: Record<string, string | number | boolean>): string {
  const event = JSON.stringify({
    kind: 'session_phase',
    seq: 1,
    ts: '2026-08-08T16:00:00.000Z',
    payload: { phase: 'ttfb_timeout', durationMs: 120_000, metadata },
  });
  return formatTrace('sess-test', '/tmp/trace.jsonl', parseTrace(event));
}

describe('ttfb_timeout renderer', () => {
  it('reports WHICH re-drive fired from the 1-based attempt index', () => {
    const out = render({ reason: 'ttfb-timeout', source: 'first-byte', attempt: 2 });
    expect(out).toContain('ttfb-stall');
    expect(out).toContain('request re-driven #2');
    expect(out).toContain('(first-byte)');
  });

  it('omits the count for a pre-counted-budget event carrying no attempt', () => {
    const out = render({ reason: 'ttfb-timeout', source: 'first-byte' });
    expect(out).toContain('request re-driven');
    expect(out).not.toContain('re-driven #');
  });

  it('never hardcodes "once" — the counted budget permits a second re-drive', () => {
    expect(render({ reason: 'ttfb-timeout', attempt: 2 })).not.toContain('re-driven once');
  });

  it('renders in the DEFAULT view, not only under --all', () => {
    // A multi-minute gap the operator did not cause must be visible without
    // opting into low-signal events; this phase is gated ahead of `showAll`.
    expect(render({ reason: 'ttfb-timeout', attempt: 1 })).toContain('ttfb-stall');
  });
});
