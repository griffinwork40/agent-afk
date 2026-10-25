/**
 * /handoffs — list and answer pending daemon handoff questions from the REPL.
 *
 * Subcommands:
 *   /handoffs                  — list all pending handoff questions
 *   /handoffs:answer <id>      — interactively answer a pending handoff
 *   /handoffs:answer <id> <v>  — answer directly with a value (text/confirm)
 *
 * Reuses the durable handoff store API (`listPendingHandoffs`, `answerHandoff`)
 * shared with the Telegram surface. No parallel store; source of truth is the
 * same file-based `getHandoffsDir()` directory.
 *
 * Answer recording writes `answerSource: 'repl'` and `responderIdentity: 'repl'`
 * to the HandoffRecord (matching the documented format in handoff-store.ts).
 *
 * @module cli/slash/commands/handoffs
 */

import { palette } from '../../palette.js';
import { listPendingHandoffs } from '../../../agent/daemon/handoff-store.js';
import { answerHandoff } from '../../../agent/daemon/handoff-wiring.js';
import type { SlashCommand } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a createdAt ISO string as a human-readable age ("3m ago", "2h ago"). */
function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Truncate a string to at most n chars, appending "…" if cut. */
function truncate(text: string, n: number): string {
  const flat = text.replace(/\r?\n/g, ' ');
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
}

/** Extract a human-readable question string from the opaque question record. */
function questionText(question: Record<string, unknown>): string {
  if (typeof question['message'] === 'string') return question['message'];
  return '(question details unavailable)';
}

/** Short task ID (first 16 chars) for display. */
function shortId(taskId: string): string {
  return taskId.length > 16 ? taskId.slice(0, 16) + '…' : taskId;
}

// ---------------------------------------------------------------------------
// /handoffs — list
// ---------------------------------------------------------------------------

export const handoffsCmd: SlashCommand = {
  name: '/handoffs',
  summary: 'List pending daemon handoff questions',
  usage: '/handoffs',
  hint: 'When a daemon task asked a question and is waiting for your answer — use /handoffs:answer <id> to respond.',
  async handler(ctx) {
    let pending;
    try {
      pending = await listPendingHandoffs();
    } catch (err) {
      ctx.out.error(`Failed to read handoff store: ${err instanceof Error ? err.message : String(err)}`);
      return 'continue';
    }

    if (pending.length === 0) {
      ctx.out.info('No pending daemon handoffs.');
      return 'continue';
    }

    ctx.out.line('');
    ctx.out.line(palette.heading(`  ${pending.length} pending handoff${pending.length !== 1 ? 's' : ''}:`));
    ctx.out.line('');
    ctx.out.line(palette.dim(`  ${'ID'.padEnd(18)}  ${'TYPE'.padEnd(12)}  ${'AGE'.padEnd(8)}  QUESTION`));
    ctx.out.line(palette.dim(`  ${'─'.repeat(18)}  ${'─'.repeat(12)}  ${'─'.repeat(8)}  ${'─'.repeat(40)}`));

    for (const record of pending) {
      const qType = typeof record.question['type'] === 'string'
        ? record.question['type'] as string
        : 'text';
      const id = shortId(record.taskId);
      const age = fmtAge(record.createdAt);
      const q = truncate(questionText(record.question), 55);

      ctx.out.line(
        `  ${palette.info(id.padEnd(18))}  ${palette.meta(qType.padEnd(12))}  ${palette.dim(age.padEnd(8))}  ${q}`,
      );
    }

    ctx.out.line('');
    ctx.out.line(palette.dim(`  Use /handoffs:answer <task-id> to respond.`));
    ctx.out.line('');
    return 'continue';
  },
};

// ---------------------------------------------------------------------------
// /handoffs:answer — answer a pending handoff
// ---------------------------------------------------------------------------

