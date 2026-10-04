/**
 * Tests for the peer inter-round boundary delivery wiring.
 *
 * Covers:
 *  - installPeerBoundary: human priority, peer fallback, barrier, compose
 *  - reinstallPeerBoundary: clears queue and re-installs on new session
 *  - Fake provider integration: both Anthropic and OpenAI applyBeforeNextRound
 *  - REPL adapter integration: connected, not just isolated queue unit tests
 *
 * No paid model calls — all providers are faked with in-process callbacks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdmissionQueue } from '../../../agent/peer/admission-queue.js';
import { installPeerBoundary, reinstallPeerBoundary } from './loop-iteration.boundary.js';

// ── Minimal fakes ────────────────────────────────────────────────────────────

/**
 * Fake PeerInboxNotifier that wraps a string array. Each string in `buffered`
 * represents one peer envelope's body. The fake exposes the full interface
 * that boundary.ts uses: `hasPendingInjections`, `peekEnvelopes`,
 * `consumeEnvelopes`, `drainInjections`, and `reclaim`.
 *
 * `peekEnvelopes` returns a readonly array of fake BufferedClaim-shaped objects
 * whose `envelope.from.id` is a stable per-entry sender id derived from the
 * entry's position in the original buffer, and whose `envelope.body` is the
 * text itself. `consumeEnvelopes(n)` removes the first n entries, mimicking
 * the transactional peek/consume semantics.
 */
function makePeerNotifier(buffered: string[] = []) {
  // Assign stable sender ids per entry (id is the index at push time).
  // We store entries as { text, senderId } tuples so `peekEnvelopes` can
  // return a stable senderId that survives partial consumption.
  const entries: Array<{ text: string; senderId: string }> = buffered.map((t, i) => ({
    text: t,
    senderId: `fake-sender-${i}`,
  }));
  // Sync the entries array when the caller mutates the `buffered` array via
  // `buffered.push(...)`. We track a cursor so new pushes append new entries.
  let lastSynced = entries.length;
  const syncFromBuffered = () => {
    // Rebuild entries from buffered when buffered has grown (tests push to it).
    // We track the original buffered reference; only new entries (past lastSynced
    // in the CURRENT buffered state) are appended.
    const currentLen = buffered.length;
    for (let i = lastSynced; i < currentLen; i++) {
      entries.push({ text: buffered[i]!, senderId: `fake-sender-${entries.length}` });
    }
    lastSynced = currentLen;
  };

  const fake = {
    hasPendingInjections: () => { syncFromBuffered(); return entries.length > 0; },
    peekEnvelopes: () => {
      syncFromBuffered();
      // Return fake BufferedClaim-shaped objects matching what boundary.ts reads:
      // { envelope: { from: { id }, body, ... } }
      return entries.map((e) => ({
        envelope: {
          from: { id: e.senderId },
          body: e.text,
          // renderPeerMessageBlock is imported in boundary.ts but boundary tests
          // use a fake notifier, so boundary calls renderPeerMessageBlock(envelope).
          // The rendered output just needs to contain the text. In the test fake
          // we store the text as the body; renderPeerMessageBlock will wrap it.
          // Provide the minimal PeerEnvelope fields renderPeerMessageBlock needs:
          v: 1 as const,
          messageId: `msg-${e.senderId}`,
          to: 'fake-to',
          hop: 0,
          ts: new Date().toISOString(),
        },
        sessionId: 'fake-session',
      }));
    },
    consumeEnvelopes: (count: number) => {
      syncFromBuffered();
      if (count <= 0 || entries.length === 0) return '';
      const consumed = entries.splice(0, count);
      // Keep buffered in sync (remove the first count entries from buffered too).
      buffered.splice(0, count);
      lastSynced = Math.max(0, lastSynced - count);
      return consumed.map((e) => e.text).join('\n\n') + '\n\n';
    },
    drainInjections: () => {
      syncFromBuffered();
      return fake.consumeEnvelopes(entries.length);
    },
    reclaim: async () => { entries.splice(0); buffered.splice(0); lastSynced = 0; return 0; },
  };
  return fake;
}

