/**
 * /tasks — list and view subagent conversations from the REPL.
 *
 * Commands:
 *   /tasks               list all subagents with cursor navigation
 *   /tasks:view <id>     enter live view mode for a subagent conversation
 *   /tasks:cancel <id>   cancel a still-running subagent
 *
 * Data sources (in resolution order for /tasks):
 *   1. SubagentManager.list()         — active (running) handles
 *   2. manager.completed.list()       — recently-completed handles (LRU cache)
 *   3. SubagentLogReader.list(label)  — disk-persisted logs not in memory
 *
 * v2 additions:
 *   - `/tasks` shows a cursor-navigable list; Enter opens the view, Esc returns.
 *   - `/tasks:view <id>` enters live view mode via enterTaskViewMode().
 *   - Live tailing streams new output events until completion or Esc.
 *
 * Wiring: call `setTasksRegistry` once from bootstrapSession after the
 * SubagentManager is constructed. The manager reference is kept as a
 * module-scope var (same pattern as bgsub.ts).
 *
 * @module cli/slash/commands/tasks
 */

import { palette } from '../../palette.js';
import { formatDuration } from '../../format-utils.js';
import type { SlashCommand } from '../types.js';
import type { SubagentManager } from '../../../agent/subagent.js';
import type { SubagentStatus } from '../../../agent/subagent/result.js';
import { SubagentLogReader } from '../../../agent/subagent/log.js';
import {
  enterTaskViewMode,
  type TaskViewEntry,
} from '../../commands/interactive/task-view-mode.js';
import type { InteractiveCtx } from '../../commands/interactive/shared.js';
import type { PickerController } from '../../terminal-compositor.js';

// ---------------------------------------------------------------------------
// Module-scope registry refs
// ---------------------------------------------------------------------------

let managerRef: SubagentManager | undefined;
let sessionLabelRef: string | undefined;
let ictxRef: InteractiveCtx | undefined;

/**
 * Wire the SubagentManager and session label into this module.
 * Called once by bootstrapSession after the manager is constructed.
 */
export function setTasksRegistry(manager: SubagentManager, sessionLabel: string): void {
  managerRef = manager;
  sessionLabelRef = sessionLabel;
}

/**
 * Wire the InteractiveCtx so that `/tasks:view` can populate
 * `viewingTaskId` on the active REPL context (#1332).
 * Called once from bootstrapSession after `ctx` is constructed.
 */
export function setTasksIctx(ictx: InteractiveCtx): void {
  ictxRef = ictx;
}

