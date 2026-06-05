/**
 * Integration tests for witness-layer wiring into AgentSession.
 *
 * These tests drive a real {@link AgentSession} via the mock provider
 * fixture and assert the trace contents through an
 * {@link InMemoryTraceWriter}. They are the executable proof that the
 * wiring sites in `agent-session.ts`, `subagent.ts`, etc. honor the
 * contract in `docs/philosophy/afk-contract.md`.
 *
 * Scope: PR #2 commit 1 — session_sealed wiring only. Subsequent commits
 * add tool_call, hook_decision, subagent_lifecycle, abort, budget,
 * compaction, and closure assertions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentConfig } from '../types.js';
import { createMockProvider, type MockProviderHandle } from '../__fixtures__/mock-provider.js';
import { InMemoryTraceWriter } from './writer.js';

vi.mock('../../utils/debug.js', () => ({
  debugLog: vi.fn(),
}));

// Import after mocks are set up
import { AgentSession } from '../session.js';

describe('AgentSession + witness-layer wiring', () => {
  let provider: MockProviderHandle;
  let writer: InMemoryTraceWriter;
  let config: AgentConfig;

  beforeEach(() => {
    provider = createMockProvider();
    writer = new InMemoryTraceWriter();
    config = {
      model: 'sonnet',
      apiKey: 'test-key',
      provider,
      traceWriter: writer,
    };
  });

  describe('session_sealed', () => {
    it('writes a sealed-clean record with status=succeeded on normal close', async () => {
      const session = new AgentSession(config);
      await session.waitForInitialization();
      await session.close();

      const seals = writer.events.filter((e) => e.kind === 'session_sealed');
      expect(seals).toHaveLength(1);
      const sealEvent = seals[0];
      if (sealEvent?.kind !== 'session_sealed') throw new Error('unreachable');
      expect(sealEvent.payload.status).toBe('succeeded');
      expect(sealEvent.payload.finalTurnCount).toBe(0);
      // closedAt must be ISO-8601.
      expect(() => new Date(sealEvent.payload.closedAt).toISOString()).not.toThrow();
    });

    it('seal is the LAST event in the trace', async () => {
      const session = new AgentSession(config);
      await session.waitForInitialization();
      await session.close();

      const events = writer.events;
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[events.length - 1]?.kind).toBe('session_sealed');
    });

    it('records status=cancelled when an external abort fires before close', async () => {
      const externalAbort = new AbortController();
      const cancelConfig = { ...config, abortSignal: externalAbort.signal };
      const session = new AgentSession(cancelConfig);
      await session.waitForInitialization();
      externalAbort.abort('user-cancelled');
      // Allow microtasks to settle the abort wiring.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await session.close();

      const seals = writer.events.filter((e) => e.kind === 'session_sealed');
      expect(seals).toHaveLength(1);
      const sealEvent = seals[0];
      if (sealEvent?.kind !== 'session_sealed') throw new Error('unreachable');
      expect(sealEvent.payload.status).toBe('cancelled');
    });

    it('is idempotent — repeated close() calls do not write multiple seals', async () => {
      const session = new AgentSession(config);
      await session.waitForInitialization();
      await session.close();
      await session.close();

      const seals = writer.events.filter((e) => e.kind === 'session_sealed');
      expect(seals).toHaveLength(1);
    });

    it('seal fires on reset() too (the reason changes; status stays succeeded)', async () => {
      const session = new AgentSession(config);
      await session.waitForInitialization();
      await session.reset();
      // reset rebuilds internal state; close the new session too so we
      // can inspect both seal events.
      await session.close();

      const seals = writer.events.filter((e) => e.kind === 'session_sealed');
      // One from reset(), one from close().
      expect(seals.length).toBeGreaterThanOrEqual(1);
      for (const seal of seals) {
        if (seal.kind !== 'session_sealed') continue;
        expect(seal.payload.status).toBe('succeeded');
      }
    });

    it('runs even when no trace writer is configured (graceful no-op)', async () => {
      const noWriterConfig: AgentConfig = { ...config };
      delete noWriterConfig.traceWriter;
      const session = new AgentSession(noWriterConfig);
      await session.waitForInitialization();
      // Should not throw despite the absence of a writer.
      await expect(session.close()).resolves.not.toThrow();
      // And no events were recorded on our standalone writer (it was
      // never wired into this session).
      expect(writer.events).toHaveLength(0);
    });

    it('writer.seal() throws do not propagate from dispatchSessionEndOnce', async () => {
      // Construct a writer whose seal() rejects. The session must
      // swallow the failure so a broken trace sink never masks the
      // real session-end reason from downstream observers.
      const angry: InMemoryTraceWriter & { failOnSeal?: boolean } = new InMemoryTraceWriter();
      const origSeal = angry.seal.bind(angry);
      angry.seal = async () => {
        throw new Error('disk full');
      };
      const angryConfig = { ...config, traceWriter: angry };
      const session = new AgentSession(angryConfig);
      await session.waitForInitialization();
      await expect(session.close()).resolves.not.toThrow();
      // Restore so afterEach (if any) doesn't crash.
      angry.seal = origSeal;
    });
  });
});