/**
 * Fake compositor that mirrors the real BoundaryCompositor interface.
 *
 * `hasPendingSubmission` returns true when there is any queued payload
 * (text or attachment), mirroring the real compositor semantics:
 *   - text-only payloads → hasPendingSubmission=true, peekQueuedText returns text
 *   - attachment-bearing payloads → hasPendingSubmission=true, peekQueuedText=undefined
 *   - no payloads → hasPendingSubmission=false, peekQueuedText=undefined
 *
 * Use `makeCompositorWithAttachment()` to simulate an image/attachment payload
 * where hasPendingSubmission=true but peekQueuedText=undefined.
 */
function makeCompositor(queuedText?: string) {
  const payloads = queuedText !== undefined ? [{ id: 'p1' }] : [];
  const reservations = new Set<unknown>();
  const dropped: unknown[] = [];
  return {
    hasPendingSubmission: () => payloads.length > 0 && !payloads.every((p) => reservations.has(p)),
    peekQueuedText: () =>
      queuedText !== undefined
        ? { text: queuedText, preview: queuedText, payloads }
        : undefined,
    reserveQueued: (snap: { payloads: readonly unknown[] }) => {
      for (const p of snap.payloads) reservations.add(p);
    },
    releaseQueued: (snap: { payloads: readonly unknown[] }) => {
      for (const p of snap.payloads) reservations.delete(p);
    },
    dropQueued: (snap: { payloads: readonly unknown[] }) => {
      dropped.push(...snap.payloads);
      payloads.splice(0); // consumed
      queuedText = undefined; // consumed
      return snap.payloads.length;
    },
    _reservations: reservations,
    _dropped: dropped,
  };
}

/**
 * Compositor where hasPendingSubmission=true but peekQueuedText=undefined.
 * Simulates a payload that contains an image attachment or slash command
 * with no extractable text (the real compositor returns undefined from
 * peekQueuedText for image-bearing payloads).
 */
function makeCompositorWithAttachment() {
  const attachmentPayload = [{ id: 'attachment-p1', hasImage: true }];
  const reservations = new Set<unknown>();
  return {
    hasPendingSubmission: () => attachmentPayload.length > 0 && !attachmentPayload.every((p) => reservations.has(p)),
    peekQueuedText: () => undefined, // image payload → no extractable text
    reserveQueued: () => {},
    releaseQueued: () => {},
    dropQueued: () => 0,
    _attachmentPayload: attachmentPayload,
  };
}

function makeSession() {
  let callback: (() => string | undefined) | undefined;
  return {
    setBeforeNextRound: vi.fn((cb: (() => string | undefined) | undefined) => {
      callback = cb;
    }),
    invokeCallback: () => callback?.(),
    getCallback: () => callback,
  };
}

// ── installPeerBoundary ──────────────────────────────────────────────────────