export const handoffsAnswerCmd: SlashCommand = {
  name: '/handoffs:answer',
  summary: 'Answer a pending daemon handoff question',
  usage: '/handoffs:answer <task-id> [answer]',
  hint: 'Provide your answer to a daemon task that is waiting on human input. Omit the answer to be prompted interactively.',
  async handler(ctx, args) {
    const parts = args.trim().split(/\s+/);
    const rawId = parts[0] ?? '';

    if (!rawId) {
      ctx.out.warn('Usage: /handoffs:answer <task-id> [answer]');
      return 'continue';
    }

    // Load pending records to resolve a prefix match.
    let pending;
    try {
      pending = await listPendingHandoffs();
    } catch (err) {
      ctx.out.error(`Failed to read handoff store: ${err instanceof Error ? err.message : String(err)}`);
      return 'continue';
    }

    // Exact match first, then prefix — error on ambiguous prefix.
    const exactMatch = pending.find(r => r.taskId === rawId);
    const prefixMatches = exactMatch ? [] : pending.filter(r => r.taskId.startsWith(rawId));
    if (!exactMatch && prefixMatches.length > 1) {
      ctx.out.error(
        `Ambiguous id prefix "${rawId}" matches ${prefixMatches.length} handoffs. Provide a longer prefix or the full id.`,
      );
      return 'continue';
    }
    const match = exactMatch ?? prefixMatches[0];

    if (!match) {
      ctx.out.error(
        pending.length === 0
          ? 'No pending handoffs found.'
          : `No pending handoff matches "${rawId}". Run /handoffs to list them.`,
      );
      return 'continue';
    }

    const record = match;
    const qType = typeof record.question['type'] === 'string'
      ? record.question['type'] as string
      : 'text';
    const message = questionText(record.question);
    const choices = Array.isArray(record.question['choices'])
      ? record.question['choices'] as string[]
      : [];

    // Display the question.
    ctx.out.line('');
    ctx.out.line(palette.heading(`  Handoff question`));
    ctx.out.line(palette.dim(`  Task: ${record.taskId}`));
    ctx.out.line(palette.dim(`  Type: ${qType}  ·  Asked: ${fmtAge(record.createdAt)}`));
    ctx.out.line('');
    ctx.out.line(`  ${message}`);
    if (choices.length > 0) {
      ctx.out.line('');
      choices.forEach((c, i) => {
        ctx.out.line(`    ${palette.dim(`${i + 1}.`)} ${c}`);
      });
    }
    ctx.out.line('');

    // Resolve the answer value.
    const inlineAnswer = parts.slice(1).join(' ').trim();
    let answer: unknown;

    if (inlineAnswer) {
      answer = resolveAnswer(qType, inlineAnswer, choices, record.question, ctx);
      if (answer === null) return 'continue'; // resolveAnswer already emitted error
    } else {
      // No inline answer supplied — instruct the operator to re-invoke with a value.
      // Interactive stdin prompting from a slash handler is not safe (we share
      // stdin with the compositor/readline loop), so we surface a clear hint.
      const hint = qType === 'confirm'
        ? 'yes or no'
        : qType === 'number'
        ? 'a number'
        : choices.length > 0
        ? `a choice number (1–${choices.length}) or value`
        : 'your answer text';
      ctx.out.warn(
        `Provide your answer inline: /handoffs:answer ${shortId(record.taskId)} <${hint}>`,
      );
      return 'continue';
    }

    // Record the answer.
    let won: boolean;
    try {
      won = await answerHandoff(record.taskId, answer, 'repl', undefined, 'repl');
    } catch (err) {
      ctx.out.error(`Failed to record answer: ${err instanceof Error ? err.message : String(err)}`);
      return 'continue';
    }

    if (won) {
      ctx.out.success(`Answer recorded for task ${shortId(record.taskId)}.`);
      ctx.out.line(palette.dim(`  The daemon task will resume with your response.`));
    } else {
      ctx.out.warn(`Handoff for task ${shortId(record.taskId)} was already answered from another surface.`);
    }
    ctx.out.line('');
    return 'continue';
  },
};

// ---------------------------------------------------------------------------
// Answer resolution helper
// ---------------------------------------------------------------------------

/**
 * Convert a raw inline string to the answer shape expected by handoff consumers.
 * Returns null and emits an error via `ctx.out` when the input is invalid.
 */
function resolveAnswer(
  qType: string,
  raw: string,
  choices: string[],
  question: Record<string, unknown>,
  ctx: Parameters<SlashCommand['handler']>[0],
): unknown | null {
  const trimmed = raw.trim();

  if (qType === 'confirm') {
    const lower = trimmed.toLowerCase();
    if (lower === 'yes' || lower === 'y' || lower === 'true' || lower === '1') {
      return { value: true };
    }
    if (lower === 'no' || lower === 'n' || lower === 'false' || lower === '0') {
      return { value: false };
    }
    ctx.out.error(`For a confirm question, answer must be yes/no (got "${trimmed}").`);
    return null;
  }

  if (qType === 'number') {
    const n = Number(trimmed);
    if (!isFinite(n)) {
      ctx.out.error(`Expected a number but got "${trimmed}".`);
      return null;
    }
    const min = question['min'] as number | undefined;
    const max = question['max'] as number | undefined;
    if (min !== undefined && n < min) {
      ctx.out.error(`Answer must be >= ${min} (got ${n}).`);
      return null;
    }
    if (max !== undefined && n > max) {
      ctx.out.error(`Answer must be <= ${max} (got ${n}).`);
      return null;
    }
    return { value: n };
  }

  if (qType === 'choice' && choices.length > 0) {
    const allowCustom = Boolean(question['allowCustom']);
    // Accept choice by index (1-based) — validate strictly so "2oops" isn't treated as 2.
    const idx = parseInt(trimmed, 10);
    if (Number.isInteger(idx) && String(idx) === trimmed && idx >= 1 && idx <= choices.length) {
      return { value: choices[idx - 1] };
    }
    const matched = choices.find(c => c.toLowerCase() === trimmed.toLowerCase());
    if (matched) return { value: matched };
    // allowCustom: store as a free-form custom value (mirrors Telegram surface).
    if (allowCustom) return { value: null, custom_value: trimmed };
    ctx.out.error(
      `"${trimmed}" does not match any choice. Options:\n${choices.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`,
    );
    return null;
  }

  // text / multi_choice / fallback
  return { value: trimmed };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const handoffsCommands: readonly SlashCommand[] = [
  handoffsCmd,
  handoffsAnswerCmd,
];
