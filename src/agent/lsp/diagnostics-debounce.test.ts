import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsStore } from './diagnostics-store.js';
import { DocumentSync } from './document-sync.js';

afterEach(() => vi.useRealTimers());

describe('diagnostics attribution re-review', () => {
  it('debounces unversioned publishes at t and t+150 until the later quiet window', async () => {
    vi.useFakeTimers();
    const store = new DiagnosticsStore();
    const finished = vi.fn();
    const waiting = store.waitFor('u', 2, 0, 1000).then((p) => { finished(p); return p; });
    store.record({ uri: 'u', diagnostics: ['earlier edit'] });
    await vi.advanceTimersByTimeAsync(150);
    store.record({ uri: 'u', diagnostics: ['current edit'] });
    await vi.advanceTimersByTimeAsync(199);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await waiting)?.diagnostics).toEqual(['current edit']);
  });

  it('a continuous unversioned stream cannot extend the original caller deadline', async () => {
    vi.useFakeTimers();
    const store = new DiagnosticsStore();
    const waiting = store.waitFor('u', 2, 0, 300);
    store.record({ uri: 'u', diagnostics: ['one'] });
    await vi.advanceTimersByTimeAsync(150);
    store.record({ uri: 'u', diagnostics: ['two'] });
    await vi.advanceTimersByTimeAsync(149);
    store.record({ uri: 'u', diagnostics: ['three'] });
    await vi.advanceTimersByTimeAsync(1);
    expect((await waiting)?.diagnostics).toEqual(['three']);
  });

  it('keeps versions monotonic through changes and repeated close/reopen cycles', () => {
    const docs = new DocumentSync();
    expect(docs.sync('u', 'typescript', 'one').version).toBe(1);
    expect(docs.sync('u', 'typescript', 'two').version).toBe(2);
    docs.closeAllExcept(new Set());
    expect(docs.openUris()).toEqual([]);
    expect(docs.version('u')).toBe(2);
    expect(docs.sync('u', 'typescript', 'two').version).toBe(3);
    docs.closeAllExcept(new Set());
    const reopened = docs.sync('u', 'typescript', 'three');
    expect(reopened.version).toBe(4);
    expect(reopened.notification).toMatchObject({ method: 'textDocument/didOpen', params: { textDocument: { version: 4 } } });
  });
});
