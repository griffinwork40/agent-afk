/**
 * /bgsub — manage background subagent jobs.
 *
 * These commands operate on jobs spawned by the `agent` tool with
 * `mode: "background"`. They are deliberately namespaced under `/bgsub`
 * to avoid collision with `/bg` (turn-detach — a separate, older facility
 * that backgrounds the *current main-session turn*).
 *
 * Usage:
 *   /bgsub                 list all background subagent jobs
 *   /bgsub:status <id>     show one job's status (alias: /bgsub <id>)
 *   /bgsub:join <id>       wait for a job and print its result
 *   /bgsub:cancel <id>     cancel a still-running job
 *
 * In the interactive REPL, settled background results are auto-delivered
 * into the model's context with the next user message (BgResultNotifier —
 * see src/cli/commands/interactive/bg-result-notifier.ts; opt out with
 * AFK_BG_AUTO_DELIVER=0). The `/bgsub:join` command remains the manual
 * replay path: it prints the result to the operator's terminal but does
 * not push it into the model's context.
 *
 * @module cli/slash/commands/bgsub
 */

import { palette } from '../../palette.js';
import { formatDuration } from '../../format-utils.js';
import type { SlashCommand } from '../types.js';
import type { BackgroundAgentRegistry, BackgroundJob } from '../../../agent/background-registry.js';
import type { BackgroundSummarizer } from '../../../agent/background-summarizer.js';
import { BgJobLogReader } from '../../../agent/bg-job-log.js';
import type { OutputEvent } from '../../../agent/types/session-types.js';

let registryRef: BackgroundAgentRegistry | undefined;
let summarizerRef: BackgroundSummarizer | undefined;

/**
 * Wire the registry into the slash command module. Called once by
 * `bootstrapSession` after the registry is constructed.
 */
export function setBgsubRegistry(registry: BackgroundAgentRegistry): void {
  registryRef = registry;
}

/**
 * Wire the optional summarizer. Called once by `bootstrapSession` when
 * bgSummaries is enabled; called with `undefined` when disabled.
 */
export function setBgsubSummarizer(summarizer: BackgroundSummarizer | undefined): void {
  summarizerRef = summarizer;
}

/**
 * Reset the registry and summarizer references. Tests use this to isolate
 * the module-scope bindings between cases. Not exposed to operators.
 */
export function resetBgsubRegistry(): void {
  registryRef = undefined;
  summarizerRef = undefined;
}

const STATUS_GLYPHS: Record<BackgroundJob['status'], string> = {
  running: '◐',
  completed: '✓',
  failed: '✗',
  cancelled: '⊘',
};

function ensureRegistry(ctx: Parameters<SlashCommand['handler']>[0]): BackgroundAgentRegistry | null {
  if (!registryRef) {
    ctx.out.error('Background subagent jobs are not available in this session.');
    return null;
  }
  return registryRef;
}

/** Regex matching ANSI escape sequences. */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Sanitize summary text for terminal rendering:
 * - Strip ANSI escape codes
 * - Truncate to terminal width (or a reasonable fallback)
 */
function sanitizeSummaryText(text: string, maxCols = 120): string {
  const stripped = text.replace(ANSI_RE, '').replace(/[\r\n]+/g, ' ').trim();
  return stripped.length > maxCols ? `${stripped.slice(0, maxCols)}…` : stripped;
}

function formatJobLine(job: BackgroundJob): string {
  const glyph = STATUS_GLYPHS[job.status];
  const elapsed = job.endedAt !== undefined
    ? formatDuration(job.endedAt - job.startedAt)
    : formatDuration(Date.now() - job.startedAt);
  const label = job.label.length > 60 ? `${job.label.slice(0, 60)}…` : job.label;
  const mainLine = `  ${glyph} ${palette.bold(job.jobId)}  ${label}  ${palette.dim(`(${job.status} · ${elapsed} · ${job.model})`)}`;

  if (!summarizerRef || job.status !== 'running') return mainLine;

  const summary = summarizerRef.getSummary(job.jobId);
  if (!summary) return mainLine;

  const cols = process.stdout.columns ?? 120;
  const safeText = sanitizeSummaryText(summary.text, Math.max(40, cols - 10));
  const ageS = Math.round((Date.now() - summary.refreshedAt) / 1000);
  const staleSuffix = summary.stale ? ' [stale]' : '';
  const secondLine = palette.dim(`  ↳ ${safeText}  (${ageS}s ago)${staleSuffix}`);

  return `${mainLine}\n${secondLine}`;
}