describe('installPeerBoundary', () => {
  let admissionQueue: AdmissionQueue;

  beforeEach(() => {
    admissionQueue = new AdmissionQueue();
  });

  it('installs setBeforeNextRound on session', () => {
    const session = makeSession();
    const peerNotifier = makePeerNotifier();
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });
    expect(session.setBeforeNextRound).toHaveBeenCalledOnce();
    expect(session.getCallback()).toBeTypeOf('function');
  });

  it('returns undefined when neither human nor peer messages are present', () => {
    const session = makeSession();
    const peerNotifier = makePeerNotifier();
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });
    expect(session.invokeCallback()).toBeUndefined();
  });

  it('returns peer text when only peer messages are present', () => {
    const session = makeSession();
    const peerNotifier = makePeerNotifier(['peer message A']);
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });
    const result = session.invokeCallback();
    expect(result).toContain('peer message A');
  });

  it('returns human text when only human messages are queued in compositor', () => {
    const session = makeSession();
    const compositor = makeCompositor('user typed this');
    const peerNotifier = makePeerNotifier();
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });
    const result = session.invokeCallback();
    expect(result).toBe('user typed this');
    // Must have consumed from compositor (dropQueued called).
    expect(compositor._dropped).toHaveLength(1);
  });

  it('human text wins over peer text (barrier)', () => {
    const session = makeSession();
    const compositor = makeCompositor('user typed this');
    const peerNotifier = makePeerNotifier(['peer message']);
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });
    const result = session.invokeCallback();
    // Only human text returned first.
    expect(result).toBe('user typed this');
    expect(result).not.toContain('peer message');
    // hasPendingSubmission=true blocked peer injection — peer stays in the
    // notifier buffer (NOT drained into the admission queue). On the second
    // invocation, the human queue is empty so the barrier lifts and peer
    // is admitted from the notifier buffer.
    const result2 = session.invokeCallback();
    expect(result2).toContain('peer message');
  });

  it('drain is idempotent — second call with empty queue returns undefined', () => {
    const session = makeSession();
    const peerNotifier = makePeerNotifier(['msg']);
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });
    session.invokeCallback(); // drains msg
    expect(session.invokeCallback()).toBeUndefined();
  });

  it('disposer clears the callback on session', () => {
    const session = makeSession();
    const peerNotifier = makePeerNotifier();
    const dispose = installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });
    dispose();
    // setBeforeNextRound called with undefined to remove it.
    const calls = session.setBeforeNextRound.mock.calls;
    expect(calls[calls.length - 1]![0]).toBeUndefined();
  });

  it('callback returns undefined when compositor is null (non-TTY)', () => {
    const session = makeSession();
    const peerNotifier = makePeerNotifier();
    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });
    expect(session.invokeCallback()).toBeUndefined();
  });
});

// ── reinstallPeerBoundary ────────────────────────────────────────────────────

describe('reinstallPeerBoundary', () => {
  it('clears admission queue and installs on new session', () => {
    const admissionQueue = new AdmissionQueue();
    admissionQueue.submitPeer('old-session-sender', 'stale message');
    expect(admissionQueue.size).toBe(1);

    const newSession = makeSession();
    const peerNotifier = makePeerNotifier();
    reinstallPeerBoundary(
      {
        getSession: () => newSession,
        getCompositor: () => null,
        peerNotifier: peerNotifier as never,
        admissionQueue,
      },
      undefined,
    );
    // Queue cleared.
    expect(admissionQueue.size).toBe(0);
    // New session has callback.
    expect(newSession.setBeforeNextRound).toHaveBeenCalled();
  });

  it('calls prevDispose before re-installing', () => {
    const admissionQueue = new AdmissionQueue();
    const disposed = { called: false };
    const prevDispose = () => { disposed.called = true; };

    const newSession = makeSession();
    const peerNotifier = makePeerNotifier();
    reinstallPeerBoundary(
      {
        getSession: () => newSession,
        getCompositor: () => null,
        peerNotifier: peerNotifier as never,
        admissionQueue,
      },
      prevDispose,
    );
    expect(disposed.called).toBe(true);
  });
});

// ── Fake provider integration ────────────────────────────────────────────────
// These tests simulate what the real Anthropic and OpenAI inter-round hooks do:
// call the stored callback and inject the result into the message history.

describe('Fake Anthropic provider integration', () => {
  it('injects human queued message before next model request', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const compositor = makeCompositor('user mid-turn text');
    const peerNotifier = makePeerNotifier();

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // Simulate provider loop: tool batch completed, ask for steering text.
    const steeringText = session.invokeCallback();
    expect(steeringText).toBe('user mid-turn text');

    // Simulate applyBeforeNextRound (Anthropic): push new user turn.
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
    ];
    if (steeringText) {
      messages.push({ role: 'user', content: [{ type: 'text', text: steeringText }] });
    }
    expect(messages).toHaveLength(2);
    expect((messages[1]!.content as Array<{ type: string; text: string }>)[0]!.text).toBe('user mid-turn text');
  });

  it('injects peer message when no human queued message', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const peerNotifier = makePeerNotifier(['peer says hello']);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    const steeringText = session.invokeCallback();
    expect(steeringText).toBeDefined();
    expect(steeringText).toContain('peer says hello');
  });

  it('human queued message blocks peer during same boundary', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const compositor = makeCompositor('user typed something');
    const peerNotifier = makePeerNotifier(['peer message X']);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // First boundary: human wins.
    const text1 = session.invokeCallback();
    expect(text1).toBe('user typed something');
    expect(text1).not.toContain('peer message X');

    // Second boundary: peer is now admitted (human queue empty).
    const text2 = session.invokeCallback();
    expect(text2).toBeDefined();
    expect(text2).toContain('peer message X');
  });

  it('no duplicate: boundary consumed message is not re-delivered', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const peerNotifier = makePeerNotifier(['once only']);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    const first = session.invokeCallback();
    expect(first).toContain('once only');
    const second = session.invokeCallback();
    expect(second).toBeUndefined(); // consumed exactly once
  });
});

