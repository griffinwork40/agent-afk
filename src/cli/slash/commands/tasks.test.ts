/**
 * Tests for the /tasks family of slash commands.
 *
 * Covers:
 *  - /tasks with no registry → error
 *  - /tasks with active + completed handles → one row each
 *  - /tasks:view with unknown id → no-events info
 *  - /tasks:cancel on a non-running handle → info message
 *  - /tasks:cancel on unknown id → error
 *  - /tasks interactive Enter path: enterTaskViewMode rejection → error logged, resolves (#1334)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Temp AFK_HOME so disk lookups don't touch real ~/.afk
const tasksTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-tasks-test-'));
process.env['AFK_HOME'] = tasksTmpDir;

// Mock task-view-mode so tests can control enterTaskViewMode behaviour without
// rendering real TUI output or touching disk.
vi.mock('../../commands/interactive/task-view-mode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../commands/interactive/task-view-mode.js')>();
  return {
    ...actual,
    enterTaskViewMode: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  tasksCmd,
  tasksViewCmd,
  tasksCancelCmd,
  setTasksRegistry,
  setTasksIctx,
  resetTasksRegistry,
} from './tasks.js';
import { enterTaskViewMode } from '../../commands/interactive/task-view-mode.js';
import type { SubagentManager } from '../../../agent/subagent.js';
import type { SubagentHandle } from '../../../agent/subagent/handle.js';
import type { SubagentStatus } from '../../../agent/subagent/result.js';
import { CompletedCache } from '../../../agent/subagent/completed-cache.js';
import type { SlashContext, SessionStats } from '../types.js';
import type { InteractiveCtx } from '../../commands/interactive/shared.js';

const mockedEnterTaskViewMode = vi.mocked(enterTaskViewMode);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeHandle(id: string, status: SubagentStatus = 'running'): SubagentHandle {
  return {
    id,
    status,
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(),
    runToResult: vi.fn(),
    runInBackground: vi.fn(),
    session: {
      getHistory: vi.fn().mockReturnValue([]),
      sessionId: `sess-${id}`,
    },
  } as unknown as SubagentHandle;
}

function makeManager(
  active: SubagentHandle[],
  completedEntries: { id: string; handle: SubagentHandle }[] = [],
): SubagentManager {
  const completedCache = new CompletedCache();
  for (const { id, handle } of completedEntries) {
    completedCache.add(id, handle, {
      id,
      status: 'succeeded',
    } as unknown as import('../../../agent/subagent/result.js').SubagentResult);
  }

  return {
    list: () => active.map(h => ({ id: h.id, status: h.status })),
    get: (id: string) => {
      const found = active.find(h => h.id === id);
      if (found) return found;
      return completedCache.get(id)?.handle;
    },
    completed: completedCache,
  } as unknown as SubagentManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SESSION_LABEL = 'test-tasks-session';

describe('/tasks slash commands', () => {
  beforeEach(() => {
    resetTasksRegistry();
    mockedEnterTaskViewMode.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Missing registry
  // -------------------------------------------------------------------------

  describe('missing registry', () => {
    it('/tasks without a wired registry → error', async () => {
      const { ctx, lines } = makeCtx();
      const result = await tasksCmd.handler(ctx, '');
      expect(result).toBe('continue');
      expect(lines.some(l => l.startsWith('ERROR:'))).toBe(true);
    });

    it('/tasks:view without a wired registry → error', async () => {
      const { ctx, lines } = makeCtx();
      await tasksViewCmd.handler(ctx, 'some-id');
      expect(lines.some(l => l.startsWith('ERROR:'))).toBe(true);
    });

    it('/tasks:cancel without a wired registry → error', async () => {
      const { ctx, lines } = makeCtx();
      await tasksCancelCmd.handler(ctx, 'some-id');
      expect(lines.some(l => l.startsWith('ERROR:'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // /tasks (list)
  // -------------------------------------------------------------------------

  describe('/tasks (list)', () => {
    it('empty manager → info message', async () => {
      const manager = makeManager([]);
      setTasksRegistry(manager, SESSION_LABEL);
      const { ctx, lines } = makeCtx();
      const result = await tasksCmd.handler(ctx, '');
      expect(result).toBe('continue');
      expect(lines.some(l => l.startsWith('INFO:No subagents'))).toBe(true);
    });

    it('one active handle → row contains its id', async () => {
      const h = makeHandle('sub-active-1');
      const manager = makeManager([h]);
      setTasksRegistry(manager, SESSION_LABEL);
      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, '');
      const flat = lines.join('\n');
      expect(flat).toContain('sub-active-1');
    });

    it('completed entries are listed separately from active ones', async () => {
      const active = makeHandle('sub-active-2', 'running');
      const done = makeHandle('sub-done-1', 'succeeded');
      const manager = makeManager([active], [{ id: 'sub-done-1', handle: done }]);
      setTasksRegistry(manager, SESSION_LABEL);
      const { ctx, lines } = makeCtx();
      await tasksCmd.handler(ctx, '');
      const flat = lines.join('\n');
      expect(flat).toContain('sub-active-2');
      expect(flat).toContain('sub-done-1');
    });
  });

  // -------------------------------------------------------------------------
  // /tasks:view
  // -------------------------------------------------------------------------

  describe('/tasks:view', () => {
    it('no arg → info usage message', async () => {
      const manager = makeManager([]);
      setTasksRegistry(manager, SESSION_LABEL);
      const { ctx, lines } = makeCtx();
      await tasksViewCmd.handler(ctx, '');
      expect(lines.some(l => l.startsWith('INFO:') && l.includes('Usage'))).toBe(true);
    });

    it('unknown id → no events info message (disk fallback yields nothing)', async () => {
      const manager = makeManager([]);
      setTasksRegistry(manager, SESSION_LABEL);
      const { ctx, lines } = makeCtx();
      await tasksViewCmd.handler(ctx, 'non-existent-id');
      // Disk fallback for unknown session/subagent returns empty → info
      expect(lines.some(l => l.startsWith('INFO:No events found'))).toBe(true);
    });

    it('active handle with history → calls enterTaskViewMode for the resolved id', async () => {
      const h = makeHandle('sub-history-1', 'running');
      const manager = makeManager([h]);
      setTasksRegistry(manager, SESSION_LABEL);
      const { ctx } = makeCtx();
      mockedEnterTaskViewMode.mockResolvedValueOnce(undefined);
      await tasksViewCmd.handler(ctx, 'sub-history-1');
      expect(mockedEnterTaskViewMode).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sub-history-1' }),
      );
    });

    it('setTasksIctx threads ictx into the TaskViewEntry passed to enterTaskViewMode (#1332)', async () => {
      // Verify that after calling setTasksIctx(ictx), the ictx reference
      // is included in the TaskViewEntry so enterTaskViewMode can set
      // viewingTaskId on the live REPL context.
      const h = makeHandle('sub-ictx-1', 'running');
      const manager = makeManager([h]);
      setTasksRegistry(manager, SESSION_LABEL);

      const fakeIctx = { viewingTaskId: undefined } as unknown as InteractiveCtx;
      setTasksIctx(fakeIctx);

      const { ctx } = makeCtx();
      mockedEnterTaskViewMode.mockResolvedValueOnce(undefined);
      await tasksViewCmd.handler(ctx, 'sub-ictx-1');

      expect(mockedEnterTaskViewMode).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sub-ictx-1', ictx: fakeIctx }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // /tasks:cancel
  // -------------------------------------------------------------------------

  describe('/tasks:cancel', () => {
    it('no arg → info usage message', async () => {
      const manager = makeManager([]);
      setTasksRegistry(manager, SESSION_LABEL);
      const { ctx, lines } = makeCtx();
      await tasksCancelCmd.handler(ctx, '');
      expect(lines.some(l => l.startsWith('INFO:') && l.includes('Usage'))).toBe(true);
    });

    it('unknown id → error message', async () => {
      const manager = makeManager([]);
      setTasksRegistry(manager, SESSION_LABEL);
      const { ctx, lines } = makeCtx();
      await tasksCancelCmd.handler(ctx, 'ghost-id');
      expect(lines.some(l => l.startsWith('ERROR:') && l.includes('ghost-id'))).toBe(true);
    });

    it('already-succeeded handle → info message (nothing to cancel)', async () => {
      const h = makeHandle('sub-done-2', 'succeeded');
      const manager = makeManager([], [{ id: 'sub-done-2', handle: h }]);
      // Make get() return the handle
      (manager as unknown as { get: ReturnType<typeof vi.fn> }).get
        = vi.fn().mockImplementation((id: string) =>
          id === 'sub-done-2' ? h : undefined,
        );
      setTasksRegistry(manager, SESSION_LABEL);
      const { ctx, lines } = makeCtx();
      await tasksCancelCmd.handler(ctx, 'sub-done-2');
      // Non-running handle → info not error
      expect(lines.some(l => l.startsWith('INFO:') && l.includes('already'))).toBe(true);
    });

    it('running handle → cancel() is called', async () => {
      const h = makeHandle('sub-running-1', 'running');
      const manager = makeManager([h]);
      setTasksRegistry(manager, SESSION_LABEL);
      const { ctx } = makeCtx();
      await tasksCancelCmd.handler(ctx, 'sub-running-1');
      expect(h.cancel).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // /tasks interactive Enter path: enterTaskViewMode rejection → error logged (#1334)
  // -------------------------------------------------------------------------

  describe('/tasks interactive — enterTaskViewMode rejection', () => {
    it('logs the error and resolves instead of swallowing it silently', async () => {
      // Arrange: one active handle so the list is non-empty.
      const h = makeHandle('sub-err-1', 'running');
      const manager = makeManager([h]);
      setTasksRegistry(manager, SESSION_LABEL);

      const errorLines: string[] = [];
      const ctx: SlashContext = {
        session: { current: {} } as unknown as SlashContext['session'],
        stats: {
          totalTurns: 0, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0,
          sessionStartTime: Date.now(), turnCosts: [], turnTokens: [], turns: [],
          model: 'sonnet', permissionMode: 'default',
        },
        out: {
          line: vi.fn(),
          raw: vi.fn(),
          success: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: (t: string): void => { errorLines.push(t); },
        },
        ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
        // Provide setSoftStopHandler to enter interactive mode.
        setSoftStopHandler: vi.fn(),
      };

      // Make enterTaskViewMode reject with a known error.
      mockedEnterTaskViewMode.mockRejectedValueOnce(new Error('boom'));

      // Start the handler — it awaits stdin input after collectAllTasks (async).
      const handlerPromise = tasksCmd.handler(ctx, '');

      // Wait for the async collectAllTasks + renderList + stdin.on() to complete
      // before firing the simulated keypress.
      await new Promise<void>((r) => setTimeout(r, 50));
      process.stdin.emit('data', '\r');

      // Wait for the handler to settle (enterTaskViewMode rejects → catch logs → resolve).
      await handlerPromise;

      // The error must have been logged (not swallowed).
      expect(errorLines.length).toBeGreaterThan(0);
      expect(errorLines.some(l => l.includes('task view error') && l.includes('boom'))).toBe(true);
    }, 10_000);
  });
});
