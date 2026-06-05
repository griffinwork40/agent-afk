import { describe, it, expect, vi } from 'vitest';
import { OverlayComposer, type OverlaySlot, type OverlaySink } from './overlay-composer.js';

function makeSink(): OverlaySink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setOverlay(text: string) {
      calls.push(text);
    },
  };
}

/** A slot whose content is a mutable cell, so tests can change it between flushes. */
function slot(key: string, initial = ''): OverlaySlot & { value: string } {
  const s = {
    key,
    value: initial,
    render() {
      return s.value;
    },
  };
  return s;
}

describe('OverlayComposer', () => {
  const ORDER = ['stage-rail', 'thinking-live', 'markdown-pending', 'tool-lane', 'progress-banner'];

  it('composes active slots in fixed z-order with a single setOverlay call', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    // Register out of order to prove `order` (not registration) drives layout.
    c.register(slot('tool-lane', 'TREE'));
    c.register(slot('stage-rail', 'RAIL'));
    c.register(slot('progress-banner', 'BANNER'));

    c.flush();

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toBe('RAIL\nTREE\nBANNER');
  });

  it('drops empty slots so an inactive producer leaves no blank line', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    c.register(slot('stage-rail', 'RAIL'));
    c.register(slot('thinking-live', '')); // inactive
    c.register(slot('tool-lane', 'TREE'));

    c.flush();

    expect(sink.calls[0]).toBe('RAIL\nTREE');
  });

  it('never shows a registered slot whose key is absent from order', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    c.register(slot('tool-lane', 'TREE'));
    c.register(slot('not-in-order', 'GHOST'));

    c.flush();

    expect(sink.calls[0]).toBe('TREE');
    expect(sink.calls[0]).not.toContain('GHOST');
  });

  it('does not call setOverlay when nothing is dirty since the last flush', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    c.register(slot('tool-lane', 'TREE'));

    c.flush(); // dirty from register -> 1 call
    c.flush(); // nothing changed -> no call
    c.flush();

    expect(sink.calls).toHaveLength(1);
  });

  it('markDirty for an unknown key does not trigger a recomposition', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    c.register(slot('tool-lane', 'TREE'));
    c.flush(); // 1 call
    sink.calls.length = 0;

    c.markDirty('no-such-slot');
    c.flush();

    expect(sink.calls).toHaveLength(0);
  });

  it('coalesces multiple markDirty calls into a single setOverlay per flush', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    const tree = slot('tool-lane', 'TREE');
    const md = slot('markdown-pending', 'PARA');
    c.register(tree);
    c.register(md);
    c.flush(); // initial
    sink.calls.length = 0;

    // Simulate two sources updating in the same event-loop turn.
    tree.value = 'TREE2';
    c.markDirty('tool-lane');
    md.value = 'PARA2';
    c.markDirty('markdown-pending');
    c.flush();

    expect(sink.calls).toHaveLength(1);
    // Both updated view-models present — the race the composer exists to fix.
    expect(sink.calls[0]).toBe('PARA2\nTREE2');
  });

  it('reflects a slot toggling inactive -> active across flushes', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    const thinking = slot('thinking-live', '');
    c.register(slot('tool-lane', 'TREE'));
    c.register(thinking);
    c.flush();
    expect(sink.calls[0]).toBe('TREE');

    thinking.value = 'thinking…';
    c.markDirty('thinking-live');
    c.flush();

    expect(sink.calls[1]).toBe('thinking…\nTREE');
  });

  it('invalidate() forces a recompose even with no markDirty', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    const s = slot('tool-lane', 'TREE');
    c.register(s);
    c.flush();
    sink.calls.length = 0;

    // e.g. a terminal resize: content unchanged but width did.
    c.invalidate();
    c.flush();

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toBe('TREE');
  });

  it('register replaces an existing slot under the same key', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    c.register(slot('tool-lane', 'OLD'));
    c.register(slot('tool-lane', 'NEW'));
    c.flush();
    expect(sink.calls[0]).toBe('NEW');
  });

  it('emits an empty overlay (clears) when all slots go inactive', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    const tree = slot('tool-lane', 'TREE');
    c.register(tree);
    c.flush();

    tree.value = '';
    c.markDirty('tool-lane');
    c.flush();

    expect(sink.calls[1]).toBe('');
  });

  it('does not render slots eagerly — render() is only called on flush', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, ORDER);
    const render = vi.fn(() => 'X');
    c.register({ key: 'tool-lane', render });
    expect(render).not.toHaveBeenCalled();
    c.flush();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('composes an interrupt slot last (bottom-most), below progress-banner', () => {
    const sink = makeSink();
    const c = new OverlayComposer(sink, [...ORDER, 'interrupt']);
    c.register(slot('progress-banner', 'BANNER'));
    c.register(slot('interrupt', 'INT'));
    c.flush();
    expect(sink.calls[0]).toBe('BANNER\nINT');
  });
});