/** Reset refs — used by tests to isolate module-scope state between cases. */
export function resetTasksRegistry(): void {
  managerRef = undefined;
  sessionLabelRef = undefined;
  ictxRef = undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Ctx = Parameters<SlashCommand['handler']>[0];

const STATUS_GLYPHS: Record<SubagentStatus, string> = {
  idle:      '·',
  running:   '⟳',
  succeeded: '✓',
  failed:    '✗',
  cancelled: '⊘',
};

function ensureManager(ctx: Ctx): SubagentManager | null {
  if (!managerRef) {
    ctx.out.error('Subagent manager is not available in this session.');
    return null;
  }
  return managerRef;
}

function ensureSessionLabel(ctx: Ctx): string | null {
  if (!sessionLabelRef) {
    ctx.out.error('Session label is not available — cannot access subagent logs.');
    return null;
  }
  return sessionLabelRef;
}

/**
 * Resolve a subagent by partial-ID prefix across active + completed.
 * Returns the full handle ID on match, or null when ambiguous / not found.
 */
function resolveId(manager: SubagentManager, raw: string): string | null {
  const handle = manager.get(raw);
  if (handle) return handle.id;

  // Prefix match against completed cache.
  const completedMatches = manager.completed
    .list()
    .filter(e => e.handle.id.startsWith(raw))
    .map(e => e.handle.id);

  if (completedMatches.length === 1 && completedMatches[0] !== undefined) {
    return completedMatches[0];
  }
  return null;
}

function formatHandleLine(
  id: string,
  status: SubagentStatus,
  agentType: string | undefined,
  durationMs: number | undefined,
  toolCount: number,
  cursor = false,
): string {
  const glyph   = STATUS_GLYPHS[status];
  const shortId  = id.slice(0, 12);
  const typeLabel = agentType ? palette.dim(`[${agentType}]`) : '';
  const dur      = durationMs !== undefined ? palette.dim(`${formatDuration(durationMs)}`) : '';
  const tools    = palette.dim(`${toolCount} calls`);
  const cursorGlyph = cursor ? '▶' : ' ';
  const idFormatted = cursor ? palette.bold(shortId) : shortId;
  const parts = [
    `  ${cursorGlyph} ${glyph}`,
    idFormatted,
    typeLabel,
    dur,
    tools,
  ].filter(Boolean);
  return parts.join('  ');
}

// ---------------------------------------------------------------------------
// All-IDs collector (shared by /tasks and tasksViewCmd)
// ---------------------------------------------------------------------------

interface TaskEntry {
  id: string;
  status: SubagentStatus;
  agentType?: string;
  durationMs?: number;
  toolCount: number;
}

async function collectAllTasks(
  manager: SubagentManager,
  sessionLabel: string,
): Promise<TaskEntry[]> {
  const entries: TaskEntry[] = [];

  // Active handles.
  for (const { id, status } of manager.list()) {
    const handle = manager.get(id);
    const impl   = handle as unknown as { _agentType?: string; _currentTrace?: { toolCalls: unknown[] } };
    entries.push({
      id,
      status,
      agentType: impl._agentType,
      toolCount: impl._currentTrace?.toolCalls.length ?? 0,
    });
  }

  // Completed handles.
  const activeIds = new Set(manager.list().map(h => h.id));
  for (const entry of manager.completed.list()) {
    if (activeIds.has(entry.handle.id)) continue;
    const impl = entry.handle as unknown as {
      _agentType?: string;
      _currentTrace?: { toolCalls: unknown[] };
    };
    entries.push({
      id: entry.handle.id,
      status: entry.handle.status,
      agentType: impl._agentType,
      durationMs: entry.handle.lastDurationMs,
      toolCount: impl._currentTrace?.toolCalls.length ?? 0,
    });
  }

  // Disk-only.
  const memoryIds = new Set(entries.map(e => e.id));
  const diskIds   = (await SubagentLogReader.list(sessionLabel)).filter(id => !memoryIds.has(id));
  for (const id of diskIds) {
    entries.push({ id, status: 'succeeded', toolCount: 0 });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// /tasks — cursor-navigable list
// ---------------------------------------------------------------------------

export const tasksCmd: SlashCommand = {
  name: '/tasks',
  summary: 'List all subagents (active + recently completed) with cursor navigation',
  usage: '/tasks',
  hint: 'When you want to see what subagents this session has spawned. Use ↑/↓ to navigate, Enter to view, Esc to return.',
  async handler(ctx) {
    const manager      = ensureManager(ctx);
    if (!manager) return 'continue';
    const sessionLabel = ensureSessionLabel(ctx);
    if (!sessionLabel) return 'continue';

    const tasks = await collectAllTasks(manager, sessionLabel);
    if (tasks.length === 0) {
      ctx.out.info('No subagents in this session yet.');
      return 'continue';
    }

    // ── Cursor navigation state ──────────────────────────────────────────────
    let cursor = 0;

    // ── If no compositor available, fall back to plain list ──────────────────
    const compositor = ctx.getCompositor?.();
    if (!compositor) {
      ctx.out.line(palette.dim(`  ${'STATUS'.padEnd(2)}  ${'ID'.padEnd(12)}  DETAILS`));
      for (const t of tasks) {
        ctx.out.line(formatHandleLine(t.id, t.status, t.agentType, t.durationMs, t.toolCount));
      }
      ctx.out.line(palette.dim('  Use /tasks:view <id> to open a task.'));
      return 'continue';
    }

    // ── Interactive mode — route through compositor picker mode ───────────────
    // Renders the task list as rows in the compositor's input region, routing
    // all keystrokes through the compositor's existing raw-mode pipeline.
    // This preserves the single-consumer stdin invariant (PR #511) and avoids
    // the phantom-turn bug that direct process.stdin listeners can introduce.

    await new Promise<void>((resolve) => {
      let pickerResolved = false;

      const finish = (): void => {
        if (pickerResolved) return;
        pickerResolved = true;
        compositor.exitPickerMode();
        ctx.setSoftStopHandler?.(null);
        ctx.ui.clearScreen();
        ctx.ui.repaintStatusLine();
        resolve();
      };

      const renderRows = (): readonly string[] => {
        const rows: string[] = [];
        rows.push(palette.dim(`  Subagent list — ↑/↓ navigate  Enter view  Esc return`));
        rows.push('');
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i]!;
          rows.push(formatHandleLine(t.id, t.status, t.agentType, t.durationMs, t.toolCount, i === cursor));
        }
        rows.push('');
        return rows;
      };

      const onKey: PickerController['onKey'] = (_char, key): void => {
        if (pickerResolved) return;

        if (key.name === 'up') {
          cursor = Math.max(0, cursor - 1);
          compositor.repaintPicker();
        } else if (key.name === 'down') {
          cursor = Math.min(tasks.length - 1, cursor + 1);
          compositor.repaintPicker();
        } else if (key.name === 'return') {
          // Enter — open the selected task in view mode.
          const selected = tasks[cursor];
          if (selected) {
            pickerResolved = true;
            compositor.exitPickerMode();
            ctx.setSoftStopHandler?.(null);
            const entry: TaskViewEntry = {
              id: selected.id,
              manager,
              sessionLabel,
              ctx,
              ictx: ictxRef,
            };
            void enterTaskViewMode(entry).then(resolve).catch((e) => {
              ctx.out.error?.(`task view error: ${String(e)}`);
              resolve();
            });
          }
        } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          // Esc or Ctrl-C — exit to main prompt.
          finish();
        }
      };

      // Wire Esc handler via the surface-level soft-stop.
      ctx.setSoftStopHandler?.(() => { finish(); });

      compositor.enterPickerMode({ renderRows, onKey });
    });

    return 'continue';
  },
};

