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

function makePeerNotifier(buffered: string[] = []) {
  return {
    hasPendingInjections: () => buffered.length > 0,
    drainInjections: () => {
      if (buffered.length === 0) return '';
      const result = buffered.splice(0).join('\n\n') + '\n\n';
      return result;
    },
  };
}

function makeCompositor(queuedText?: string) {
  const payloads = queuedText !== undefined ? [{ id: 'p1' }] : [];
  const reservations = new Set<unknown>();
  const dropped: unknown[] = [];
  return {
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
      queuedText = undefined; // consumed
      return snap.payloads.length;
    },
    _reservations: reservations,
    _dropped: dropped,
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
    // Peer is still in the peer notifier buffer (it was drained into queue but
    // human barrier excluded it from this snapshot).
    // Second invocation (human gone) returns peer.
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
    const peerBuffer = ['msg-after-resume'];
    const peerNotifier = makePeerNotifier(peerBuffer);

    const opts = {
      getSession: () => currentSession,
      getCompositor: () => null,
      peerNotifier: peerNotifier as never,
      admissionQueue,
    };

    reinstallPeerBoundary(opts, undefined);

    // New peer arrives — should be injected at next boundary.
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
