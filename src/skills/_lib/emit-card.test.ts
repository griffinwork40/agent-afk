import { describe, it, expect, vi } from 'vitest';
import { emitCard } from './emit-card.js';
import { runWithSink } from '../../agent/_lib/skill-sink-channel.js';

describe('emitCard', () => {
  it('is a no-op when no ambient sink is set', () => {
    expect(() => emitCard({ kind: 'status', body: 'hi' })).not.toThrow();
  });

  it('dispatches a panel event to the ambient sink with __main__ subagentId', async () => {
    const sink = vi.fn();
    await runWithSink(sink, async () => {
      emitCard({ kind: 'checkpoint', title: 'build', body: 'all good' });
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(
      { type: 'panel', spec: { kind: 'checkpoint', title: 'build', body: 'all good' } },
      { subagentId: '__main__' },
    );
  });

  it('passes the spec through unchanged when body is an array', async () => {
    const sink = vi.fn();
    const spec = { kind: 'plan' as const, body: ['step 1', 'step 2'] };
    await runWithSink(sink, async () => {
      emitCard(spec);
    });
    expect(sink).toHaveBeenCalledWith(
      { type: 'panel', spec },
      { subagentId: '__main__' },
    );
  });

  it('does not invoke the sink when called outside a runWithSink scope', () => {
    const sink = vi.fn();
    // Note: no runWithSink wrapper — sink should never be called.
    emitCard({ kind: 'diagnosis', body: 'oops' });
    expect(sink).not.toHaveBeenCalled();
  });
});
