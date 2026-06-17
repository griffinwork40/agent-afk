/**
 * Tests for the /bgsub family of slash commands.
 *
 * Covers:
 *  - /bgsub with no jobs → info message
 *  - /bgsub with jobs    → one line per job, includes status glyph + id
 *  - /bgsub <id> / /bgsub:status <id> → detail rendering
 *  - /bgsub:join <id>    → waits for terminal state, renders result
 *  - /bgsub:cancel <id>  → invokes registry.cancelJob and reports
 *  - missing registry    → error path fires
 *  - /bgsub:join evicted → falls back to disk log replay
 *
 * The registry under test is the real `BackgroundAgentRegistry`; we drive
 * its `runInBackground` callback via a stub handle to simulate terminal
 * transitions deterministically (no SDK calls).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Use a temp AFK_HOME so disk fallback tests don't touch real ~/.afk
const bgtestTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-bgsub-test-'));
process.env['AFK_HOME'] = bgtestTmpDir;
import {
  bgsubCmd,
  bgsubStatusCmd,
  bgsubJoinCmd,
  bgsubCancelCmd,
  setBgsubRegistry,
  setBgsubSummarizer,
  resetBgsubRegistry,
} from './bgsub.js';
import type { BackgroundSummarizer, SummaryEntry } from '../../../agent/background-summarizer.js';
import { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import type { SubagentHandle, SubagentResult } from '../../../agent/subagent.js';
import type { SlashContext, SessionStats } from '../types.js';

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
  };
}

function makeCtx(): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t): void => { lines.push(t); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

/** Stub a `SubagentHandle` whose `runInBackground` callback we control. */
function makeBgHandle(id = 'sub-1'): {
  handle: SubagentHandle;
  fireTerminal: (r: SubagentResult) => void;
  cancelMock: ReturnType<typeof vi.fn>;
} {
  let captured: ((r: SubagentResult) => void) | undefined;
  const cancelMock = vi.fn().mockResolvedValue(undefined);
  return {
    handle: {
      id,
      status: 'idle',
      runInBackground: vi.fn((_p: string, on?: (r: SubagentResult) => void) => {
        captured = on;
      }),
      cancel: cancelMock,
      teardown: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
      runToResult: vi.fn(),
    } as unknown as SubagentHandle,
    fireTerminal: (r) => captured?.(r),
    cancelMock,
  };
}

