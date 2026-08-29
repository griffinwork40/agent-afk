/**
 * Tests for createEditPreviewHook — pre-execution diff preview hook.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEditPreviewHook } from './edit-preview-hook.js';
import type { DiffPayload } from '../../../utils/diff.js';
import type { PreToolUseContext } from '../../hooks.js';

function makeCtx(overrides: Partial<PreToolUseContext> = {}): PreToolUseContext {
  return {
    event: 'PreToolUse',
    toolName: 'edit_file',
    input: { old_string: 'a', new_string: 'b', file_path: 'foo.ts' },
    toolUseId: 'tu_001',
    ...overrides,
  };
}

describe('createEditPreviewHook', () => {
  it('(a) fires callback with DiffPayload for a normal edit', () => {
    const cb = vi.fn();
    const ref = { current: cb };
    const hook = createEditPreviewHook({ addPreviewDiffRef: ref });
    const decision = hook(makeCtx());
    expect(cb).toHaveBeenCalledOnce();
    const [id, diff] = cb.mock.calls[0] as [string, DiffPayload];
    expect(id).toBe('tu_001');
    expect(diff.hunks.length).toBeGreaterThan(0);
    expect(decision).toEqual({});
  });

  it('(b) no-op when old_string === new_string', () => {
    const cb = vi.fn();
    const hook = createEditPreviewHook({ addPreviewDiffRef: { current: cb } });
    hook(makeCtx({ input: { old_string: 'same', new_string: 'same', file_path: 'x.ts' } }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('(c) skips subagents (parentSessionId set)', () => {
    const cb = vi.fn();
    const hook = createEditPreviewHook({ addPreviewDiffRef: { current: cb } });
    hook(makeCtx({ parentSessionId: 'parent-sess' }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('(d) skips non-edit_file tools', () => {
    const cb = vi.fn();
    const hook = createEditPreviewHook({ addPreviewDiffRef: { current: cb } });
    hook(makeCtx({ toolName: 'bash' }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('(e) skips non-PreToolUse events', () => {
    const cb = vi.fn();
    const hook = createEditPreviewHook({ addPreviewDiffRef: { current: cb } });
    // Cast to satisfy type — hook must guard event at runtime
    hook({ event: 'PostToolUse', toolName: 'edit_file' } as any);
    expect(cb).not.toHaveBeenCalled();
  });

  it('(f) returned decision has no injectContext', () => {
    const cb = vi.fn();
    const hook = createEditPreviewHook({ addPreviewDiffRef: { current: cb } });
    const decision = hook(makeCtx());
    expect(decision).not.toHaveProperty('injectContext');
  });

  it('(g) no-op when toolUseId absent', () => {
    const cb = vi.fn();
    const hook = createEditPreviewHook({ addPreviewDiffRef: { current: cb } });
    hook(makeCtx({ toolUseId: undefined }));
    expect(cb).not.toHaveBeenCalled();
  });
});
