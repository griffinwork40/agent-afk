/**
 * Concurrency test: per-session AnthropicDirectProvider isolation.
 *
 * Background: under `afk farm new N` (N > 1), N child sessions are forked
 * concurrently, each with distinct `readRoots`/`writeRoots` (one per
 * worktree). Prior to the per-session-provider fix in
 * `providers/index.ts:resolveProvider`, `AgentSession` routed every Claude
 * model to the SAME module-level `anthropicDirectProvider` singleton — whose
 * `_sharedReadRoots` / `_sharedWriteRoots` arrays were overwritten by each
 * session's `query()` call. Last-writer-wins under concurrency: branch C's
 * tool handler could see branch A's roots, defeating the worktree boundary.
 *
 * This test pins the load-bearing invariant: with the fix in place,
 * `resolveProvider()` MUST return a fresh `AnthropicDirectProvider` instance
 * per call, and each instance's shared-root state MUST stay private to that
 * instance even when both are driving `query()` concurrently with distinct
 * configs.
 *
 * The test fails on the pre-fix code (where both `resolveProvider()` calls
 * return the same singleton and the second `query()` clobbers the first's
 * roots) and passes after the fix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveProvider } from '../index.js';
import {
  AnthropicDirectProvider,
  __setAnthropicClientFactory,
} from './index.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from '../../types/config-types.js';

describe('AnthropicDirectProvider per-session isolation', () => {
  let tmpHome: string;
  let prevAfkHome: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Isolate audit log writes so concurrent appends don't bleed into the
    // operator's real ~/.afk state.
    tmpHome = mkdtempSync(path.join(tmpdir(), 'concurrent-session-test-'));
    prevAfkHome = process.env['AFK_HOME'];
    prevHome = process.env['HOME'];
    process.env['AFK_HOME'] = tmpHome;
    process.env['HOME'] = tmpHome;

    // Stub the Anthropic client so query() does no network I/O.
    __setAnthropicClientFactory(
      () =>
        ({
          messages: {
            stream: () => ({
              [Symbol.asyncIterator]() {
                return { next: async () => ({ done: true, value: undefined }) };
              },
            }),
          },
        }) as unknown as InstanceType<typeof Anthropic>,
    );
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
    if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevAfkHome;
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('resolveProvider returns a fresh AnthropicDirectProvider per call for Claude models', () => {
    // Pin the structural invariant the fix relies on: two calls to
    // resolveProvider for the same Claude model must produce DIFFERENT
    // instances, otherwise the per-session shared-root state remains
    // entangled.
    const p1 = resolveProvider('sonnet');
    const p2 = resolveProvider('sonnet');
    expect(p1).toBeInstanceOf(AnthropicDirectProvider);
    expect(p2).toBeInstanceOf(AnthropicDirectProvider);
    expect(p1).not.toBe(p2);
  });

  it('two concurrent sessions with distinct readRoots/writeRoots do not leak roots across providers', async () => {
    // Simulate two parallel `afk farm` branches: each calls `resolveProvider`
    // to obtain its provider, then drives `query()` with its own cwd +
    // readRoots/writeRoots. The two query() calls run interleaved.
    const cwdA = mkdtempSync(path.join(tmpdir(), 'session-A-'));
    const cwdB = mkdtempSync(path.join(tmpdir(), 'session-B-'));
    try {
      const providerA = resolveProvider('sonnet') as AnthropicDirectProvider;
      const providerB = resolveProvider('sonnet') as AnthropicDirectProvider;

      // Sanity check: pre-fix this would FAIL because both resolve to the
      // same singleton.
      expect(providerA).not.toBe(providerB);

      const configA: AgentConfig = {
        apiKey: 'sk-test',
        cwd: cwdA,
        readRoots: [cwdA],
        writeRoots: [cwdA],
      } as unknown as AgentConfig;
      const configB: AgentConfig = {
        apiKey: 'sk-test',
        cwd: cwdB,
        readRoots: [cwdB],
        writeRoots: [cwdB],
      } as unknown as AgentConfig;

      // Drive both queries concurrently. Each query() runs ensureSharedRoots
      // and the readRoots/writeRoots overwrite in
      // anthropic-direct/index.ts:316-327 — exactly the site that the
      // singleton-shared bug raced on.
      const qA = providerA.query({ prompt: 'noop-A', config: configA });
      const qB = providerB.query({ prompt: 'noop-B', config: configB });

      // Drain one event from each so buildDispatcher fires on both.
      const iterA = qA[Symbol.asyncIterator]();
      const iterB = qB[Symbol.asyncIterator]();
      await Promise.all([iterA.next(), iterB.next()]);

      await qA.close?.();
      await qB.close?.();

      // Each provider must reflect only its own roots — no cross-contamination.
      const grantsA = providerA.getGrants();
      const grantsB = providerB.getGrants();

      expect(grantsA.resolveBase).toBe(cwdA);
      expect(grantsA.readRoots).toEqual([cwdA]);
      expect(grantsA.writeRoots).toEqual([cwdA]);

      expect(grantsB.resolveBase).toBe(cwdB);
      expect(grantsB.readRoots).toEqual([cwdB]);
      expect(grantsB.writeRoots).toEqual([cwdB]);

      // Symmetric negative assertions: A must not have B's roots and vice versa.
      expect(grantsA.readRoots).not.toContain(cwdB);
      expect(grantsA.writeRoots).not.toContain(cwdB);
      expect(grantsB.readRoots).not.toContain(cwdA);
      expect(grantsB.writeRoots).not.toContain(cwdA);
    } finally {
      rmSync(cwdA, { recursive: true, force: true });
      rmSync(cwdB, { recursive: true, force: true });
    }
  });

  it('N=4 concurrent providers all retain distinct, non-overlapping roots', async () => {
    // Stress shape: 4 concurrent sessions, each with unique cwd. Asserts the
    // last-writer-wins clobber pattern cannot reappear via any racing
    // sequence of query() calls.
    const cwds = [0, 1, 2, 3].map(() =>
      mkdtempSync(path.join(tmpdir(), 'session-N-')),
    );
    try {
      const providers = cwds.map(
        () => resolveProvider('sonnet') as AnthropicDirectProvider,
      );
      // All instances must be distinct.
      const uniqueRefs = new Set(providers);
      expect(uniqueRefs.size).toBe(providers.length);

      const queries = providers.map((p, i) =>
        p.query({
          prompt: `noop-${i}`,
          config: {
            apiKey: 'sk-test',
            cwd: cwds[i],
            readRoots: [cwds[i]!],
            writeRoots: [cwds[i]!],
          } as unknown as AgentConfig,
        }),
      );

      // Interleave: drain one event from each concurrently.
      await Promise.all(
        queries.map((q) => {
          const iter = q[Symbol.asyncIterator]();
          return iter.next();
        }),
      );
      await Promise.all(queries.map((q) => q.close?.()));

      for (let i = 0; i < providers.length; i++) {
        const grants = providers[i]!.getGrants();
        expect(grants.resolveBase).toBe(cwds[i]);
        expect(grants.readRoots).toEqual([cwds[i]]);
        expect(grants.writeRoots).toEqual([cwds[i]]);
        // Cross-checks: none of the OTHER cwds may appear in this provider's roots.
        for (let j = 0; j < cwds.length; j++) {
          if (i === j) continue;
          expect(grants.readRoots).not.toContain(cwds[j]);
          expect(grants.writeRoots).not.toContain(cwds[j]);
        }
      }
    } finally {
      for (const c of cwds) rmSync(c, { recursive: true, force: true });
    }
  });
});
