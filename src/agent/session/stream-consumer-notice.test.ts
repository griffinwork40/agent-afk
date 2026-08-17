/**
 * Tests for the `notice` ProviderEvent → OutputEvent mapping (issue #970).
 *
 * Contract:
 *   - A `notice` ProviderEvent produces a `{type:'notice'}` OutputEvent.
 *   - It does NOT produce a `{type:'message'}` OutputEvent.
 *   - It does NOT push to conversationHistory.
 *   - The zero-output detection chain remains reachable: a textless turn
 *     that yields only a notice still leaves finalMessage unset.
 *
 * These tests exercise the stream-consumer transform boundary only — no SDK,
 * no I/O.
 *
 * @module agent/session/stream-consumer-notice.test
 */

import { describe, it, expect } from 'vitest';
import type { ProviderEvent } from '../provider.js';
import { transformProviderEvent } from './stream-consumer.js';
import type { TransformDeps } from './stream-consumer.js';
import type { Message } from '../types.js';

// Minimal deps — only the fields transformProviderEvent actually touches for
// the event types under test.
function makeDeps(overrides: Partial<TransformDeps> = {}): TransformDeps & { _history: Message[] } {
  const history: Message[] = [];
  return {
    conversationHistory: history,
    getSessionMetadata: () => ({ sessionId: 'test-session' } as ReturnType<TransformDeps['getSessionMetadata']>),
    setSessionMetadata: () => {},
    updateSessionIdentity: () => {},
    resolveInitialization: () => {},
    setLastResponseMetadata: () => {},
    _history: history,
    ...overrides,
  };
}

describe('stream-consumer: notice ProviderEvent', () => {
  it('maps notice to a {type:"notice"} OutputEvent, preserving text and kind', () => {
    const evt: ProviderEvent = {
      type: 'notice',
      text: 'response truncated (max output tokens) — no text produced',
      kind: 'truncation',
      sessionId: 's1',
    };
    const deps = makeDeps();
    const out = transformProviderEvent(evt, deps);

    expect(out).not.toBeNull();
    expect(out!.type).toBe('notice');
    if (out!.type !== 'notice') throw new Error('unreachable');
    expect(out.text).toBe('response truncated (max output tokens) — no text produced');
    expect(out.kind).toBe('truncation');
  });

  it('does NOT produce a {type:"message"} OutputEvent', () => {
    const evt: ProviderEvent = {
      type: 'notice',
      text: 'some notice',
      kind: 'truncation',
    };
    const deps = makeDeps();
    const out = transformProviderEvent(evt, deps);

    expect(out?.type).not.toBe('message');
  });

  it('does NOT push to conversationHistory', () => {
    const evt: ProviderEvent = {
      type: 'notice',
      text: 'operator warning',
      kind: 'refusal',
      sessionId: 's1',
    };
    const deps = makeDeps();
    transformProviderEvent(evt, deps);

    // conversationHistory must remain empty — the notice is display-only.
    expect(deps._history).toHaveLength(0);
  });

  it('handles a refusal-kind notice correctly', () => {
    const evt: ProviderEvent = {
      type: 'notice',
      text: 'The model stopped with a content-safety refusal.',
      kind: 'refusal',
      sessionId: 's1',
    };
    const deps = makeDeps();
    const out = transformProviderEvent(evt, deps);

    expect(out?.type).toBe('notice');
    if (out?.type !== 'notice') throw new Error('unreachable');
    expect(out.kind).toBe('refusal');
  });

  it('zero-output chain: a turn that yields only a notice still has no {type:"message"} event', () => {
    // This is the critical invariant: when the provider emits a textless
    // truncation turn (no assistant.message, only a notice), the
    // stream-consumer must NOT synthesize a message event from the notice.
    // handle.ts finalMessage capture reads only {type:'message'} events, so
    // the ZERO-OUTPUT branch that stamps STREAM_INCOMPLETE and throws remains
    // reachable — preserving isZeroOutputStreamCut detection.
    const events: ProviderEvent[] = [
      { type: 'notice', text: 'truncated', kind: 'truncation' },
      { type: 'turn.completed', usage: { stopReason: 'max_tokens' } },
    ];

    const deps = makeDeps();
    const outputTypes = events
      .map((e) => transformProviderEvent(e, deps))
      .filter(Boolean)
      .map((o) => o!.type);

    expect(outputTypes).not.toContain('message');
    expect(outputTypes).toContain('notice');
    expect(outputTypes).toContain('done');
  });

  it('a notice alongside an assistant.message does not clobber the message', () => {
    // For the partial-text case: the model emitted some text, then hit the
    // cap. The assistant.message carries the partial text (+ the appended
    // notice text in the current text-path branch). This verifies the two
    // events are independent and the message event still produces a
    // {type:'message'} output.
    const deps = makeDeps();

    const msgOut = transformProviderEvent(
      { type: 'assistant.message', text: 'partial answer', sessionId: 's1' },
      deps,
    );
    expect(msgOut?.type).toBe('message');

    const noticeOut = transformProviderEvent(
      { type: 'notice', text: 'truncated', kind: 'truncation', sessionId: 's1' },
      deps,
    );
    expect(noticeOut?.type).toBe('notice');

    // History gets the assistant.message but NOT the notice.
    expect(deps._history).toHaveLength(1);
    expect(deps._history[0]?.role).toBe('assistant');
  });
});