// ---------------------------------------------------------------------------
// /tasks:view — live view mode
// ---------------------------------------------------------------------------

export const tasksViewCmd: SlashCommand = {
  name: '/tasks:view',
  summary: 'View a subagent\'s conversation (live view mode)',
  usage: '/tasks:view <id>',
  hint: 'When you want to replay what a subagent said and which tools it called. Tails live output for running subagents.',
  async handler(ctx, args) {
    const manager      = ensureManager(ctx);
    if (!manager) return 'continue';
    const sessionLabel = ensureSessionLabel(ctx);
    if (!sessionLabel) return 'continue';

    const raw = args.trim();
    if (!raw) {
      ctx.out.info('Usage: /tasks:view <id>');
      return 'continue';
    }

    // Resolve partial-id prefix.
    const resolvedId = resolveId(manager, raw) ?? raw;
    const handle     = manager.get(resolvedId);

    // No handle in memory and no disk events — nothing to view.
    if (!handle) {
      // Attempt disk replay as a quick check — if nothing there, emit info.
      const diskIds = await SubagentLogReader.list(sessionLabel);
      const found   = diskIds.some(id => id === resolvedId || id.startsWith(raw));
      if (!found) {
        ctx.out.info(`No events found for subagent "${raw}".`);
        return 'continue';
      }
    }

    const entry: TaskViewEntry = {
      id: resolvedId,
      manager,
      sessionLabel,
      ctx,
      ictx: ictxRef,
    };

    await enterTaskViewMode(entry);
    return 'continue';
  },
};

// ---------------------------------------------------------------------------
// /tasks:cancel
// ---------------------------------------------------------------------------

export const tasksCancelCmd: SlashCommand = {
  name: '/tasks:cancel',
  summary: 'Cancel a running subagent',
  usage: '/tasks:cancel <id>',
  hint: 'When you want to abort a subagent that is still in progress.',
  async handler(ctx, args) {
    const manager = ensureManager(ctx);
    if (!manager) return 'continue';

    const raw = args.trim();
    if (!raw) {
      ctx.out.info('Usage: /tasks:cancel <id>');
      return 'continue';
    }

    const resolvedId = resolveId(manager, raw) ?? raw;
    const handle     = manager.get(resolvedId);

    if (!handle) {
      ctx.out.error(`No subagent found with ID "${raw}".`);
      return 'continue';
    }
    if (handle.status !== 'running' && handle.status !== 'idle') {
      ctx.out.info(`Subagent ${resolvedId} is already ${handle.status}; nothing to cancel.`);
      return 'continue';
    }

    await handle.cancel();
    ctx.out.line(palette.dim(`  → cancelled ${resolvedId}`));
    return 'continue';
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const tasksCommands: readonly SlashCommand[] = [
  tasksCmd,
  tasksViewCmd,
  tasksCancelCmd,
];