describe('Fake OpenAI provider integration', () => {
  it('injects human message at tool boundary', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const compositor = makeCompositor('openai user queued msg');
    const peerNotifier = makePeerNotifier();

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // Simulate OpenAI provider: it calls setBeforeNextRound callback.
    const steeringText = session.invokeCallback();
    expect(steeringText).toBe('openai user queued msg');

    // Simulate OpenAI applyBeforeNextRound: append to priorTurns.
    const priorTurns: Array<{ role: string; content: unknown }> = [
      { role: 'tool', content: 'tool result content' },
    ];
    if (steeringText) {
      priorTurns.push({ role: 'user', content: steeringText });
    }
    expect(priorTurns).toHaveLength(2);
    expect(priorTurns[1]!.content).toBe('openai user queued msg');
  });

  it('peer message from notifier buffer injected for OpenAI path', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const peerNotifier = makePeerNotifier(['peer for openai session']);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    const steeringText = session.invokeCallback();
    expect(steeringText).toContain('peer for openai session');
  });
});

// ── REPL adapter integration ─────────────────────────────────────────────────
// Proves the boundary is CONNECTED (not just an isolated queue unit test).
// Simulates the full loop-iteration wiring: session swap + rekey clears queue.

describe('REPL adapter integration', () => {
  it('reinstall clears old-session peer entries and re-installs on new session', () => {
    const admissionQueue = new AdmissionQueue();
    const oldSession = makeSession();
    const newSession = makeSession();
    let currentSession: ReturnType<typeof makeSession> = oldSession;
    const peerNotifier = makePeerNotifier();

    const opts = {
      getSession: () => currentSession,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    };

    // Install on old session.
    let dispose = installPeerBoundary(opts);

    // Simulate old session receiving a peer message.
    admissionQueue.submitPeer('old-sender', 'old message');
    expect(admissionQueue.size).toBe(1);

    // /resume swap: switch session pointer, reinstall.
    currentSession = newSession;
    dispose = reinstallPeerBoundary(opts, dispose);

    // Queue cleared — old message is gone.
    expect(admissionQueue.size).toBe(0);

    // New session has the callback.
    expect(newSession.setBeforeNextRound).toHaveBeenCalled();

    // Old session's callback was cleared by dispose.
    const oldCalls = oldSession.setBeforeNextRound.mock.calls;
    expect(oldCalls[oldCalls.length - 1]![0]).toBeUndefined();
  });

  it('newly installed callback delivers fresh peer messages on new session', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    let currentSession: ReturnType<typeof makeSession> = session;
    const peerBuffer: string[] = [];
    const peerNotifier = makePeerNotifier(peerBuffer);

    const opts = {
      getSession: () => currentSession,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    };

    // Reinstall (simulating /resume — buffer is empty at this point so nothing to reclaim).
    reinstallPeerBoundary(opts, undefined);

    // New peer arrives AFTER reinstall.
    peerBuffer.push('msg-after-resume');

    // Should be injected at next boundary.
    const result = session.invokeCallback();
    expect(result).toContain('msg-after-resume');
  });

  it('FIFO ordering preserved across multiple peer batches', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const buffered: string[] = [];
    const peerNotifier = makePeerNotifier(buffered);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // Batch 1.
    buffered.push('first peer');
    const t1 = session.invokeCallback();
    expect(t1).toContain('first peer');

    // Batch 2.
    buffered.push('second peer');
    const t2 = session.invokeCallback();
    expect(t2).toContain('second peer');

    // No cross-contamination.
    expect(t1).not.toContain('second peer');
    expect(t2).not.toContain('first peer');
  });
});

