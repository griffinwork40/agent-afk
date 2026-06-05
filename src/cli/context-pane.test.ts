/**
 * Tests for the pre-prompt context pane.
 *
 * Uses the injection hooks (`load`, `onResize`) to avoid touching the
 * filesystem or the real ResizeBus. The pane should:
 *   - Print the panel the first time non-empty todos appear for a session.
 *   - Dedupe identical content across consecutive prompts.
 *   - Re-paint when content changes (add/mark/remove).
 *   - Re-paint on resize.
 *   - Treat missing sessionId as the `unbound` bucket (matches /todo slash).
 *   - Dispose cleanly.
 */

import { describe, expect, it, vi } from 'vitest';
import { createContextPane } from './commands/interactive/context-pane.js';
import type { TodoStore } from './todo-panel.js';

function fakeLoad(stores: Record<string, TodoStore>) {
  return (sessionId: string): TodoStore => {
    return stores[sessionId] ?? { sessionId, items: [] };
  };
}

function makeResizeHook() {
  let fn: (() => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((cb: () => void) => {
    fn = cb;
    return unsubscribe;
  });
  return {
    onResize: subscribe,
    fireResize() {
      if (fn) fn();
    },
    unsubscribe,
  };
}

describe('createContextPane', () => {
  it('returns [] when the todo store is empty', () => {
    const pane = createContextPane({
      load: fakeLoad({ s1: { sessionId: 's1', items: [] } }),
      onResize: () => () => undefined,
    });
    expect(pane.renderIfChanged('s1')).toEqual([]);
  });

  it('paints the panel on first non-empty render', () => {
    const pane = createContextPane({
      load: fakeLoad({
        s1: { sessionId: 's1', items: [{ id: 1, text: 'buy milk', done: false, createdAt: 0 }] },
      }),
      onResize: () => () => undefined,
    });

    const lines = pane.renderIfChanged('s1');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('buy milk');
    expect(lines.join('\n')).toContain('#1');
  });

  it('dedupes identical content on the next call', () => {
    const pane = createContextPane({
      load: fakeLoad({
        s1: { sessionId: 's1', items: [{ id: 1, text: 'buy milk', done: false, createdAt: 0 }] },
      }),
      onResize: () => () => undefined,
    });

    expect(pane.renderIfChanged('s1').length).toBeGreaterThan(0);
    expect(pane.renderIfChanged('s1')).toEqual([]);
    expect(pane.renderIfChanged('s1')).toEqual([]);
  });

  it('re-paints when an item is added', () => {
    const store: TodoStore = { sessionId: 's1', items: [] };
    const pane = createContextPane({
      load: (id) => (id === 's1' ? store : { sessionId: id, items: [] }),
      onResize: () => () => undefined,
    });

    expect(pane.renderIfChanged('s1')).toEqual([]);

    store.items.push({ id: 1, text: 'alpha', done: false, createdAt: 0 });
    const first = pane.renderIfChanged('s1');
    expect(first.join('\n')).toContain('alpha');

    expect(pane.renderIfChanged('s1')).toEqual([]);

    store.items.push({ id: 2, text: 'beta', done: false, createdAt: 0 });
    const second = pane.renderIfChanged('s1');
    expect(second.join('\n')).toContain('beta');
    expect(second.join('\n')).toContain('alpha');
  });

  it('re-paints when an item flips done', () => {
    const store: TodoStore = {
      sessionId: 's1',
      items: [{ id: 1, text: 'write tests', done: false, createdAt: 0 }],
    };
    const pane = createContextPane({
      load: () => store,
      onResize: () => () => undefined,
    });

    expect(pane.renderIfChanged('s1').length).toBeGreaterThan(0);
    expect(pane.renderIfChanged('s1')).toEqual([]);

    store.items[0]!.done = true;
    expect(pane.renderIfChanged('s1').length).toBeGreaterThan(0);
  });

  it('re-paints after a resize event', () => {
    const resize = makeResizeHook();
    const pane = createContextPane({
      load: fakeLoad({
        s1: { sessionId: 's1', items: [{ id: 1, text: 'x', done: false, createdAt: 0 }] },
      }),
      onResize: resize.onResize,
    });

    expect(pane.renderIfChanged('s1').length).toBeGreaterThan(0);
    expect(pane.renderIfChanged('s1')).toEqual([]);

    resize.fireResize();
    expect(pane.renderIfChanged('s1').length).toBeGreaterThan(0);
  });

  it('treats missing sessionId as the `unbound` bucket', () => {
    const load = vi.fn((id: string) => ({ sessionId: id, items: [] }));
    const pane = createContextPane({
      load,
      onResize: () => () => undefined,
    });

    pane.renderIfChanged(undefined);
    expect(load).toHaveBeenCalledWith('unbound');
  });

  it('invalidate() forces the next call to re-paint', () => {
    const pane = createContextPane({
      load: fakeLoad({
        s1: { sessionId: 's1', items: [{ id: 1, text: 'one', done: false, createdAt: 0 }] },
      }),
      onResize: () => () => undefined,
    });

    expect(pane.renderIfChanged('s1').length).toBeGreaterThan(0);
    expect(pane.renderIfChanged('s1')).toEqual([]);

    pane.invalidate();
    expect(pane.renderIfChanged('s1').length).toBeGreaterThan(0);
  });

  it('dispose() calls the resize unsubscribe once', () => {
    const resize = makeResizeHook();
    const pane = createContextPane({
      load: fakeLoad({}),
      onResize: resize.onResize,
    });

    pane.dispose();
    expect(resize.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('dispose() is idempotent-ish — a second call does not throw', () => {
    const unsubscribe = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
      throw new Error('already gone');
    });
    const pane = createContextPane({
      load: fakeLoad({}),
      onResize: () => unsubscribe,
    });
    pane.dispose();
    expect(() => pane.dispose()).not.toThrow();
  });
});
