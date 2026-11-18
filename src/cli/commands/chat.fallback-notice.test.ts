import { describe, expect, it } from 'vitest';
import type { OutputEvent } from '../../agent/types/session-types.js';
import { collectFallbackNotice } from './chat.fallback-notice.js';

const notice: OutputEvent = {
  type: 'notice', kind: 'model-fallback', text: 'Switched to sonnet.',
  fallback: { from: 'opus', to: 'sonnet', reason: 'usage-limit' },
};

function sessionWith(events: OutputEvent[], onClose: () => void) {
  return {
    async *getOutputStream(): AsyncIterable<OutputEvent> {
      try {
        yield* events;
      } finally {
        onClose();
      }
    },
  };
}

describe('collectFallbackNotice error paths', () => {
  it('retains the notice and closes the stream at an error event without waiting for done', async () => {
    let closed = false;
    const session = sessionWith([
      notice,
      { type: 'error', error: 'fallback credential error' },
      { ...notice, text: 'must not collect after error' },
    ], () => { closed = true; });

    await expect(collectFallbackNotice(session, Promise.resolve())).resolves.toEqual({
      text: notice.text, fallback: notice.fallback,
    });
    expect(closed).toBe(true);
  });

  it('returns no notice when the stream errors before a switch', async () => {
    const session = sessionWith([
      { type: 'error', error: 'primary error' }, notice,
    ], () => {});
    await expect(collectFallbackNotice(session, Promise.resolve())).resolves.toBeUndefined();
  });

  it('propagates a stream iteration failure', async () => {
    const failure = new Error('output stream failed');
    const session = {
      async *getOutputStream(): AsyncIterable<OutputEvent> {
        yield notice;
        throw failure;
      },
    };
    await expect(collectFallbackNotice(session, Promise.resolve())).rejects.toBe(failure);
  });

  it('preserves the send failure even when the stream has captured a notice', async () => {
    const failure = new Error('send failed');
    const session = sessionWith([notice, { type: 'error', error: failure.message }], () => {});
    await expect(collectFallbackNotice(session, Promise.reject(failure))).rejects.toBe(failure);
  });
});