// ── Human barrier: attachments, slash, shell blocking peers ─────────────────
// The barrier is driven by `hasPendingSubmission()` (not `peekQueuedText()`).
// This is critical because peekQueuedText() returns undefined for attachment-
// bearing payloads, so the old approach would have incorrectly allowed peer
// injection past an active human queue when the user had queued an image.

describe('Human barrier — attachment blocking', () => {
  it('peer is BLOCKED when compositor has attachment-bearing payload (hasPendingSubmission=true, peekQueuedText=undefined)', () => {
    // This is the critical regression path: peekQueuedText() returns undefined for
    // images, but hasPendingSubmission() returns true. The boundary must use
    // hasPendingSubmission as the barrier — not peekQueuedText — so the human
    // queue (which includes the pending image payload) blocks peer injection.
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    // Compositor simulating an image attachment: hasPendingSubmission=true but
    // peekQueuedText=undefined (the real compositor behaves this way for images).
    const compositor = makeCompositorWithAttachment();
    const peerNotifier = makePeerNotifier(['peer msg during image upload']);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // MUST be blocked: hasPendingSubmission=true blocks peer even though
    // peekQueuedText=undefined (no text to extract from the attachment).
    // Peer stays in the notifier buffer for the next-turn fallback.
    const result = session.invokeCallback();
    expect(result).toBeUndefined(); // peer blocked by attachment barrier
    // Peer is still in the notifier buffer (not consumed).
    expect(peerNotifier.hasPendingInjections()).toBe(true);
  });

  it('peer is delivered when compositor is null (no human queue at all)', () => {
    // null compositor = non-TTY or no compositor available. No human barrier.
    // Peer should be admitted normally.
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const peerNotifier = makePeerNotifier(['peer msg with no compositor']);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    const result = session.invokeCallback();
    expect(result).toContain('peer msg with no compositor');
  });

  it('peer is blocked when compositor has non-empty text queued (slash/shell text in pendingSubmissions)', () => {
    // A slash command or shell passthrough that ends up in pendingSubmissions
    // will have hasPendingSubmission()=true AND peekQueuedText() returning the text.
    // The boundary treats it the same as any queued human text: human wins, peer waits.
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    // Compositor with queued text (could be a slash command like "/model gpt-4"
    // or a shell passthrough that was queued while streaming).
    const compositor = makeCompositor('/model gpt-4');
    const peerNotifier = makePeerNotifier(['peer wants in']);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // First boundary: hasPendingSubmission=true and peekQueuedText returns text.
    // Human wins; peer waits in notifier buffer.
    const first = session.invokeCallback();
    expect(first).toBe('/model gpt-4');
    expect(first).not.toContain('peer wants in');

    // Second boundary: human queue empty (hasPendingSubmission=false);
    // peer is admitted from the notifier buffer.
    const second = session.invokeCallback();
    expect(second).toContain('peer wants in');
  });

  it('compositor queue is consumed exactly once (no duplicate delivery)', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const compositor = makeCompositor('exact-once-text');
    const peerNotifier = makePeerNotifier();

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    const first = session.invokeCallback();
    expect(first).toBe('exact-once-text');
    // Consumed from compositor.
    expect(compositor._dropped).toHaveLength(1);

    // Second call: compositor is empty.
    const second = session.invokeCallback();
    expect(second).toBeUndefined();
    // No second drop.
    expect(compositor._dropped).toHaveLength(1);
  });

  it('peer stays in notifier buffer after attachment barrier — delivered at next boundary once attachment is gone', () => {
    // Proves that peer messages blocked by an attachment barrier are NOT lost:
    // they remain in the notifier buffer and are delivered once the attachment
    // is submitted (hasPendingSubmission becomes false).
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const peerBuffer = ['peer-during-upload'];
    const peerNotifier = makePeerNotifier(peerBuffer);

    // Start with an attachment compositor.
    let currentCompositor: ReturnType<typeof makeCompositorWithAttachment> | null =
      makeCompositorWithAttachment();

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => currentCompositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // First boundary: attachment present → peer blocked.
    expect(session.invokeCallback()).toBeUndefined();
    expect(peerNotifier.hasPendingInjections()).toBe(true); // still in notifier

    // Human submits the attachment (attachment queue is now empty).
    currentCompositor = null; // simulates no compositor or empty compositor

    // Second boundary: no human barrier → peer is admitted.
    const result = session.invokeCallback();
    expect(result).toContain('peer-during-upload');
  });
});

