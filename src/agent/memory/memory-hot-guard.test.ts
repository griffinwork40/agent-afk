import { describe, it, expect, vi } from 'vitest';
import { guardChildHotWrites, isForkedChildSession, CHILD_HOT_WRITE_DENIED } from './memory-hot-guard.js';
import type { ToolHandler } from '../tools/types.js';

function handlers(): { map: Map<string, ToolHandler>; inner: ReturnType<typeof vi.fn> } {
  const inner = vi.fn(async () => ({ content: 'ok' }));
  const map = new Map<string, ToolHandler>([
    ['memory_update', inner as unknown as ToolHandler],
    ['memory_search', (async () => ({ content: '[]' })) as ToolHandler],
  ]);
  return { map, inner };
}

describe('guardChildHotWrites', () => {
  it('returns the same map untouched for top-level sessions', async () => {
    const { map, inner } = handlers();
    const out = guardChildHotWrites(map, false);
    expect(out).toBe(map);
    await out.get('memory_update')!({ target: 'hot', action: 'set', content: 'x' });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('rejects target:"hot" for child sessions without calling the store handler', async () => {
    const { map, inner } = handlers();
    const out = guardChildHotWrites(map, true);
    const result = await out.get('memory_update')!({ target: 'hot', action: 'set', content: 'x' });
    expect(result).toEqual({ content: CHILD_HOT_WRITE_DENIED, isError: true });
    expect(inner).not.toHaveBeenCalled();
  });

  it('passes target:"fact" through to the store handler for child sessions', async () => {
    const { map, inner } = handlers();
    const out = guardChildHotWrites(map, true);
    const result = await out.get('memory_update')!({ target: 'fact', action: 'set', content: 'x', category: 'learning' });
    expect(result).toEqual({ content: 'ok' });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the input map and leaves other handlers intact', () => {
    const { map, inner } = handlers();
    const out = guardChildHotWrites(map, true);
    expect(out).not.toBe(map);
    expect(map.get('memory_update')).toBe(inner);
    expect(out.get('memory_search')).toBe(map.get('memory_search'));
  });

  it('is a no-op when memory_update is absent (recon sessions)', () => {
    const map = new Map<string, ToolHandler>([['memory_search', (async () => ({ content: '[]' })) as ToolHandler]]);
    expect(guardChildHotWrites(map, true)).toBe(map);
  });
});

describe('isForkedChildSession', () => {
  it('is false for a top-level session (no signals)', () => {
    expect(isForkedChildSession(undefined, undefined)).toBe(false);
    expect(isForkedChildSession(false, {})).toBe(false);
  });
  it('is true on readOnlyState alone (createChildProviderFactory children)', () => {
    expect(isForkedChildSession(true, {})).toBe(true);
  });
  it('is true on parentSessionId alone (e.g. buildSkillRestrictedProvider children)', () => {
    expect(isForkedChildSession(false, { parentSessionId: 'p' })).toBe(true);
  });
  it('is true on subagentToolOutputCapBytes alone (stub-parent skill forks)', () => {
    expect(isForkedChildSession(undefined, { subagentToolOutputCapBytes: 100_000 })).toBe(true);
  });
});
