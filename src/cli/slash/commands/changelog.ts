/**
 * /changelog — generate CHANGELOG.md entries from commits since the last tag.
 *
 * Parses conventional-commit prefixes (feat:, fix:, refactor:, docs:, etc.),
 * groups them into Keep a Changelog categories, and appends to the
 * [Unreleased] section. Existing [Unreleased] content is preserved.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type CommitEntry,
  formatEntries,
  getExistingUnreleased,
  parseCommits,
  updateChangelog,
} from '../../../changelog.js';
import { palette } from '../../palette.js';
import type { SlashCommand } from '../types.js';

export const changelogCmd: SlashCommand = {
  name: '/changelog',
  usage: '/changelog [--dry-run]',
  summary: 'Generate CHANGELOG entries from commits since last tag',
  hint: 'When you are preparing a release and want to auto-generate changelog entries from conventional commits.',
  async handler(ctx, args) {
    const dryRun = args.split(/\s+/).includes('--dry-run');
    const repoRoot = process.cwd();

    let commits: CommitEntry[];
    try {
      commits = parseCommits(repoRoot);
    } catch (err) {
      ctx.out.error(`Failed to read git log: ${err instanceof Error ? err.message : String(err)}`);
      return 'continue';
    }

    if (commits.length === 0) {
      ctx.out.warn('No commits found since the last tag.');
      return 'continue';
    }

    const formatted = formatEntries(commits);
    const existing = (() => {
      try {
        const cl = readFileSync(resolve(repoRoot, 'CHANGELOG.md'), 'utf8');
        return getExistingUnreleased(cl);
      } catch {
        return '';
      }
    })();

    ctx.out.line();
    ctx.out.info(`${commits.length} commits since last tag`);
    ctx.out.line();

    if (existing) {
      ctx.out.warn('Existing [Unreleased] entries will be preserved above new entries.');
      ctx.out.line();
    }

    ctx.out.line(palette.heading('Preview:'));
    ctx.out.line(palette.dim('─'.repeat(60)));
    for (const line of formatted.split('\n')) {
      if (line.startsWith('### ')) {
        ctx.out.line(palette.bold(line));
      } else if (line.startsWith('- ')) {
        ctx.out.line(palette.dim('  ') + line);
      } else {
        ctx.out.line(line);
      }
    }
    ctx.out.line(palette.dim('─'.repeat(60)));

    if (dryRun) {
      ctx.out.info('Dry run — CHANGELOG.md not modified.');
      return 'continue';
    }

    try {
      if (!existsSync(resolve(repoRoot, 'CHANGELOG.md'))) {
        ctx.out.error('CHANGELOG.md not found. Create one with a ## [Unreleased] section first.');
        return 'continue';
      }
      updateChangelog(repoRoot, formatted);
      ctx.out.success('Wrote entries to CHANGELOG.md [Unreleased] section.');
      ctx.out.line(palette.dim('  Review with: git diff CHANGELOG.md'));
    } catch (err) {
      ctx.out.error(`Failed to update CHANGELOG.md: ${err instanceof Error ? err.message : String(err)}`);
    }

    return 'continue';
  },
};
