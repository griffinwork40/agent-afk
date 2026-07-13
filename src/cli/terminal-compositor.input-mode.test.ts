/**
 * Tests for TerminalCompositor — input mode + onSubmit (Stage 3a).
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('TerminalCompositor — input mode + onSubmit (Stage 3a)', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
  });

  describe('default mode (streaming)', () => {
    it('starts in streaming mode (legacy default for all existing callers)', () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      expect(c.getInputMode()).toBe('streaming');
    });

    it('Enter in streaming mode commits to FIFO and clears live buffer', async () => {
      // New contract: Enter in streaming mode commits the buffer to pendingSubmissions
      // and clears the live input. queued=true mirrors pendingCount>0.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('Enter in streaming mode does NOT fire onSubmit (legacy callers without idle mode)', async () => {
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(c.getBuffer().queued).toBe(true);
    });
  });

  describe('idle mode + onSubmit', () => {
    it('Enter in idle mode fires onSubmit(buffer) immediately', async () => {
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onSubmit).toHaveBeenCalledWith({ text: 'hi', attachments: [] });
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('Enter in idle mode clears the buffer + queued flag', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit: vi.fn() });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });

    it('Enter in idle mode with no onSubmit installed falls back to streaming queue behavior', async () => {
      // Defensive: if a caller flips to idle but never sets onSubmit,
      // Enter must not be silently swallowed — it commits to the FIFO instead
      // so the payload is preserved for the next readLine call.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' });
      // Live buffer cleared; 'h' is in the FIFO.
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('Enter on empty buffer in idle mode is a no-op (does not fire onSubmit)', async () => {
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('streaming → idle transition (auto-submit queued buffer)', () => {
    it('flushes queued buffer via onSubmit when transitioning streaming → idle', async () => {
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      // Stays in default streaming mode; user commits a message mid-stream.
      stdin.emit('keypress', 'q', { name: 'q', sequence: 'q' });
      stdin.emit('keypress', undefined, { name: 'return' });
      // New contract: live buffer cleared; 'q' is in the FIFO.
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      // Stream ends, surface flips mode → onSubmit fires with the FIFO payload.
      c.setInputMode('idle');
      expect(onSubmit).toHaveBeenCalledWith({ text: 'q', attachments: [] });
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });

    it('streaming → idle with NO queued buffer does NOT fire onSubmit', async () => {
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
      // No Enter — buffer is dirty but not queued
      c.setInputMode('idle');
      expect(onSubmit).not.toHaveBeenCalled();
      // The unqueued buffer survives the transition (user can keep typing in idle mode).
      expect(c.getBuffer().text).toBe('x');
    });

    it('streaming → idle with queued buffer + NO onSubmit leaves FIFO intact (legacy contract)', async () => {
      // With no onSubmit handler, → idle cannot drain. The FIFO payload survives
      // so the next readLine (which installs a handler) can flush it.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'q', { name: 'q', sequence: 'q' });
      stdin.emit('keypress', undefined, { name: 'return' });
      // Live buffer is already cleared at Enter-time.
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      c.setInputMode('idle');
      // No handler → FIFO untouched; queued stays true.
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('idle → streaming is a no-op (no flush)', async () => {
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', 'q', { name: 'q', sequence: 'q' });
      // Don't press Enter yet; transition back to streaming
      c.setInputMode('streaming');
      expect(onSubmit).not.toHaveBeenCalled();
      expect(c.getBuffer().text).toBe('q');
    });

    it('idle → idle with queued buffer + handler flushes (race between readLine calls)', async () => {
      // Scenario: between two readLine calls, the user types + Enter
      // while no onSubmit is installed. The Enter falls through to the
      // streaming-queue branch (sets queued=true). When the next
      // readLine installs a handler + calls setInputMode('idle'), the
      // widened flush invariant fires the handler immediately so the
      // queued buffer isn't stranded waiting on a second Enter press.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setInputMode('idle');
      // No handler installed yet — type + Enter commits to FIFO and clears live buffer.
      stdin.emit('keypress', 'r', { name: 'r', sequence: 'r' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      // Now install handler + transition idle → idle (no-op transition
      // but should still flush per the widened invariant).
      const onSubmit = vi.fn();
      c.setOnSubmit(onSubmit);
      c.setInputMode('idle');
      expect(onSubmit).toHaveBeenCalledWith({ text: 'r', attachments: [] });
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });
  });

  describe('setOnSubmit (post-construction installation)', () => {
    it('installs a handler that wasn\'t set at construction', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      const onSubmit = vi.fn();
      c.setOnSubmit(onSubmit);
      c.setInputMode('idle');
      stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onSubmit).toHaveBeenCalledWith({ text: 'x', attachments: [] });
    });

    it('setOnSubmit(null) clears a previously-installed handler', async () => {
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      c.setOnSubmit(null);
      stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onSubmit).not.toHaveBeenCalled();
      // Falls back to queue (FIFO) behavior: live buffer cleared, pending count 1.
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });
  });

  describe('ordered-operation invariant — clear state BEFORE handler fires', () => {
    it('idle Enter: getBuffer() observed from inside onSubmit returns the cleared state', async () => {
      let observed: { text: string; queued: boolean } | null = null;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(),
        onSubmit: () => { observed = c.getBuffer(); },
      });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', 'r', { name: 'r', sequence: 'r' });
      stdin.emit('keypress', undefined, { name: 'return' });
      // The handler must see state already cleared — otherwise a reentrant
      // call (handler queues another Enter) would double-fire on stale buffer.
      expect(observed).toEqual({ text: '', queued: false });
    });

    it('streaming → idle flush: getBuffer() observed from inside onSubmit returns the cleared state', async () => {
      let observed: { text: string; queued: boolean } | null = null;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(),
        onSubmit: () => { observed = c.getBuffer(); },
      });
      await c.arm();
      stdin.emit('keypress', 'q', { name: 'q', sequence: 'q' });
      stdin.emit('keypress', undefined, { name: 'return' });
      c.setInputMode('idle');
      expect(observed).toEqual({ text: '', queued: false });
    });
  });
});

// ── Multi-message queue (FIFO) ─────────────────────────────────────────────
//
// Verifies the new multi-message type-ahead contract introduced alongside the
// commit-on-Enter change: pressing Enter commits to a FIFO (pendingSubmissions)
// and CLEARS the live input so the user can compose the NEXT message. Each
// → idle transition drains exactly one payload (oldest first). N queued
// messages require N sequential turns (streaming → idle cycles) to fully drain.