// ── Reclaim on reinstall ─────────────────────────────────────────────────────

describe('reinstallPeerBoundary — reclaim on swap', () => {
  it('reclaim() is called on the notifier during reinstall, clearing its buffer', async () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const peerBuffer = ['stale-message'];
    let reclaimCalled = false;
    const peerNotifier = {
      hasPendingInjections: () => peerBuffer.length > 0,
      drainInjections: () => {
        if (peerBuffer.length === 0) return '';
        peerBuffer.splice(0);
        return 'stale-message\n\n';
      },
      reclaim: async () => { peerBuffer.splice(0); reclaimCalled = true; return 1; },
    };

    const opts = {
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    };

    reinstallPeerBoundary(opts, undefined);
    // reclaim() is async void; wait a microtask tick for it to settle.
    await Promise.resolve();
    expect(reclaimCalled).toBe(true);
    expect(peerBuffer).toHaveLength(0);
  });
});

// ── Saturation regression: peer stays queued and is later delivered ───────────
// Verifies that a peer message is NOT silently discarded when the admission queue
// is full (maxCount reached). The message must remain in the notifier buffer and
// be delivered at a subsequent boundary once the queue drains.

describe('AdmissionQueue saturation — peer not lost on full queue', () => {
  it('peer stays in notifier buffer when admission queue is at maxCount; delivered after drain', () => {
    // Create a tiny admission queue (maxCount=1) to simulate saturation easily.
    const admissionQueue = new AdmissionQueue({ maxCount: 1 });
    const session = makeSession();
    const peerBuffer = ['peer-overflow-message'];
    const peerNotifier = makePeerNotifier(peerBuffer);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // Fill the admission queue to capacity with a human entry (occupies the 1 slot).
    admissionQueue.submitHuman('human-fills-queue');
    expect(admissionQueue.full).toBe(true);

    // Invoke boundary: queue is full → peer must NOT be drained from notifier.
    const result1 = session.invokeCallback();
    // The human message is delivered (it was already in the queue).
    expect(result1).toBe('human-fills-queue');
    // Peer should still be in the notifier buffer (not lost).
    expect(peerNotifier.hasPendingInjections()).toBe(true);

    // Queue is now empty (human message was drained). Next boundary: peer is admitted.
    const result2 = session.invokeCallback();
    expect(result2).toContain('peer-overflow-message');
    expect(peerNotifier.hasPendingInjections()).toBe(false);
  });

  it('admissionQueue.full getter reflects maxCount ceiling correctly', () => {
    const q = new AdmissionQueue({ maxCount: 2 });
    expect(q.full).toBe(false);
    q.submitPeer('s1', 'first');
    expect(q.full).toBe(false);
    q.submitPeer('s2', 'second');
    expect(q.full).toBe(true);
    // After draining, full becomes false again.
    const snap = q.snapshot();
    q.drain(snap);
    expect(q.full).toBe(false);
  });
});

// ── Five near-64KiB messages: no loss, all delivered in order ────────────────
// Regression test for the data-loss bug where boundary.ts drained ALL notifier
// envelopes into a single merged string, then called submitPeer once with the
// entire batch. If the batch exceeded the byte ceiling, all messages were lost.
//
// Five 64KiB messages span 320KiB — well above the default 256KiB queue byte
// ceiling. The fix: each envelope is submitted individually; rejected envelopes
// stay in the notifier buffer and are retried on the next boundary. All five
// must eventually be delivered across at most five boundary invocations.

