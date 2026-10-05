/**
 * Tests for loop-iteration.injections.ts:
 *   - prependTurnInjections: ordering, empty no-op, single drain.
 *   - autoResumeDirective: bgResultPending=true vs false wording.
 *
 * Auto-resume wiring (peer-message wake path) is also tested here at the
 * unit level: onInjectable/tryAutoResume logic is exercised through the
 * PeerInboxNotifier's hook, which mirrors the BgResultNotifier pattern.
 * Full loop integration is impractical without a live InputSurface/PTY and
 * is already covered by the bg-result-notifier.test.ts + loop-iteration.test.ts
 * wiring patterns, so peer cases are added at the lowest feasible level.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  prependTurnInjections,
  autoResumeDirective,
  type InjectionSource,
} from './loop-iteration.injections.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeSource(content: string): InjectionSource {
  let called = false;
  return {
    drainInjections(): string {
      if (called) return '';
      called = true;
      return content;
    },
  };
}

// ── prependTurnInjections ────────────────────────────────────────────────────

describe('prependTurnInjections', () => {
  it('empty sources list returns runText unchanged', () => {
    expect(prependTurnInjections('hello', [])).toBe('hello');
  });

  it('a single non-empty source prepends its content', () => {
    const src = makeSource('[injection]');
    expect(prependTurnInjections('user text', [src])).toBe('[injection]user text');
  });

  it('each source is drained exactly once (second call returns empty)', () => {
    const src = makeSource('[block]');
    prependTurnInjections('text', [src]);
    // Draining again on same source gives ''
    expect(src.drainInjections()).toBe('');
  });

  it('multiple sources: last source ends up first (stack order)', () => {
    // prependTurnInjections iterates sources in argument order, each one prepends:
    // After src1: "[A]text"
    // After src2: "[B][A]text"
    // So the last source in the array ends up at the start.
    const src1 = makeSource('[A]');
    const src2 = makeSource('[B]');
    const result = prependTurnInjections('text', [src1, src2]);
    expect(result).toBe('[B][A]text');
    // Last source (src2) content is first in output
    expect(result.startsWith('[B]')).toBe(true);
  });

  it('empty source in middle does not contribute', () => {
    const src1 = makeSource('[A]');
    const src2 = makeSource('');
    const src3 = makeSource('[C]');
    const result = prependTurnInjections('end', [src1, src2, src3]);
    expect(result).toBe('[C][A]end');
  });

  it('all empty sources → runText unchanged', () => {
    const sources = [makeSource(''), makeSource(''), makeSource('')];
    expect(prependTurnInjections('unchanged', sources)).toBe('unchanged');
  });
});

// ── autoResumeDirective ──────────────────────────────────────────────────────

describe('autoResumeDirective', () => {
  it('bgResultPending=true → background task wording (mentions "background task")', () => {
    const directive = autoResumeDirective(true);
    expect(directive).toContain('[auto-resume]');
    expect(directive.toLowerCase()).toContain('background');
  });

  it('bgResultPending=false → peer message wording (mentions "another afk session")', () => {
    const directive = autoResumeDirective(false);
    expect(directive).toContain('[auto-resume]');
    expect(directive).toContain('another afk session');
  });

  it('peer wording mentions send_to_session', () => {
    const directive = autoResumeDirective(false);
    expect(directive).toContain('send_to_session');
  });

  it('background wording does NOT mention send_to_session (different branch)', () => {
    const directive = autoResumeDirective(true);
    expect(directive).not.toContain('send_to_session');
  });
});

// ── auto-resume wiring: peer wake path at unit level ──────────────────────────
//
// The full tryAutoResume closure (surface.abortPendingRead + seedBuffer) lives
// in loop-iteration.ts and requires a live InputSurface; testing it end-to-end
// requires mocking the entire REPL harness (see loop-iteration.test.ts).
// Here we test the observable contract at the lowest feasible level: that
// PeerInboxNotifier.onInjectable fires when an envelope arrives, and that
// hasPendingInjections() + drainInjections() satisfy the contract loop-iteration
// depends on.

describe('auto-resume wiring — peer cases (unit level)', () => {
  it('idle + empty buffer: onInjectable fires when peer message arrives', async () => {
    // Simulate the REPL hooking onInjectable to tryAutoResume:
    // when a message arrives and the buffer was empty, the hook fires.
    const { mkdtemp, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { randomUUID } = await import('crypto');
    const { PeerInboxNotifier } = await import('./peer-inbox-notifier.js');
    const { writeEnvelope } = await import('../../../agent/peer/inbox-store.js');

    const tmp = await mkdtemp(join(tmpdir(), 'afk-wake-'));
    const savedHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = tmp;
    delete process.env['AFK_STATE_DIR'];
    delete process.env['AFK_FRAMEWORK_DIR'];

    try {
      const sessionId = randomUUID();
      const lines: string[] = [];
      const notifier = new PeerInboxNotifier({
        getSessionId: () => sessionId,
        writeLine: (t) => lines.push(t),
        mode: () => 'accept',
        pollMs: 5,
      });

      const woken = vi.fn();
      notifier.onInjectable = woken;

      // No messages yet — hasPendingInjections is false
      expect(notifier.hasPendingInjections()).toBe(false);

      // Write a peer message
      await writeEnvelope({
        v: 1,
        messageId: randomUUID(),
        from: { id: 'peer-session-a' },
        to: sessionId,
        hop: 0,
        ts: new Date().toISOString(),
        body: 'wake me up',
      });

      // Scan triggers the onInjectable hook
      await notifier.scan();

      expect(woken).toHaveBeenCalledTimes(1);
      expect(notifier.hasPendingInjections()).toBe(true);

      // drainInjections returns the peer block
      const block = notifier.drainInjections();
      expect(block).toContain('<peer-session-message');
      expect(block).toContain('peer-session-a');
      expect(block).toContain('wake me up');

      // After drain, buffer is empty and next turn starts with the peer content
      // (the loop prepends this to runText via prependTurnInjections)
      expect(notifier.hasPendingInjections()).toBe(false);
    } finally {
      if (savedHome !== undefined) process.env['AFK_HOME'] = savedHome;
      else delete process.env['AFK_HOME'];
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('non-empty buffer: onInjectable does NOT fire when a second message arrives', async () => {
    const { mkdtemp, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { randomUUID } = await import('crypto');
    const { PeerInboxNotifier } = await import('./peer-inbox-notifier.js');
    const { writeEnvelope } = await import('../../../agent/peer/inbox-store.js');

    const tmp = await mkdtemp(join(tmpdir(), 'afk-wake2-'));
    const savedHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = tmp;
    delete process.env['AFK_STATE_DIR'];
    delete process.env['AFK_FRAMEWORK_DIR'];

    try {
      const sessionId = randomUUID();
      const notifier = new PeerInboxNotifier({
        getSessionId: () => sessionId,
        writeLine: () => {},
        mode: () => 'accept',
        pollMs: 5,
      });

      const woken = vi.fn();
      notifier.onInjectable = woken;

      // First message → fires
      await writeEnvelope({ v: 1, messageId: randomUUID(), from: { id: 'sender-1' }, to: sessionId, hop: 0, ts: new Date().toISOString(), body: 'first' });
      await notifier.scan();
      expect(woken).toHaveBeenCalledTimes(1);

      // Second message arrives while buffer is non-empty (not drained) → does NOT fire again
      await writeEnvelope({ v: 1, messageId: randomUUID(), from: { id: 'sender-2' }, to: sessionId, hop: 0, ts: new Date().toISOString(), body: 'second' });
      await notifier.scan();
      expect(woken).toHaveBeenCalledTimes(1); // still 1, not 2
    } finally {
      if (savedHome !== undefined) process.env['AFK_HOME'] = savedHome;
      else delete process.env['AFK_HOME'];
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('autoResumeDirective is the peer wording when only peer messages are pending', () => {
    // When bgResultNotifier.hasPendingInjections() === false and peer has messages,
    // tryAutoResume calls autoResumeDirective(false) → peer wording.
    const bgPending = false;
    const directive = autoResumeDirective(bgPending);
    expect(directive).toContain('another afk session');
    // The directive is used as the seedBuffer text so the next turn carries it.
    // This is the canonical wording for the peer-only wake path.
  });
});
