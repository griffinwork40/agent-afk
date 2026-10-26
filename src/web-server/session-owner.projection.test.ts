import { describe, expect, it } from 'vitest';
import { projectJournalMessages } from './session-owner.projection.js';

describe('projectJournalMessages (rewind projection)', () => {
  it('keeps a 20k assistant answer whole and still clips user text', () => {
    const answer = 'b'.repeat(20_000);
    const records = projectJournalMessages([
      { role: 'user', content: [{ type: 'text', text: 'q'.repeat(20_000) }] },
      { role: 'assistant', content: [{ type: 'text', text: answer }] },
    ] as never);
    expect(records.find((r) => r.kind === 'assistant')).toEqual({ kind: 'assistant', text: answer });
    const user = records.find((r) => r.kind === 'user');
    expect(user?.kind === 'user' && user.text.length).toBeLessThan(8_100);
  });

  it('injects priorCost into the last done record when cost > 0', () => {
    const records = projectJournalMessages([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    ] as never, { costUsd: 0.1234, durationMs: 5000, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 });
    const done = records.filter((r) => r.kind === 'done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ kind: 'done', costUsd: 0.1234, durationMs: 5000, inputTokens: 100, outputTokens: 50 });
    // cacheReadTokens=0 is omitted (falsy guard)
    expect((done[0] as Record<string, unknown>)['cacheReadTokens']).toBeUndefined();
  });

  it('emits a plain done record when priorCost is zero', () => {
    const records = projectJournalMessages([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    ] as never, { costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    const done = records.filter((r) => r.kind === 'done');
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({ kind: 'done' });
  });

  it('carries a recorded tool duration through the projection and omits an unknown one', () => {
    const records = projectJournalMessages([
      { role: 'user', content: [{ type: 'text', text: 'run' }] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'known', name: 'bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'unknown', name: 'read_file', input: { path: 'x' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', toolUseId: 'known', content: [{ type: 'text', text: 'ok' }] },
        { type: 'tool_result', toolUseId: 'unknown', content: [{ type: 'text', text: 'ok' }] },
      ] },
    ] as never, undefined, new Map([['known', 1234]]));
    const results = records.filter((r) => r.kind === 'tool_result');
    expect(results[0]).toMatchObject({ toolUseId: 'known', durationMs: 1234 });
    expect(results[1]).not.toHaveProperty('durationMs');
  });
});