describe('/bgsub slash commands', () => {
  beforeEach(() => {
    resetBgsubRegistry();
  });

  // Helper: create a minimal BackgroundSummarizer stub
  function makeMockSummarizer(summaryMap: Record<string, SummaryEntry>): BackgroundSummarizer {
    return {
      start: vi.fn(),
      stop: vi.fn(),
      getSummary: (jobId: string) => summaryMap[jobId],
    } as unknown as BackgroundSummarizer;
  }

  describe('missing registry', () => {
    it('/bgsub without a wired registry → error and returns continue', async () => {
      const { ctx, lines } = makeCtx();
      const result = await bgsubCmd.handler(ctx, '');
      expect(result).toBe('continue');
      expect(lines.some((l) => l.startsWith('ERROR:Background subagent jobs'))).toBe(true);
    });
  });

  describe('/bgsub (list)', () => {
    it('empty registry → info message', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      const { ctx, lines } = makeCtx();
      const result = await bgsubCmd.handler(ctx, '');
      expect(result).toBe('continue');
      expect(lines.some((l) => l.startsWith('INFO:No background subagent jobs.'))).toBe(true);
    });

    it('populated registry → one row per job, includes jobId', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      const { handle } = makeBgHandle('sub-A');
      const job = registry.register({ handle, prompt: 'investigate stash 2', model: 'sonnet' });

      const { ctx, lines } = makeCtx();
      await bgsubCmd.handler(ctx, '');
      const flat = lines.join('\n');
      expect(flat).toContain(job.jobId);
      expect(flat).toContain('investigate stash 2');
    });
  });

  describe('/bgsub <id> / /bgsub:status <id>', () => {
    it('unknown id → error', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      const { ctx, lines } = makeCtx();
      await bgsubStatusCmd.handler(ctx, 'nope');
      expect(lines.some((l) => l.startsWith('ERROR:No background job'))).toBe(true);
    });

    it('known id → renders detail including status', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      const { handle } = makeBgHandle('sub-B');
      const job = registry.register({ handle, prompt: 'work', model: 'opus' });

      const { ctx, lines } = makeCtx();
      await bgsubStatusCmd.handler(ctx, job.jobId);
      const flat = lines.join('\n');
      expect(flat).toContain(job.jobId);
      expect(flat).toContain('Status:');
      expect(flat).toContain('running');
      expect(flat).toContain('opus');
    });
  });

  describe('/bgsub:join', () => {
    it('waits for terminal state and prints result text', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      const { handle, fireTerminal } = makeBgHandle('sub-C');
      const job = registry.register({ handle, prompt: 'do thing', model: 'sonnet' });

      // Kick off the join in parallel with the simulated terminal transition.
      const { ctx, lines } = makeCtx();
      const joinPromise = bgsubJoinCmd.handler(ctx, job.jobId);

      // Allow the join() await to register before we fire the callback.
      await Promise.resolve();
      fireTerminal({
        id: 'sub-C',
        status: 'succeeded',
        message: { role: 'assistant', content: 'final answer line one\nline two' } as any,
      });

      await joinPromise;
      const flat = lines.join('\n');
      expect(flat).toContain('final answer line one');
      expect(flat).toContain('completed');
    });

    it('on a failed job → reports error', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      const { handle, fireTerminal } = makeBgHandle('sub-D');
      const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });

      const { ctx, lines } = makeCtx();
      const joinPromise = bgsubJoinCmd.handler(ctx, job.jobId);
      await Promise.resolve();
      fireTerminal({
        id: 'sub-D',
        status: 'failed',
        error: new Error('child blew up'),
      });

      await joinPromise;
      const flat = lines.join('\n');
      expect(flat).toContain('child blew up');
      expect(flat).toContain('failed');
    });

    it('unknown id → error (does not throw)', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      const { ctx, lines } = makeCtx();
      const result = await bgsubJoinCmd.handler(ctx, 'no-such');
      expect(result).toBe('continue');
      expect(lines.some((l) => l.startsWith('ERROR:No background job'))).toBe(true);
    });
  });

  describe('/bgsub:cancel', () => {
    it('calls registry.cancelJob for a running job', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      const { handle, cancelMock } = makeBgHandle('sub-E');
      const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });

      const { ctx } = makeCtx();
      await bgsubCancelCmd.handler(ctx, job.jobId);
      expect(cancelMock).toHaveBeenCalledTimes(1);
    });

    it('already-terminal job → info message, no cancel call', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      const { handle, fireTerminal, cancelMock } = makeBgHandle('sub-F');
      const job = registry.register({ handle, prompt: 'p', model: 'sonnet' });
      fireTerminal({
        id: 'sub-F',
        status: 'succeeded',
        message: { role: 'assistant', content: 'done' } as any,
      });

      const { ctx, lines } = makeCtx();
      await bgsubCancelCmd.handler(ctx, job.jobId);
      expect(cancelMock).not.toHaveBeenCalled();
      expect(lines.some((l) => l.startsWith('INFO:Job '))).toBe(true);
    });

    it('unknown id → error', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      const { ctx, lines } = makeCtx();
      await bgsubCancelCmd.handler(ctx, 'no-such');
      expect(lines.some((l) => l.startsWith('ERROR:No background job'))).toBe(true);
    });
  });

  describe('/bgsub list with summarizer', () => {
    it('without summarizer: original one-line output is preserved (no summary line)', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      // No summarizer wired
      const { handle } = makeBgHandle('sub-sum-1');
      const job = registry.register({ handle, prompt: 'analyze code', model: 'sonnet' });

      const { ctx, lines } = makeCtx();
      await bgsubCmd.handler(ctx, '');
      const flat = lines.join('\n');
      expect(flat).toContain(job.jobId);
      // No "↳" indicator
      expect(flat).not.toContain('↳');
    });

    it('with summarizer + summary present: second indented line with Ns ago appears', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);

      const { handle } = makeBgHandle('sub-sum-2');
      const job = registry.register({ handle, prompt: 'scan files', model: 'sonnet' });

      const summaryMap: Record<string, SummaryEntry> = {
        [job.jobId]: {
          text: 'reading src/agent/session.ts',
          refreshedAt: Date.now() - 5000,
          stale: false,
        },
      };
      setBgsubSummarizer(makeMockSummarizer(summaryMap));

      const { ctx, lines } = makeCtx();
      await bgsubCmd.handler(ctx, '');
      const flat = lines.join('\n');
      expect(flat).toContain(job.jobId);
      expect(flat).toContain('↳');
      expect(flat).toContain('reading src/agent/session.ts');
      // Should contain "s ago" (age indicator)
      expect(flat).toMatch(/\d+s ago/);
      // No [stale] suffix
      expect(flat).not.toContain('[stale]');
    });

    it('with stale summary: [stale] suffix appears', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);

      const { handle } = makeBgHandle('sub-sum-3');
      const job = registry.register({ handle, prompt: 'run tests', model: 'sonnet' });

      const summaryMap: Record<string, SummaryEntry> = {
        [job.jobId]: {
          text: 'running vitest',
          refreshedAt: Date.now() - 30_000,
          stale: true,
        },
      };
      setBgsubSummarizer(makeMockSummarizer(summaryMap));

      const { ctx, lines } = makeCtx();
      await bgsubCmd.handler(ctx, '');
      const flat = lines.join('\n');
      expect(flat).toContain('[stale]');
      expect(flat).toContain('running vitest');
    });
  });

  describe('/bgsub:join — disk log fallback for evicted jobs', () => {
    it('falls back to disk replay when job is not in memory', async () => {
      // Seed a job on disk without going through the registry
      const { BgJobLogWriter } = await import('../../../agent/bg-job-log.js');
      const evictedJobId = `evicted-${Date.now()}`;
      const w = new BgJobLogWriter(evictedJobId);
      await w.writeMeta({
        jobId: evictedJobId,
        subagentId: `sub-evicted`,
        label: 'evicted test job',
        prompt: 'do evicted work',
        model: 'sonnet',
        startedAt: Date.now() - 5000,
        status: 'completed',
        endedAt: Date.now() - 1000,
        schemaVersion: 1,
      });
      w.write({
        type: 'chunk',
        chunk: { type: 'content', content: 'evicted output text' } as any,
      });
      await w.close();

      // Set up the registry (job is NOT in it)
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);
      expect(registry.get(evictedJobId)).toBeUndefined();

      const { ctx, lines } = makeCtx();
      const result = await bgsubJoinCmd.handler(ctx, evictedJobId);
      expect(result).toBe('continue');

      const flat = lines.join('\n');
      // Should surface the "evicted from memory" notice
      expect(flat).toContain('Job evicted from memory');
      // Should contain the replayed content
      expect(flat).toContain('evicted output text');
      // Should show the final status
      expect(flat).toContain('completed');
    });

    it('returns error when job not in memory AND not on disk', async () => {
      const registry = new BackgroundAgentRegistry({});
      setBgsubRegistry(registry);

      const { ctx, lines } = makeCtx();
      const result = await bgsubJoinCmd.handler(ctx, 'totally-unknown-job-xyz');
      expect(result).toBe('continue');
      expect(lines.some((l) => l.startsWith('ERROR:No background job'))).toBe(true);
    });
  });
});
