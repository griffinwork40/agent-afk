/**
 * /tasks — list and view subagent conversations from the REPL.
 *
 * Commands:
 *   /tasks               list all subagents (active + recently completed + disk)
 *   /tasks:view <id>     render a subagent's conversation (memory-first, then disk)
 *   /tasks:cancel <id>   cancel a still-running subagent
 *
 * Data sources (in resolution order for /tasks):
 *   1. SubagentManager.list()         — active (running) handles
 *   2. manager.completed.list()       — recently-completed handles (LRU cache)
 *   3. SubagentLogReader.list(label)  — disk-persisted logs not in memory
 *
 * Wiring: call `setTasksRegistry` once from bootstrapSession after the
 * SubagentManager is constructed. The manager reference is kept as a
 * module-scope var (same pattern as bgsub.ts).
 *
 * @module cli/slash/commands/tasks
 */

import { palette } from '../../palette.js';
import { formatDuration } from '../../format-utils.js';
import { truncateDisplayWidth } from '../../display.js';
import { formatOutputEvent } from '../../output-event-format.js';
import type { SlashCommand } from '../types.js';
import type { SubagentManager } from '../../../agent/subagent.js';
import type { SubagentStatus } from '../../../agent/subagent/result.js';
import { SubagentLogReader } from '../../../agent/subagent/log.js';

// ---------------------------------------------------------------------------
// Module-scope registry refs
// ---------------------------------------------------------------------------

let managerRef: SubagentManager | undefined;
let sessionLabelRef: string | undefined;

/**
 * Wire the SubagentManager and session label into this module.
 * Called once by bootstrapSession after the manager is constructed.
 */
export function setTasksRegistry(manager: SubagentManager, sessionLabel: string): void {
  managerRef = manager;
  sessionLabelRef = sessionLabel;
}

/** Reset refs — used by tests to isolate module-scope state between cases. */
export function resetTasksRegistry(): void {
  managerRef = undefined;
  sessionLabelRef = undefined;
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
  promptHead: string | undefined,
  durationMs: number | undefined,
  toolCount: number,
): string {
  const glyph = STATUS_GLYPHS[status];
  const shortId = id.slice(0, 12);
  const typeLabel = agentType ? palette.dim(`[${agentType}]`) : '';
  const prompt = promptHead
    ? truncateDisplayWidth(promptHead, 60)
    : palette.dim('(no prompt)');
  const dur = durationMs !== undefined ? palette.dim(`${formatDuration(durationMs)}`) : '';
  const tools = palette.dim(`${toolCount} calls`);
  const parts = [
    `  ${glyph}`,
    palette.bold(shortId),
    typeLabel,
    prompt,
    dur,
    tools,
  ].filter(Boolean);
  return parts.join('  ');
}

// ---------------------------------------------------------------------------
// /tasks
// ---------------------------------------------------------------------------

export const tasksCmd: SlashCommand = {
  name: '/tasks',
  summary: 'List all subagents (active + recently completed)',
  usage: '/tasks',
  hint: 'When you want to see what subagents this session has spawned, their status, and prompt heads.',
  async handler(ctx) {
    const manager = ensureManager(ctx);
    if (!manager) return 'continue';
    const sessionLabel = ensureSessionLabel(ctx);
    if (!sessionLabel) return 'continue';

    // Collect active handles.
    const activeRows = manager.list().map(({ id, status }) => {
      // Access @internal fields via casting through unknown.
      const handle = manager.get(id);
      const impl = handle as unknown as {
        _agentType?: string;
        _currentTrace?: { toolCalls: unknown[] };
        _lastDurationMs?: number;
      };
      return formatHandleLine(
        id,
        status,
        impl._agentType,
        undefined, // prompt head not retained on the handle
        undefined, // duration unknown for still-running
        impl._currentTrace?.toolCalls.length ?? 0,
      );
    });

    // Collect recently-completed entries.
    const completedIds = new Set(manager.list().map(h => h.id));
    const completedRows = manager.completed.list().map(entry => {
      if (completedIds.has(entry.handle.id)) return null; // skip duplicates
      const impl = entry.handle as unknown as {
        _agentType?: string;
        _currentTrace?: { toolCalls: unknown[] };
        _lastDurationMs?: number;
      };
      return formatHandleLine(
        entry.handle.id,
        entry.handle.status,
        impl._agentType,
        undefined,
        impl._lastDurationMs,
        impl._currentTrace?.toolCalls.length ?? 0,
      );
    }).filter((r): r is string => r !== null);

    // Collect disk-only entries (not in memory at all).
    const memoryIds = new Set([
      ...manager.list().map(h => h.id),
      ...manager.completed.list().map(e => e.handle.id),
    ]);
    const diskIds = (await SubagentLogReader.list(sessionLabel))
      .filter(id => !memoryIds.has(id));
    const diskRows = diskIds.map(id =>
      formatHandleLine(id, 'succeeded' as SubagentStatus, undefined, undefined, undefined, 0),
    );

    const allRows = [...activeRows, ...completedRows, ...diskRows];
    if (allRows.length === 0) {
      ctx.out.info('No subagents in this session yet.');
      return 'continue';
    }

    ctx.out.line(palette.dim(`  ${'STATUS'.padEnd(2)}  ${'ID'.padEnd(12)}  DETAILS`));
    for (const row of allRows) ctx.out.line(row);
    return 'continue';
  },
};

// ---------------------------------------------------------------------------
// /tasks:view
// ---------------------------------------------------------------------------

export const tasksViewCmd: SlashCommand = {
  name: '/tasks:view',
  summary: 'View a subagent\'s conversation',
  usage: '/tasks:view <id>',
  hint: 'When you want to replay what a subagent said and which tools it called.',
  async handler(ctx, args) {
    const manager = ensureManager(ctx);
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
    const handle = manager.get(resolvedId);

    // Memory-first: handle exists — render getHistory().
    if (handle) {
      const history = handle.session.getHistory();
      if (history.length === 0) {
        ctx.out.info(`Subagent ${resolvedId} has no history yet.`);
        return 'continue';
      }
      ctx.out.line(palette.dim(`─── Subagent ${resolvedId} (${history.length} messages) ───`));
      for (const msg of history) {
        const role = msg.role === 'user' ? palette.bold('user') : palette.bold('assistant');
        ctx.out.line('');
        ctx.out.line(`${role}:`);
        const content = msg.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as unknown[])
                .map(b =>
                  b !== null && typeof b === 'object' && 'text' in b
                    ? String((b as { text: unknown }).text)
                    : JSON.stringify(b),
                )
                .join('\n')
            : JSON.stringify(content);
        for (const line of text.split('\n')) ctx.out.line(`  ${line}`);
      }
      ctx.out.line('');
      return 'continue';
    }

    // Disk fallback: stream events from JSONL log.
    let eventCount = 0;
    ctx.out.line(palette.dim(`─── Subagent ${resolvedId} (disk replay) ───`));
    for await (const event of SubagentLogReader.readEvents(sessionLabel, resolvedId)) {
      const text = formatOutputEvent(event);
      if (text !== null) {
        ctx.out.line(text);
        eventCount++;
      }
    }
    if (eventCount === 0) {
      ctx.out.info(`No events found for subagent "${resolvedId}".`);
    }
    ctx.out.line('');
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
    const handle = manager.get(resolvedId);

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
