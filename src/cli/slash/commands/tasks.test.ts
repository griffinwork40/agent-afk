/**
 * Tests for the unified /tasks slash command.
 *
 * Covers:
 *  - Missing manager → error path
 *  - Empty unified list → info message
 *  - List rendering with both turn-tasks and subagent-jobs, recency-desc
 *  - /tasks <id> → turn-task detail (with result text)
 *  - /tasks <id> → subagent-job detail (NEVER prints result text — invariant)
 *  - /tasks <id> → unknown id → error
 *  - Subagent-only rows still render even when no turn-tasks exist
 *
 * Critical invariant: when /tasks <id> matches a subagent job, the handler
 * must NOT print the job's SubagentResult text. The operator has to go
 * through /bgsub:join to retrieve that, which is the only path that surfaces
 * subagent output to the model. A regression here would let the operator
 * read background subagent results without the model ever seeing them —
 * defeating the whole point of mode:'background'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  tasksCmd,
  setTasksManager,
  setTasksRegistry,
  resetTasksRefs,
} from './tasks.js';
import { BackgroundTaskManager } from '../../commands/interactive/background.js';
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
    planMode: false,
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

/**
 * Stub a `SubagentHandle` for registry.register(). The runInBackground
 * callback is captured but never fired in /tasks tests — we don't need
 * terminal transitions here, only registration.
 */
function makeBgHandle(id = 'sub-1'): SubagentHandle {
  return {
    id,
    status: 'idle',
    runInBackground: vi.fn((_p: string, _on?: (r: SubagentResult) => void) => {}),
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(),
    runToResult: vi.fn(),
  } as unknown as SubagentHandle;
}