function printJobDetail(ctx: Parameters<SlashCommand['handler']>[0], job: BackgroundJob): void {
  const glyph = STATUS_GLYPHS[job.status];
  ctx.out.line(`  ${glyph} ${palette.bold(job.jobId)}  ${job.label}`);
  const elapsed = job.endedAt !== undefined
    ? formatDuration(job.endedAt - job.startedAt)
    : formatDuration(Date.now() - job.startedAt);
  ctx.out.line(`  Status:    ${job.status} · ${elapsed}`);
  ctx.out.line(`  Subagent:  ${job.subagentId}`);
  ctx.out.line(`  Model:     ${job.model}`);

  const result = job.result;
  if (result?.message?.content) {
    ctx.out.line('');
    const text = typeof result.message.content === 'string'
      ? result.message.content
      : JSON.stringify(result.message.content);
    const lines = text.split('\n').slice(0, 40);
    for (const line of lines) ctx.out.line(`  ${line}`);
    if (text.split('\n').length > 40) {
      ctx.out.line(palette.dim('  … (truncated; full result available via /bgsub:join again)'));
    }
  }
  if (result?.error) {
    ctx.out.error(`  Error: ${result.error.message}`);
  }
}

/**
 * `/bgsub` — list all background subagent jobs, or `/bgsub <id>` for detail.
 *
 * Aliased as `/bgsub:status <id>` for symmetry with `:join` and `:cancel`.
 */
export const bgsubCmd: SlashCommand = {
  name: '/bgsub',
  summary: 'List background subagent jobs',
  usage: '/bgsub [id]',
  hint: 'When you want to check on background subagent jobs spawned with mode="background" during this session.',
  async handler(ctx, args) {
    const registry = ensureRegistry(ctx);
    if (!registry) return 'continue';

    const id = args.trim();
    if (id) {
      const job = registry.get(id);
      if (!job) {
        ctx.out.error(`No background job with ID "${id}".`);
        return 'continue';
      }
      printJobDetail(ctx, job);
      return 'continue';
    }

    const jobs = registry.list();
    if (jobs.length === 0) {
      ctx.out.info(
        'No background subagent jobs. Spawn one by calling the agent tool with ' +
        'mode="background".',
      );
      return 'continue';
    }
    for (const job of jobs) ctx.out.line(formatJobLine(job));
    return 'continue';
  },
};

export const bgsubStatusCmd: SlashCommand = {
  name: '/bgsub:status',
  summary: 'Show one background job',
  usage: '/bgsub:status <id>',
  hint: 'When you need the full detail view for one specific background job by its ID.',
  async handler(ctx, args) {
    const registry = ensureRegistry(ctx);
    if (!registry) return 'continue';

    const id = args.trim();
    if (!id) {
      ctx.out.info('Usage: /bgsub:status <id>');
      return 'continue';
    }
    const job = registry.get(id);
    if (!job) {
      ctx.out.error(`No background job with ID "${id}".`);
      return 'continue';
    }
    printJobDetail(ctx, job);
    return 'continue';
  },
};

