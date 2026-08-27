/**
 * Invariant under test: the mid-run message queue is a QUEUE, not a
 * write-through.
 *
 * History: `flushQueue` drained every entry in an unconditional
 * `while (queue.length > 0)` loop, and `POST /prompt` answers 202 on
 * ACCEPTANCE rather than completion (it chains the turn and returns). So the
 * list emptied within one localhost round-trip: entries typed mid-run were gone
 * before they rendered, the ↑/↓/✕ reorder controls had nothing to act on, and
 * the PR's headline "mid-run message queue" was a plain send loop. These tests
 * pin the one-per-turn drain and the confirmed-before-dequeue rule that the
 * repo's no-optimistic-rendering convention requires.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { QueuePanel, type QueuePanelDeps } from './queue-panel.js';
import { mountSlashHighlight } from './slash-highlight.js';

interface Harness {
  panel: QueuePanel;
  sent: string[];
  /** Resolve the in-flight POST, as the server accepting it (202). */
  accept: () => void;
  /** Reject the in-flight POST, as a transient failure. */
  reject: (message: string) => void;
  setTurnActive: (v: boolean) => void;
  errors: string[];
  rows: () => string[];
  container: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
}

function harness(overrides: Partial<QueuePanelDeps> = {}): Harness {
  document.body.innerHTML =
    '<div id="queue"></div><textarea id="prompt"></textarea><button id="send"></button>';
  const container = document.getElementById('queue') as HTMLElement;
  const input = document.getElementById('prompt') as HTMLTextAreaElement;
  const send = document.getElementById('send') as HTMLButtonElement;

  const sent: string[] = [];
  const errors: string[] = [];
  let turnActive = false;
  let settle: { resolve: () => void; reject: (e: Error) => void } | undefined;

  const panel = new QueuePanel({
    container,
    input,
    send,
    submit: (text: string) => {
      sent.push(text);
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    isLive: () => true,
    isTurnActive: () => turnActive,
    onAccepted: () => {
      turnActive = true;
    },
    onError: (m) => errors.push(m),
    ...overrides,
  });
  panel.wire();

  return {
    panel,
    sent,
    accept: () => settle?.resolve(),
    reject: (m: string) => settle?.reject(new Error(m)),
    setTurnActive: (v: boolean) => {
      turnActive = v;
    },
    errors,
    rows: () => [...container.querySelectorAll('.queue-text')].map((n) => n.textContent ?? ''),
    container,
    input,
    send,
  };
}

/** Type `text` into the composer and click Send. */
function type(h: Harness, text: string): void {
  h.input.value = text;
  h.send.click();
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('QueuePanel — composer mirror sync', () => {
  // Regression: submit() clears `input.value` programmatically, which fires no
  // `input` event. The slash-highlight mirror is the only visible copy of the
  // composer text (the textarea is painted transparent), so the sent prompt
  // stayed on screen after the textarea had already been emptied.
  it('repaints the mirror after the composer is cleared on send', async () => {
    const h = harness();
    const mirror = document.createElement('div');
    document.body.appendChild(mirror);
    mountSlashHighlight(h.input, mirror, () => false);
    const mirrorText = (): string => (mirror.textContent ?? '').replace(/\u200b/g, '');

    h.input.value = 'a prompt';
    h.input.dispatchEvent(new Event('input'));
    expect(mirrorText()).toBe('a prompt');

    h.send.click();
    await settle();

    expect(h.input.value).toBe('');
    expect(mirrorText()).toBe('');
  });
});

describe('QueuePanel — one entry per turn', () => {
  it('sends only the first entry and holds the rest while a turn runs', async () => {
    const h = harness();
    type(h, 'first');
    await settle();
    h.accept();
    await settle();

    // The turn is now active; further entries must queue, not send.
    type(h, 'second');
    type(h, 'third');
    await settle();

    expect(h.sent).toEqual(['first']);
    expect(h.rows()).toEqual(['second', 'third']);
  });

  it('releases exactly one more entry when the turn ends', async () => {
    const h = harness();
    type(h, 'first');
    await settle();
    h.accept();
    await settle();
    type(h, 'second');
    type(h, 'third');
    await settle();

    // The terminal done/error record arrives -> app clears the gate and flushes.
    h.setTurnActive(false);
    void h.panel.flush();
    await settle();

    // 'second' is on the wire but not yet acknowledged, so it is still listed —
    // the confirmed-before-dequeue rule. Only 'third' remains behind it.
    expect(h.sent).toEqual(['first', 'second']);
    expect(h.rows()).toEqual(['second', 'third']);

    h.accept();
    await settle();
    expect(h.rows()).toEqual(['third']);
  });

  it('queued entries stay reorderable while they dwell', async () => {
    const h = harness();
    type(h, 'first');
    await settle();
    h.accept();
    await settle();
    type(h, 'second');
    type(h, 'third');
    await settle();

    // ↑ on the second row (index 1) — the control the write-through made dead.
    // Button layout per row: [0]=✎ (edit), [1]=↑, [2]=↓, [3]=✕
    const rowButtons = h.container.querySelectorAll('.queue-row')[1]?.querySelectorAll('button');
    (rowButtons?.[1] as HTMLButtonElement).click();
    expect(h.rows()).toEqual(['third', 'second']);

    h.setTurnActive(false);
    void h.panel.flush();
    await settle();
    expect(h.sent).toEqual(['first', 'third']);
  });

  it('does not send while a turn is already active', async () => {
    const h = harness();
    h.setTurnActive(true);
    type(h, 'queued');
    await settle();

    expect(h.sent).toEqual([]);
    expect(h.rows()).toEqual(['queued']);
  });
});

describe('QueuePanel — the entry leaves only after the POST is confirmed', () => {
  it('keeps the entry in the list while the POST is in flight', async () => {
    const h = harness();
    type(h, 'pending');
    await settle();

    expect(h.sent).toEqual(['pending']);
    // Not yet acknowledged — no optimistic dequeue.
    expect(h.rows()).toEqual(['pending']);

    h.accept();
    await settle();
    expect(h.rows()).toEqual([]);
  });

  it('restores nothing and drops nothing when the POST fails', async () => {
    const h = harness();
    type(h, 'fragile');
    await settle();
    h.reject('503 upstream');
    await settle();

    expect(h.rows()).toEqual(['fragile']);
    expect(h.errors).toEqual(['503 upstream']);
  });

  it('is a no-op on a read-only session', async () => {
    const h = harness({ isLive: () => false });
    type(h, 'nope');
    await settle();
    expect(h.sent).toEqual([]);
  });

  it('does not double-send when flush is re-entered mid-flight', async () => {
    const h = harness();
    type(h, 'once');
    await settle();
    void h.panel.flush();
    void h.panel.flush();
    await settle();
    expect(h.sent).toEqual(['once']);
  });

  it('clear() empties the list and its rendering', async () => {
    const h = harness();
    h.setTurnActive(true);
    type(h, 'a');
    type(h, 'b');
    await settle();
    expect(h.rows()).toEqual(['a', 'b']);

    h.panel.clear();
    expect(h.rows()).toEqual([]);
    expect(h.panel.entries()).toEqual([]);
  });

  it('ignores an empty or whitespace-only composer', async () => {
    const h = harness();
    type(h, '   ');
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.rows()).toEqual([]);
  });

  it('renders queued text as TEXT, never as markup', async () => {
    const h = harness();
    h.setTurnActive(true);
    type(h, '<img src=x onerror=alert(1)>');
    await settle();
    expect(h.container.querySelector('img')).toBeNull();
    expect(h.rows()).toEqual(['<img src=x onerror=alert(1)>']);
  });

  it('sends on Cmd/Ctrl+Enter as well as the button', async () => {
    const h = harness();
    h.input.value = 'via keyboard';
    h.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    await settle();
    expect(h.sent).toEqual(['via keyboard']);
  });
});

describe('QueuePanel — reorder helpers are wired to the rendered controls', () => {
  it('✕ removes the row it belongs to', async () => {
    const h = harness();
    h.setTurnActive(true);
    type(h, 'a');
    type(h, 'b');
    await settle();

    // Button layout per row: [0]=✎ (edit), [1]=↑, [2]=↓, [3]=✕
    const buttons = h.container.querySelectorAll('.queue-row')[0]?.querySelectorAll('button');
    (buttons?.[3] as HTMLButtonElement).click();
    expect(h.rows()).toEqual(['b']);
  });

  it('↓ moves a row later in the list', async () => {
    const h = harness();
    h.setTurnActive(true);
    type(h, 'a');
    type(h, 'b');
    await settle();

    // Button layout per row: [0]=✎ (edit), [1]=↑, [2]=↓, [3]=✕
    const buttons = h.container.querySelectorAll('.queue-row')[0]?.querySelectorAll('button');
    (buttons?.[2] as HTMLButtonElement).click();
    expect(h.rows()).toEqual(['b', 'a']);
  });

  it('entries() returns a copy the caller cannot mutate into the panel', async () => {
    const h = harness();
    h.setTurnActive(true);
    type(h, 'a');
    await settle();
    const copy = h.panel.entries() as string[];
    copy.push('injected');
    expect(h.panel.entries()).toEqual(['a']);
    expect(vi.isMockFunction(h.panel.flush)).toBe(false);
  });
});