describe('/tasks slash command', () => {
  beforeEach(() => {
    resetTasksRefs();
  });

  describe('missing manager', () => {
    it('without a wired manager → error and returns continue', async () => {
      const { ctx, lines } = makeCtx();
      const result = await tasksCmd.handler(ctx, '');
      expect(result).toBe('continue');
      expect(lines.some((l) => l.startsWith('ERROR:Background tasks not available'))).toBe(true);
    });
  });

  describe('empty list', () => {
    it('no turn-tasks, no registry → info message mentions all entry points', async () => {
      setTasksManager(new BackgroundTaskManager());
      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, '');
      const flat = lines.join('\n');
      expect(flat).toMatch(/INFO:No background tasks/);
      expect(flat).toContain('Ctrl+B');
      expect(flat).toContain('/bg');
    });

    it('no turn-tasks, empty registry wired → still info message', async () => {
      setTasksManager(new BackgroundTaskManager());
      setTasksRegistry(new BackgroundAgentRegistry({}));
      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, '');
      expect(lines.some((l) => l.startsWith('INFO:No background tasks'))).toBe(true);
    });
  });

  describe('list rendering (no args)', () => {
    it('renders turn-task rows when no registry is wired', async () => {
      const mgr = new BackgroundTaskManager();
      mgr.register('first turn');
      mgr.register('second turn');
      setTasksManager(mgr);

      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, '');
      const flat = lines.join('\n');
      expect(flat).toContain('first turn');
      expect(flat).toContain('second turn');
      // No subagent kind glyph should appear when registry isn't wired.
      expect(flat).not.toContain('◆');
    });

    it('renders subagent-job rows when only the registry is wired', async () => {
      setTasksManager(new BackgroundTaskManager());
      const registry = new BackgroundAgentRegistry({});
      setTasksRegistry(registry);
      registry.register({ handle: makeBgHandle('sub-A'), prompt: 'investigate stash', model: 'sonnet' });

      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, '');
      const flat = lines.join('\n');
      expect(flat).toContain('investigate stash');
      // Subagent kind glyph present.
      expect(flat).toContain('◆');
    });

    it('mixes both kinds and sorts by recency (newest first)', async () => {
      const mgr = new BackgroundTaskManager();
      const registry = new BackgroundAgentRegistry({});
      setTasksManager(mgr);
      setTasksRegistry(registry);

      // Order of registration: turn-old, sub-mid, turn-new.
      // The recency sort should put turn-new first, then sub-mid, then turn-old.
      //
      // We must control Date.now() *before* each register() call rather than
      // mutating startedAt on the returned object afterwards. Reason:
      // BackgroundAgentRegistry.register() returns a snapshot copy of its
      // InternalJob (background-registry.ts:214) — mutating that copy is a
      // no-op because list() re-snapshots from the unchanged InternalJob.
      // (BackgroundTaskManager returns live refs, so post-mutation would
      // work there, but we use one mechanism for both for consistency.)
      // On fast CI machines all three Date.now() calls return the same ms,
      // making the sort fall back to insertion order — flaky and wrong.
      const t1 = 1_700_000_000_000;
      const dateNowSpy = vi.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(t1 - 200);
      mgr.register('OLD-TURN');
      dateNowSpy.mockReturnValue(t1 - 100);
      registry.register({ handle: makeBgHandle('sub-mid'), prompt: 'MID-SUB', model: 'sonnet' });
      dateNowSpy.mockReturnValue(t1);
      mgr.register('NEW-TURN');
      dateNowSpy.mockRestore();

      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, '');

      // Find each label's line index.
      const idxNew = lines.findIndex((l) => l.includes('NEW-TURN'));
      const idxMid = lines.findIndex((l) => l.includes('MID-SUB'));
      const idxOld = lines.findIndex((l) => l.includes('OLD-TURN'));

      expect(idxNew).toBeGreaterThanOrEqual(0);
      expect(idxMid).toBeGreaterThanOrEqual(0);
      expect(idxOld).toBeGreaterThanOrEqual(0);
      expect(idxNew).toBeLessThan(idxMid);
      expect(idxMid).toBeLessThan(idxOld);
    });
  });

  describe('/tasks <id> — turn-task lookup', () => {
    it('renders detail including status and result text when present', async () => {
      const mgr = new BackgroundTaskManager();
      const task = mgr.register('do the work');
      mgr.complete(task.id, 'final answer line one\nline two');
      setTasksManager(mgr);

      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, task.id);
      const flat = lines.join('\n');
      expect(flat).toContain('do the work');
      expect(flat).toContain('Status:');
      expect(flat).toContain('succeeded');
      expect(flat).toContain('final answer line one');
      expect(flat).toContain('line two');
    });

    it('turn-task error path renders error message', async () => {
      const mgr = new BackgroundTaskManager();
      const task = mgr.register('broken work');
      mgr.fail(task.id, new Error('boom'));
      setTasksManager(mgr);

      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, task.id);
      expect(lines.some((l) => l.startsWith('ERROR:') && l.includes('boom'))).toBe(true);
    });
  });

  describe('/tasks <id> — subagent-job lookup', () => {
    it('renders detail (status, subagent id, model) but NEVER the result text', async () => {
      setTasksManager(new BackgroundTaskManager());
      const registry = new BackgroundAgentRegistry({});
      setTasksRegistry(registry);
      const job = registry.register({
        handle: makeBgHandle('sub-secret'),
        prompt: 'analyze logs',
        model: 'opus',
      });

      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, job.jobId);
      const flat = lines.join('\n');

      expect(flat).toContain(job.jobId);
      expect(flat).toContain('analyze logs');
      expect(flat).toContain('Status:');
      expect(flat).toContain('running');
      expect(flat).toContain('sub-secret');
      expect(flat).toContain('opus');
      // Critical invariant: the join-prompt hint must be surfaced so the
      // operator knows the only sanctioned path to the result.
      expect(flat).toContain('/bgsub:join');
    });

    it('result text is NEVER printed even when the job has settled', async () => {
      setTasksManager(new BackgroundTaskManager());
      const registry = new BackgroundAgentRegistry({});
      setTasksRegistry(registry);

      // Capture the runInBackground callback so we can fire a terminal result.
      let captured: ((r: SubagentResult) => void) | undefined;
      const handle = {
        id: 'sub-settled',
        status: 'idle',
        runInBackground: vi.fn((_p: string, on?: (r: SubagentResult) => void) => {
          captured = on;
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
        teardown: vi.fn().mockResolvedValue(undefined),
        run: vi.fn(),
        runToResult: vi.fn(),
      } as unknown as SubagentHandle;

      const job = registry.register({ handle, prompt: 'do thing', model: 'sonnet' });

      // Fire terminal — job is now 'completed' and has a result in the registry.
      captured?.({
        id: 'sub-settled',
        status: 'succeeded',
        message: {
          role: 'assistant',
          content: 'SECRET_LEAKED_RESULT_TEXT_should_never_appear',
        } as unknown as SubagentResult['message'],
      } as SubagentResult);

      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, job.jobId);
      const flat = lines.join('\n');

      // Invariant assertion: the result text MUST NOT appear in /tasks output.
      expect(flat).not.toContain('SECRET_LEAKED_RESULT_TEXT_should_never_appear');
      // The hint pointing to /bgsub:join must still appear.
      expect(flat).toContain('/bgsub:join');
    });
  });

  describe('/tasks <id> — not found', () => {
    it('unknown id with manager + registry wired → error', async () => {
      setTasksManager(new BackgroundTaskManager());
      setTasksRegistry(new BackgroundAgentRegistry({}));
      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, 'does-not-exist');
      expect(lines.some((l) => l.startsWith('ERROR:No task or job found'))).toBe(true);
    });

    it('turn-task match shadows registry match on identical ids', async () => {
      // Construct ids so they collide. BackgroundTaskManager auto-assigns
      // 'bg-1'; BackgroundAgentRegistry auto-assigns 'bgsub-1'. No natural
      // collision possible — but the /tasks contract says turn-task wins
      // when both exist. We verify by giving a registry-only id and
      // confirming registry lookup runs when manager.get returns undefined.
      const mgr = new BackgroundTaskManager();
      const registry = new BackgroundAgentRegistry({});
      setTasksManager(mgr);
      setTasksRegistry(registry);
      const job = registry.register({
        handle: makeBgHandle('sub-only'),
        prompt: 'registry-only',
        model: 'sonnet',
      });

      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, job.jobId);
      const flat = lines.join('\n');
      expect(flat).toContain(job.jobId);
      expect(flat).toContain('registry-only');
    });
  });
});
