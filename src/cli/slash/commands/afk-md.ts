/**
 * `/afk-md` — inspect and edit the AFK.md system-prompt overlay, with a live
 * hot-reload into the running session.
 *
 * Aliased to `/memory` for Claude Code muscle memory. That alias is deliberately
 * disambiguated in the overview output, because AFK also has a SEPARATE
 * cross-session memory system (HOT.md + the fact archive, written by the agent
 * through `memory_update`) — a user typing `/memory` could reasonably mean
 * either, so the overview names both and points at the right one.
 *
 * @module cli/slash/commands/afk-md
 */

import { loadAfkMd } from '../../config/afk-md-tier.js';
import { resolveBaseSystemPrompt } from '../../shared-helpers.js';
import { palette } from '../../palette.js';
import type { SlashCommand, SlashContext, SlashResult } from '../types.js';
import { resolveEditor } from './editor-spawn.js';
import { appendToTarget, editTarget } from './afk-md/edit.js';
import { applyReload, currentOverlayTokens, formatDelta } from './afk-md/reload.js';
import {
  OVERLAY_TOKEN_WARN_THRESHOLD,
  contributes,
  formatTokens,
  renderTargetRows,
  resolveTargets,
  targetFor,
  type AfkMdScope,
} from './afk-md/targets.js';

const USAGE = [
  '  /afk-md                 overview of both tiers and what the model receives',
  '  /afk-md user            edit your personal overlay in $EDITOR',
  '  /afk-md project         edit this project\u2019s overlay in $EDITOR',
  '  /afk-md show            print the composed overlay exactly as the model sees it',
  '  /afk-md add <text>      append a bullet to the project overlay (--user for personal)',
  '  /afk-md reload          re-read from disk into this live session',
];

function printUsage(ctx: SlashContext): void {
  ctx.out.line(palette.heading('/afk-md — AFK.md prompt overlay'));
  for (const line of USAGE) ctx.out.line(line);
}

/** Resolve a subcommand word to a tier, accepting the numeric row labels too. */
function scopeFromWord(word: string): AfkMdScope | null {
  if (word === 'user' || word === 'u' || word === '1' || word === 'personal') return 'user';
  if (word === 'project' || word === 'p' || word === '2') return 'project';
  return null;
}

function renderOverview(ctx: SlashContext): void {
  const targets = resolveTargets();
  const { source } = resolveBaseSystemPrompt();
  const loaded = loadAfkMd();
  const totalTokens = currentOverlayTokens();
  const totalBytes = loaded ? Buffer.byteLength(loaded.content, 'utf8') : 0;

  ctx.out.line(palette.heading('AFK.md prompt overlay'));
  ctx.out.line('');
  for (const line of renderTargetRows(targets)) ctx.out.line(line);
  ctx.out.line('');

  const active = targets.filter(contributes).length;
  if (active === 0) {
    ctx.out.line(palette.dim('  No overlay is active — the framework prompt is running bare.'));
  } else {
    ctx.out.line(
      `  composed: ${totalBytes} B  ${formatTokens(totalTokens)} tokens across ${active} tier${active === 1 ? '' : 's'}`,
    );
  }
  ctx.out.line(palette.dim(`  ${source}`));

  if (totalTokens > OVERLAY_TOKEN_WARN_THRESHOLD) {
    ctx.out.warn(
      `That overlay is ${formatTokens(totalTokens)} tokens — it is prepended to every request in every session. Consider trimming it.`,
    );
  }

  const editor = resolveEditor();
  ctx.out.line('');
  for (const line of USAGE) ctx.out.line(line);
  ctx.out.line('');
  ctx.out.line(
    editor
      ? palette.dim(`  editor: ${editor.cmd}`)
      : palette.dim('  editor: none — set $VISUAL or $EDITOR to enable in-REPL editing'),
  );
  ctx.out.line(
    palette.dim(
      '  hot memory (HOT.md) + the fact archive are managed by the agent via memory_update —',
    ),
  );
  ctx.out.line(palette.dim('  this command edits your AFK.md prompt overlay.'));
}

function renderShow(ctx: SlashContext): void {
  const { source } = resolveBaseSystemPrompt();
  const loaded = loadAfkMd();
  if (!loaded) {
    ctx.out.info('No AFK.md overlay is active — nothing to show.');
    ctx.out.line(palette.dim(`  ${source}`));
    return;
  }
  ctx.out.line(palette.heading('Composed overlay — exactly what the model receives'));
  ctx.out.line(palette.dim(`  ${source}`));
  ctx.out.line('');
  ctx.out.raw(loaded.content);
  ctx.out.line('');
}

export const afkMdCmd: SlashCommand = {
  name: '/afk-md',
  aliases: ['/memory', '/mem'],
  summary: 'Inspect + edit your AFK.md prompt overlay, hot-reloaded into this session',
  usage: '/afk-md [user|project|show|add <text>|reload]',
  hint: 'When you want to change the standing instructions the agent runs under \u2014 opens the tier in $EDITOR, diffs what changed, and applies it to the RUNNING session (no restart).',
  flags: ['--user'],
  async handler(ctx: SlashContext, args: string): Promise<SlashResult> {
    const trimmed = args.trim();

    if (trimmed.length === 0) {
      renderOverview(ctx);
      return 'continue';
    }

    const [word = '', ...rest] = trimmed.split(/\s+/);

    if (word === 'show') {
      renderShow(ctx);
      return 'continue';
    }

    if (word === 'reload') {
      const baseline = currentOverlayTokens();
      const { applied, tokens, delta, source } = applyReload(ctx, baseline);
      if (applied) {
        ctx.out.success(
          `Re-read from disk — overlay now ${formatTokens(tokens)} tokens (${formatDelta(delta)}). Takes effect on your next message.`,
        );
      } else {
        ctx.out.warn(
          'Re-read from disk, but this provider cannot swap the prompt of a running session — it applies on next launch.',
        );
      }
      ctx.out.line(palette.dim(`  ${source}`));
      return 'continue';
    }

    if (word === 'add') {
      // `--user` may appear anywhere in the remainder; strip it before treating
      // the rest as literal bullet text.
      const toUser = rest.includes('--user');
      const text = rest.filter((w) => w !== '--user').join(' ').trim();
      if (text.length === 0) {
        ctx.out.error('Nothing to add. Usage: /afk-md add <text> [--user]');
        return 'continue';
      }
      appendToTarget(ctx, targetFor(toUser ? 'user' : 'project'), text);
      return 'continue';
    }

    const scope = scopeFromWord(word);
    if (scope) {
      await editTarget(ctx, targetFor(scope));
      return 'continue';
    }

    ctx.out.error(`Unknown subcommand \`${word}\`.`);
    printUsage(ctx);
    return 'continue';
  },
};
