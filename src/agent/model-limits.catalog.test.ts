import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contextLimitFor, autoCompactLimitFor } from './model-limits.js';
import { loadModelsCatalog } from './providers/openai-compatible/models-catalog.js';
import { contextWindowOverrideFor } from './session/model-slots.js';
vi.mock('./providers/openai-compatible/models-catalog.js', () => ({ loadModelsCatalog: vi.fn() }));
vi.mock('./session/model-slots.js', () => ({ resolveModelInput: (s: string) => s, contextWindowOverrideFor: vi.fn() }));
beforeEach(() => {
  vi.mocked(contextWindowOverrideFor).mockReturnValue(undefined);
  vi.mocked(loadModelsCatalog).mockReturnValue(new Map([['gpt-5.5', { slug: 'gpt-5.5', context_window: 272000, effective_context_window_percent: 95 }]]));
});
describe('path-specific catalog limits', () => {
  it('uses effective subscription window in display and compaction', () => {
    expect(contextLimitFor('gpt-5.5', true)).toBe(258400);
    expect(autoCompactLimitFor('gpt-5.5', true)).toBe(258400);
  });
  it('leaves the API-key static window unchanged', () => expect(contextLimitFor('gpt-5.5')).toBe(1000000));
  it('prefers explicit slot override', () => {
    vi.mocked(contextWindowOverrideFor).mockReturnValue(123456);
    expect(contextLimitFor('gpt-5.5', true)).toBe(123456);
  });
  it('falls back when absent or slug missing', () => {
    vi.mocked(loadModelsCatalog).mockReturnValue(new Map());
    expect(contextLimitFor('gpt-5.5', true)).toBe(1000000);
    expect(contextLimitFor('gpt-unknown', true)).toBe(contextLimitFor('gpt-unknown'));
  });
  it('rejects malformed percentages', () => {
    vi.mocked(loadModelsCatalog).mockReturnValue(new Map([['gpt-5.5', { slug: 'gpt-5.5', context_window: 272000, effective_context_window_percent: 101 }]]));
    expect(contextLimitFor('gpt-5.5', true)).toBe(1000000);
  });
});