export const bgsubJoinCmd: SlashCommand = {
  name: '/bgsub:join',
  summary: 'Wait for a background subagent job and print its result',
  usage: '/bgsub:join <id>',
  hint: 'When a background subagent has finished and you want to surface its result into the conversation.',
  async handler(ctx, args) {
    const registry = ensureRegistry(ctx);
    if (!registry) return 'continue';

    const id = args.trim();
    if (!id) {
      ctx.out.info('Usage: /bgsub:join <id>');
      return 'continue';
    }

    // Fast path: job is still in memory.
    if (registry.get(id)) {
      // `join()` resolves with the final result and emits a `joined` witness
      // event internally — no extra emit call needed here.
      try {
        await registry.join(id);
      } catch (err) {
        // join() throws only on unknown jobId; the get() check above guards
        // that, but keep the catch so a future contract change does not crash
        // the REPL. Print the error and fall through to the snapshot path.
        const message = err instanceof Error ? err.message : String(err);
        ctx.out.error(`/bgsub:join failed: ${message}`);
      }

      const snapshot = registry.get(id);
      if (snapshot) printJobDetail(ctx, snapshot);
      return 'continue';
    }

    // Fallback: job has been evicted from memory — check the disk log.
    const diskMeta = await BgJobLogReader.readMeta(id);
    if (diskMeta) {
      ctx.out.info('Job evicted from memory — replaying from log.');
      let lineCount = 0;
      for await (const event of BgJobLogReader.readEvents(id)) {
        const text = formatDiskEvent(event);
        if (text !== null) {
          ctx.out.line(text);
          lineCount++;
        }
      }
      if (lineCount === 0) {
        ctx.out.info(`  (no events recorded for job ${id})`);
      }
      ctx.out.line('');
      ctx.out.line(
        `  Status: ${diskMeta.status}` +
          (diskMeta.endedAt !== undefined
            ? `  ·  ended ${new Date(diskMeta.endedAt).toISOString()}`
            : ''),
      );
      return 'continue';
    }

    // Job not found anywhere.
    ctx.out.error(`No background job with ID "${id}".`);
    return 'continue';
  },
};

/**
 * Format a disk-replayed OutputEvent for terminal display.
 * Returns null for event types that have no meaningful text representation.
 *
 * ANSI codes are stripped from user-generated content (chunk/message) so
 * replayed output doesn't corrupt the terminal with double-rendered escapes.
 * Newlines are preserved — this is a replay, not a single-line badge.
 */
function formatDiskEvent(event: OutputEvent): string | null {
  if (event.type === 'chunk') {
    const chunk = event.chunk;
    if (chunk.type === 'content') return chunk.content.replace(ANSI_RE, '');
    if (chunk.type === 'tool_use_detail') {
      return palette.dim(`  [tool: ${chunk.toolName}]`);
    }
    return null;
  }
  if (event.type === 'error') return palette.dim(`  [error: ${event.error.message}]`);
  if (event.type === 'message') {
    const c = event.message.content;
    const text = typeof c === 'string' ? c : JSON.stringify(c);
    return text.replace(ANSI_RE, '');
  }
  return null;
}

export const bgsubCancelCmd: SlashCommand = {
  name: '/bgsub:cancel',
  summary: 'Cancel a running background subagent job',
  usage: '/bgsub:cancel <id>',
  hint: 'When you want to abort a background subagent job that is still in progress.',
  async handler(ctx, args) {
    const registry = ensureRegistry(ctx);
    if (!registry) return 'continue';

    const id = args.trim();
    if (!id) {
      ctx.out.info('Usage: /bgsub:cancel <id>');
      return 'continue';
    }
    const job = registry.get(id);
    if (!job) {
      ctx.out.error(`No background job with ID "${id}".`);
      return 'continue';
    }
    if (job.status !== 'running') {
      ctx.out.info(`Job ${id} is already ${job.status}; nothing to cancel.`);
      return 'continue';
    }
    const issued = await registry.cancelJob(id);
    if (issued) {
      ctx.out.line(palette.dim(`  → cancellation requested for ${id}`));
    } else {
      ctx.out.info(`Job ${id} could not be cancelled (already terminal).`);
    }
    return 'continue';
  },
};

export const bgsubCommands: readonly SlashCommand[] = [
  bgsubCmd,
  bgsubStatusCmd,
  bgsubJoinCmd,
  bgsubCancelCmd,
];
