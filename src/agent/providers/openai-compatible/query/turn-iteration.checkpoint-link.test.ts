/** pushUserTurn checkpoint linking (#4271): only a turn's first user message is linked. */
import { describe, expect, it, vi } from 'vitest';
import { pushUserTurn, type IterationContext } from './turn-iteration.js';

function ctx(link: ReturnType<typeof vi.fn>): IterationContext {
  return { currentModel: 'gpt-4o-mini', priorTurns: [], checkpoint: { linkUserTurn: link } } as unknown as IterationContext;
}

describe('pushUserTurn checkpoint link', () => {
  it('links the prompt message object at its history index', () => {
    const link = vi.fn();
    const c = ctx(link);
    pushUserTurn(c, 'hello');
    expect(link).toHaveBeenCalledWith(c.priorTurns[0], 0);
  });

  it('does not link a Stop-hook continuation message', () => {
    const link = vi.fn();
    const c = ctx(link);
    pushUserTurn(c, 'hello');
    pushUserTurn(c, 'keep going', false);
    expect(link).toHaveBeenCalledTimes(1);
    expect(c.priorTurns).toHaveLength(2);
  });
});