describe('Data-loss regression — five near-64KiB messages delivered without loss', () => {
  it('all 5 near-64KiB messages are eventually injected, none silently dropped', () => {
    // Each message is ~60KiB (below PEER_MAX_BODY_BYTES=64KiB sender guard).
    // Default AdmissionQueue maxBytes=256KiB, maxCount=50. With per-envelope
    // submission, the queue accepts 4 messages per drain (4×60KiB=240KiB<256KiB)
    // then rejects the 5th. The 5th stays in the notifier buffer and is admitted
    // on the next boundary turn after the queue drains.
    const NEAR_64K = 60 * 1024; // 60 KiB per message
    const messages = Array.from({ length: 5 }, (_, i) =>
      `msg-${i + 1}-` + 'x'.repeat(NEAR_64K - 10),
    );

    const admissionQueue = new AdmissionQueue(); // defaults: maxCount=50, maxBytes=256KiB
    const session = makeSession();
    const peerBuffer = [...messages];
    const peerNotifier = makePeerNotifier(peerBuffer);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    const delivered: string[] = [];

    // Keep invoking boundaries until all 5 messages are delivered.
    // Safety: cap at 10 iterations to detect infinite loops.
    for (let iter = 0; iter < 10 && delivered.join('').split('msg-').length - 1 < 5; iter++) {
      const result = session.invokeCallback();
      if (result) {
        // Extract message ids (msg-1 through msg-5) from the rendered block.
        const found = result.match(/msg-\d+/g) ?? [];
        delivered.push(...found);
      }
    }

    // All five messages must have been delivered.
    expect(delivered.filter((m) => m === 'msg-1')).toHaveLength(1);
    expect(delivered.filter((m) => m === 'msg-2')).toHaveLength(1);
    expect(delivered.filter((m) => m === 'msg-3')).toHaveLength(1);
    expect(delivered.filter((m) => m === 'msg-4')).toHaveLength(1);
    expect(delivered.filter((m) => m === 'msg-5')).toHaveLength(1);

    // Nothing left in notifier buffer after all are delivered.
    expect(peerNotifier.hasPendingInjections()).toBe(false);
  });

  it('each message is injected exactly once (no duplication across boundaries)', () => {
    const NEAR_64K = 60 * 1024;
    const messages = Array.from({ length: 5 }, (_, i) =>
      `unique-${i + 1}-` + 'y'.repeat(NEAR_64K - 12),
    );

    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const peerBuffer = [...messages];
    const peerNotifier = makePeerNotifier(peerBuffer);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    const seenIds = new Map<string, number>();
    for (let iter = 0; iter < 10; iter++) {
      const result = session.invokeCallback();
      if (result) {
        const found = result.match(/unique-\d+/g) ?? [];
        for (const id of found) {
          seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
        }
      }
    }

    // Each unique marker must appear exactly once.
    for (let i = 1; i <= 5; i++) {
      expect(seenIds.get(`unique-${i}`)).toBe(1);
    }
  });

  it('admitted messages from first boundary reflect in correct FIFO order', () => {
    // With 5×60KiB messages and a 256KiB queue, the first boundary delivers
    // messages 1-4 in order; message 5 is delivered on the next boundary.
    const NEAR_64K = 60 * 1024;
    const messages = Array.from({ length: 5 }, (_, i) =>
      `order-msg-${i + 1}-` + 'z'.repeat(NEAR_64K - 14),
    );

    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const peerBuffer = [...messages];
    const peerNotifier = makePeerNotifier(peerBuffer);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // First boundary: messages 1-4 should be admitted (≤256KiB), msg-5 stays.
    const batch1 = session.invokeCallback() ?? '';
    const ids1 = (batch1.match(/order-msg-\d+/g) ?? []).filter((v, i, a) => a.indexOf(v) === i);

    // msg-5 must NOT appear in batch1 (it didn't fit).
    expect(ids1).not.toContain('order-msg-5');
    // msg-1 through msg-4 must appear in order within batch1.
    expect(ids1).toEqual(['order-msg-1', 'order-msg-2', 'order-msg-3', 'order-msg-4']);

    // Second boundary: msg-5 is now admitted.
    const batch2 = session.invokeCallback() ?? '';
    expect(batch2).toContain('order-msg-5');
    expect(batch2).not.toContain('order-msg-1');
  });
});

