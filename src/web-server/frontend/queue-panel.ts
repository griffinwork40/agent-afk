/**
 * The mid-run message queue: its rendering, its reorder controls, and the
 * one-at-a-time drain that gives it a reason to exist.
 *
 * Contract: this module owns the queue ARRAY and nothing else. It reaches the
 * rest of the app through the injected {@link QueuePanelDeps} — `isLive` and
 * `isTurnActive` are read as functions rather than captured as values because
 * both change underneath a long-lived panel (session switch, turn boundary),
 * and a snapshot taken at wire-up time would be stale by the first flush.
 *
 * Extracted from `app.ts`, which was over the repo's 350-line ceiling; the
 * queue/composer block was the seam with the fewest edges back into it.
 */

import { moveDown, moveUp, removeAt } from './queue-reorder.js';
import { notifyValueChanged } from './composer-value.js';

export interface QueuePanelDeps {
  /** Container for the queued-message rows. */
  container: HTMLElement;
  /** The composer textarea. */
  input: HTMLTextAreaElement;
  /** The send button. */
  send: HTMLElement;
  /** POST one prompt; must REJECT unless the server accepted it. */
  submit: (text: string) => Promise<void>;
  /** Whether the active session can be driven from this process. */
  isLive: () => boolean;
  /** Whether a turn is already running — the gate the drain waits on. */
  isTurnActive: () => boolean;
  /** Called after a prompt is accepted, so the app can mark the turn active. */
  onAccepted: () => void;
  /** Surface a failed send to the user. */
  onError: (message: string) => void;
}

export class QueuePanel {
  private queue: string[] = [];
  /** Guards against two concurrent drains racing on the same entry. */
  private flushing = false;

  constructor(private readonly deps: QueuePanelDeps) {}

  /** Current queue contents (copy — callers must not mutate the internal array). */
  entries(): readonly string[] {
    return [...this.queue];
  }

  /** Drop everything, e.g. when the operator switches session. */
  clear(): void {
    this.queue = [];
    this.render();
  }

  wire(): void {
    const submit = (): void => {
      const text = this.deps.input.value.trim();
      if (!text) return;
      this.queue = [...this.queue, text];
      this.deps.input.value = '';
      // The mirror is the only visible copy of the composer text, and it
      // repaints on `input` — which a programmatic clear does not fire. Without
      // this the sent prompt stays on screen after the textarea is emptied.
      notifyValueChanged(this.deps.input);
      this.render();
      void this.flush();
    };
    this.deps.send.addEventListener('click', submit);
    this.deps.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    });
  }

  render(): void {
    const container = this.deps.container;
    container.textContent = '';
    this.queue.forEach((text, i) => {
      const row = document.createElement('div');
      row.className = 'queue-row';
      const label = document.createElement('span');
      label.className = 'queue-text';
      label.textContent = text;
      row.appendChild(label);
      for (const [glyph, fn] of [
        ['↑', (): void => { this.queue = moveUp(this.queue, i); }],
        ['↓', (): void => { this.queue = moveDown(this.queue, i); }],
        ['✕', (): void => { this.queue = removeAt(this.queue, i); }],
      ] as const) {
        const btn = document.createElement('button');
        btn.className = 'queue-btn';
        btn.textContent = glyph;
        btn.addEventListener('click', () => {
          fn();
          this.render();
        });
        row.appendChild(btn);
      }
      container.appendChild(row);
    });
  }

  /**
   * Send at most ONE queued entry, then stop.
   *
   * Invariant: this is a queue, not a write-through, and the one-at-a-time
   * limit is the whole difference. `POST /prompt` answers 202 on ACCEPTANCE,
   * not completion — it chains the turn and returns — so a `while (queue.length)`
   * drain emptied the list within a single localhost round-trip. Every entry
   * the operator typed mid-run was gone before it rendered, which made the
   * reorder controls unreachable and the advertised "mid-run message queue"
   * behave as a plain send loop. Holding the rest until the turn's terminal
   * `done`/`error` record arrives is what lets an entry dwell in the list long
   * enough to be reordered or dropped.
   *
   * Invariant: the entry leaves the queue only after its POST is CONFIRMED.
   * Dequeuing first destroyed the user's typed prompt on any transient network
   * error, 5xx, or expired token — the caller's catch only writes status text,
   * so there was nothing left to retry or reorder. Holding the entry until
   * success is also what the repo's no-optimistic-rendering rule requires: no
   * UI update ahead of its dependent write's result.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (!this.deps.isLive()) return;
    if (this.deps.isTurnActive()) return;
    const next = this.queue[0];
    if (next === undefined) return;

    this.flushing = true;
    try {
      await this.deps.submit(next);
      this.queue = this.queue.slice(1);
      this.render();
      this.deps.onAccepted();
    } catch (err: unknown) {
      this.deps.onError(err instanceof Error ? err.message : 'send failed');
    } finally {
      this.flushing = false;
    }
  }
}
