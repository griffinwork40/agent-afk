/**
 * Edit + append flows for `/afk-md`: create-if-absent with a seeded scaffold,
 * hand the terminal to $EDITOR, then diff and hot-reload.
 *
 * @module cli/slash/commands/afk-md/edit
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { computeLineDiff, type DiffPayload } from '../../../../utils/diff.js';
import { palette } from '../../../palette.js';
import { spawnEditorOnPath } from '../editor-spawn.js';
import type { SlashContext } from '../../types.js';
import { applyReload, currentOverlayTokens, formatDelta } from './reload.js';
import { formatTokens, type AfkMdTarget } from './targets.js';

/** Max diff lines rendered before eliding — an AFK.md can be hundreds of lines. */
const MAX_DIFF_LINES = 40;

/**
 * Seed text for a tier the operator has never created.
 *
 * Claude Code opens an empty buffer here; a scaffold that names the tier and its
 * precedence is strictly more useful, and the comment survives as documentation
 * because markdown comments are invisible to the rendered doc but ARE part of the
 * prompt text — so it stays short.
 */
function scaffold(target: AfkMdTarget): string {
  const scopeNote =
    target.scope === 'user'
      ? 'Applies to every project on this machine. Loaded first.'
      : 'Applies to this project only. Loaded last, so it wins on conflict.';
  return [
    `# ${target.scope === 'user' ? 'Personal' : 'Project'} AFK configuration`,
    '',
    `<!-- ${scopeNote}`,
    '     This file is appended to the system prompt under "# Operator configuration".',
    '     Edit it with /afk-md; changes hot-reload into the running session. -->',
    '',
    '',
  ].join('\n');
}

/** Create the file (and the user-scope parent dir) when absent. Returns true if created. */
function ensureExists(target: AfkMdTarget): boolean {
  if (existsSync(target.path)) return false;
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, scaffold(target), 'utf-8');
  return true;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/** Render a unified diff in the house style, capped and elided. */
function renderDiff(ctx: SlashContext, diff: DiffPayload): void {
  ctx.out.line(
    `  ${palette.success(`+${diff.addedLines}`)} ${palette.error(`-${diff.removedLines}`)}`,
  );
  let printed = 0;
  for (const hunk of diff.hunks) {
    if (printed >= MAX_DIFF_LINES) break;
    ctx.out.line(palette.dim(`  @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`));
    for (const line of hunk.lines) {
      if (printed >= MAX_DIFF_LINES) break;
      const text = `  ${line.kind}${line.text}`;
      if (line.kind === '+') ctx.out.line(palette.success(text));
      else if (line.kind === '-') ctx.out.line(palette.error(text));
      else ctx.out.line(palette.dim(text));
      printed++;
    }
  }
  const total = diff.hunks.reduce((n, h) => n + h.lines.length, 0);
  if (total > printed) {
    ctx.out.line(palette.dim(`  … ${total - printed} more diff lines (see the file for the rest)`));
  }
}

/**
 * Report the result of a reload. Kept here so `edit` and `add` phrase the
 * outcome identically.
 *
 * Contract (no optimistic rendering): this is called only AFTER `applyReload`
 * has returned, and it branches on the real `applied` flag — a provider without
 * live-swap support is told the truth rather than shown a success line.
 */
function reportReload(ctx: SlashContext, baseline: number): void {
  const { applied, tokens, delta, source, shadowed } = applyReload(ctx, baseline);
  if (shadowed) {
    ctx.out.warn(
      'Saved to disk, but AFK.md is shadowed by a higher-priority system prompt override and is not part of what the model receives.',
    );
  } else if (applied) {
    ctx.out.success(
      `Reloaded into this session — overlay now ${formatTokens(tokens)} tokens (${formatDelta(delta)}). Takes effect on your next message.`,
    );
  } else {
    ctx.out.warn(
      'Saved to disk, but this provider cannot swap the prompt of a running session — it applies on next launch.',
    );
  }
  ctx.out.line(palette.dim(`  ${source}`));
}

/**
 * Open a tier in $EDITOR, then diff + hot-reload on a clean exit.
 *
 * Ordering constraint: the pre-edit snapshot must be taken BEFORE the spawn (the
 * editor writes in place, so there is no other chance to capture it), and the
 * cache bust must happen AFTER the editor exits — see the Invariant in reload.ts.
 */
export async function editTarget(ctx: SlashContext, target: AfkMdTarget): Promise<void> {
  const created = ensureExists(target);
  if (created) ctx.out.info(`Created ${target.path}`);

  const before = readOrEmpty(target.path);
  const baseline = currentOverlayTokens(ctx.stats.cwd);

  const { outcome, exitCode } = await spawnEditorOnPath({
    compositor: ctx.getCompositor?.() ?? null,
    filePath: target.path,
    notify: (kind, message) => {
      if (kind === 'error') ctx.out.error(message);
      else if (kind === 'warn') ctx.out.warn(message);
      else ctx.out.info(message);
    },
  });

  if (outcome === 'no-tty' || outcome === 'no-editor') {
    ctx.out.line(palette.dim(`  Edit it directly: ${target.path}`));
    return;
  }
  if (outcome === 'spawn-failed') {
    ctx.out.warn('Could not launch your editor — the file is unchanged.');
    return;
  }
  if (outcome === 'nonzero') {
    ctx.out.warn(`Editor exited with status ${exitCode} — treating that as "discard", nothing reloaded.`);
    return;
  }

  const after = readOrEmpty(target.path);
  const diff = computeLineDiff(before, after);
  if (!diff) {
    ctx.out.info('No changes.');
    return;
  }

  renderDiff(ctx, diff);
  if (after.trim().length === 0) {
    ctx.out.warn('This file is now empty — the tier is treated as ABSENT and contributes nothing.');
  }
  reportReload(ctx, baseline);
}

/** Append a bullet to a tier without opening an editor, then hot-reload. */
export function appendToTarget(ctx: SlashContext, target: AfkMdTarget, text: string): void {
  const created = ensureExists(target);
  const baseline = currentOverlayTokens(ctx.stats.cwd);

  const existing = readOrEmpty(target.path);
  // Guarantee the bullet starts on its own line without stacking blank lines on
  // repeated appends.
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(target.path, `${existing}${separator}- ${text}\n`, 'utf-8');

  if (created) ctx.out.info(`Created ${target.path}`);
  ctx.out.success(`Appended to ${target.path}`);
  ctx.out.line(`  ${palette.success('+')} - ${text}`);
  reportReload(ctx, baseline);
}