// ── Slash / shell barrier: submitHuman is GATED (not unconditional) ───────────
// Verifies that /slash and !shell text in the compositor queue acts as a human
// barrier (blocks peer) AND that the submitHuman call is only made when
// hasPendingSubmission() is true — it is NOT called unconditionally.
// Also verifies that slash/shell text does NOT appear when the compositor is
// empty (no spurious injection).

describe('Slash and shell passthrough as human barriers', () => {
  it('/slash command in compositor blocks peer injection (hasPendingSubmission=true)', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    // A slash command is queued as human text in the compositor.
    const compositor = makeCompositor('/model gpt-4o');
    const peerNotifier = makePeerNotifier(['peer while slash pending']);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // First boundary: /slash command wins; peer is blocked.
    const result1 = session.invokeCallback();
    expect(result1).toBe('/model gpt-4o');
    expect(result1).not.toContain('peer while slash pending');
    // Peer still buffered — not lost.
    expect(peerNotifier.hasPendingInjections()).toBe(true);

    // Second boundary: slash is consumed; peer is now admitted.
    const result2 = session.invokeCallback();
    expect(result2).toContain('peer while slash pending');
  });

  it('!shell passthrough text in compositor blocks peer injection', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    // A shell passthrough queued as human text.
    const compositor = makeCompositor('!ls -la');
    const peerNotifier = makePeerNotifier(['peer while shell pending']);

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    // First boundary: shell text wins.
    const result1 = session.invokeCallback();
    expect(result1).toBe('!ls -la');
    expect(result1).not.toContain('peer while shell pending');
    expect(peerNotifier.hasPendingInjections()).toBe(true);

    // Second boundary: peer delivered.
    const result2 = session.invokeCallback();
    expect(result2).toContain('peer while shell pending');
  });

  it('submitHuman is NOT called when compositor hasPendingSubmission=false', () => {
    // When the compositor has no pending submission, the humanPending branch is
    // NOT entered, so submitHuman is never called. This ensures peer messages
    // are not accidentally blocked by a spurious human submission.
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    // Empty compositor: hasPendingSubmission=false, peekQueuedText=undefined.
    const compositor = makeCompositor(/* no text */ undefined);
    const peerNotifier = makePeerNotifier(['only peer message']);
    const submitHumanSpy = vi.spyOn(admissionQueue, 'submitHuman');

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    const result = session.invokeCallback();
    // submitHuman was never called (no human text).
    expect(submitHumanSpy).not.toHaveBeenCalled();
    // Peer was admitted.
    expect(result).toContain('only peer message');
  });

  it('submitHuman is called ONLY when hasPendingSubmission=true and peekQueuedText returns text', () => {
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const compositor = makeCompositor('queued human text');
    const peerNotifier = makePeerNotifier([]);
    const submitHumanSpy = vi.spyOn(admissionQueue, 'submitHuman');

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    session.invokeCallback();
    // submitHuman called exactly once with the queued text.
    expect(submitHumanSpy).toHaveBeenCalledTimes(1);
    expect(submitHumanSpy).toHaveBeenCalledWith('queued human text');
  });

  it('attachment barrier (hasPendingSubmission=true, peekQueuedText=undefined) does NOT call submitHuman', () => {
    // An image attachment is pending: hasPendingSubmission=true but
    // peekQueuedText=undefined. submitHuman must NOT be called (no text to admit).
    const admissionQueue = new AdmissionQueue();
    const session = makeSession();
    const compositor = makeCompositorWithAttachment();
    const peerNotifier = makePeerNotifier(['peer during image upload']);
    const submitHumanSpy = vi.spyOn(admissionQueue, 'submitHuman');

    installPeerBoundary({
      getSession: () => session,
      getCompositor: () => compositor as never,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    });

    const result = session.invokeCallback();
    // No human text to extract → submitHuman not called.
    expect(submitHumanSpy).not.toHaveBeenCalled();
    // Peer blocked by attachment barrier.
    expect(result).toBeUndefined();
    // Peer still in buffer.
    expect(peerNotifier.hasPendingInjections()).toBe(true);
  });
});
