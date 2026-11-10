/**
 * /recall — inspect scored episode candidates for the current git context.
 *
 * Shows all stored episodes with their relevance scores for the current
 * working directory / git branch, without injecting anything into context.
 * Useful for debugging what would be surfaced by AFK_EPISODE_RECALL=1.
 *
 * Usage:
 *   /recall          — list all candidates with scores (highest first)
 *   /recall --all    — include zero-score episodes (normally suppressed)
 */

import { basename } from 'node:path';
import { getMemoryDir } from '../../../paths.js';
import { divider } from '../../render/divider.js';
import { palette } from '../../palette.js';
import {
  scoredEpisodes,
  formatEpisodeForRecall,
  getCurrentBranch,
  getRecentlyModifiedFiles,
  EPISODE_RECALL_CAP,
} from '../../../agent/memory/memory-loader.js';
import type { SlashCommand } from '../types.js';

export const recallCmd: SlashCommand = {
  name: '/recall',
  usage: '/recall [--all]',
  summary: 'Inspect scored episode candidates for the current git context',
  hint: 'When AFK_EPISODE_RECALL=1 is set and you want to see what episodes would be injected, or to debug surprising recall behaviour.',
  async handler(ctx, args) {
    const showAll = args.split(/\s+/).includes('--all');
    const cwd = ctx.stats.cwd ?? process.cwd();
    const memoryDir = getMemoryDir();

    // Collect git context for display.
    const branch = getCurrentBranch(cwd);
    const modifiedFiles = getRecentlyModifiedFiles(cwd);

    ctx.out.line();
    ctx.out.line(palette.bold('Episode recall — scored candidates'));
    ctx.out.line(divider(undefined, 60));
    ctx.out.line(palette.dim(`  cwd:    ${cwd}`));
    ctx.out.line(palette.dim(`  branch: ${branch ?? '(none / detached HEAD)'}`));
    if (modifiedFiles.length > 0) {
      const display = modifiedFiles.slice(0, 5).map((f) => basename(f)).join(', ');
      const more = modifiedFiles.length > 5 ? ` +${modifiedFiles.length - 5} more` : '';
      ctx.out.line(palette.dim(`  files:  ${display}${more}`));
    } else {
      ctx.out.line(palette.dim('  files:  (none modified vs upstream)'));
    }
    ctx.out.line(divider(undefined, 60));

    let candidates: ReturnType<typeof scoredEpisodes>;
    try {
      candidates = scoredEpisodes(memoryDir, cwd);
    } catch (err) {
      ctx.out.error(`Failed to load episodes: ${err instanceof Error ? err.message : String(err)}`);
      return 'continue';
    }

    if (candidates.length === 0) {
      ctx.out.warn('No episodes found in the memory store.');
      ctx.out.line(palette.dim('  Run `afk episode synthesize` or enable AFK_EPISODE_SYNTHESIS=1 to populate episodes.'));
      ctx.out.line();
      return 'continue';
    }

    const visible = showAll ? candidates : candidates.filter(({ score }) => score > 0);
    const hiddenCount = candidates.length - visible.length;

    if (visible.length === 0) {
      ctx.out.warn('No episodes score > 0 for the current git context.');
      ctx.out.line(palette.dim(`  ${candidates.length} episode(s) exist but none match the current branch/files.`));
      ctx.out.line(palette.dim('  Run /recall --all to see all stored episodes regardless of score.'));
      ctx.out.line();
      return 'continue';
    }

    // Cap marker: first EPISODE_RECALL_CAP would be injected by AFK_EPISODE_RECALL=1.
    for (let i = 0; i < visible.length; i++) {
      const { ep, score } = visible[i]!;
      const wouldInject = score > 0 && i < EPISODE_RECALL_CAP;
      const scoreLabel = score > 0
        ? palette.warning(`score=${score}`)
        : palette.dim(`score=${score}`);
      const injectLabel = wouldInject
        ? palette.brand('  ✓ would inject')
        : score > 0
          ? palette.dim('  (above cap)')
          : palette.dim('  (score=0, skipped)');

      ctx.out.line(`  ${palette.bold(`[${i + 1}]`)} ${scoreLabel}${injectLabel}`);
      ctx.out.line(palette.dim(`      id=${ep.id}  created=${ep.created_at}`));

      // Show first few lines of the formatted episode.
      const formatted = formatEpisodeForRecall(ep);
      const lines = formatted.split('\n').filter((l) => l.trim().length > 0).slice(0, 4);
      for (const line of lines) {
        ctx.out.line(palette.dim(`      ${line}`));
      }
      if (i < visible.length - 1) ctx.out.line();
    }

    ctx.out.line(divider(undefined, 60));

    const injectCount = Math.min(visible.filter(({ score }) => score > 0).length, EPISODE_RECALL_CAP);
    if (injectCount > 0) {
      ctx.out.info(`${injectCount} episode(s) would be injected by AFK_EPISODE_RECALL=1`);
    } else {
      ctx.out.warn('0 episodes would be injected (no candidates score > 0)');
    }
    if (hiddenCount > 0) {
      ctx.out.line(palette.dim(`  ${hiddenCount} zero-score episode(s) hidden — run /recall --all to show them`));
    }
    ctx.out.line(palette.dim('  Set AFK_NO_EPISODE_RECALL=1 to suppress injection for this session.'));
    ctx.out.line(palette.dim('  Set AFK_EPISODE_RECALL=dry-run to log injection to stderr without modifying context.'));
    ctx.out.line();

    return 'continue';
  },
};
