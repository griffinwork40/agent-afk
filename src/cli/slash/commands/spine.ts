/**
 * /spine — agent-maintained SPINE.md management.
 *
 * Usage:
 *   /spine init           Bootstrap SPINE.md from existing codebase artifacts
 *   /spine show           Display the current SPINE.md contents
 *   /spine pending        Show items queued from unattended daemon sessions
 *   /spine dismiss <N>    Remove a single pending item by index
 *   /spine dismiss-all    Clear all pending items
 *
 * SPINE.md is a git-tracked file at the repo root that captures the project's
 * architecture spine: hard invariants, explicitly rejected patterns, and taste
 * calls. It is maintained automatically by the SessionEnd hook and can be
 * bootstrapped via this command.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { palette } from '../../palette.js';
import { readSpine, serializeSpine, findEntry } from '../../../agent/spine/index.js';
import type { SpineDocument } from '../../../agent/spine/index.js';
import { getAfkStateDir } from '../../../paths.js';
import type { SlashCommand } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveRepoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function makeEmptyDoc(): SpineDocument {
  return {
    sections: [
      { name: 'Invariants', prefix: 'INV', entries: [] },
      { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
      { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
    ],
    trailer: '',
  };
}

async function collectGrepMatches(repoRoot: string, limit: number): Promise<string[]> {
  const grep = spawn(
    'grep',
    [
      '-rE',
      '--include=*.ts', '--include=*.js', '--include=*.mjs', '--include=*.md',
      '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=.afk-worktrees',
      '-h',
      'Invariant:|Contract:|History:',
      repoRoot,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const spawnError = new Promise<never>((_resolve, reject) => {
    grep.once('error', reject);
  });
  const readMatches = async (): Promise<string[]> => {
    const lines = createInterface({ input: grep.stdout });
    const matches: string[] = [];
    try {
      for await (const line of lines) {
        const match = line.trim();
        if (!match) continue;
        matches.push(match);
        if (matches.length === limit) {
          grep.kill();
          break;
        }
      }
    } finally {
      lines.close();
    }
    return matches;
  };

  return Promise.race([readMatches(), spawnError]);
}

// ---------------------------------------------------------------------------
// /spine show
// ---------------------------------------------------------------------------

function handleShow(ctx: Parameters<SlashCommand['handler']>[0]): 'continue' {
  const repoRoot = resolveRepoRoot();
  const doc = readSpine(repoRoot);
  if (!doc) {
    ctx.out.warn('No SPINE.md found. Run  /spine init  to bootstrap one.');
    return 'continue';
  }

  for (const section of doc.sections) {
    ctx.out.line(palette.heading(`## ${section.name}`));
    if (section.entries.length === 0) {
      ctx.out.line(palette.meta('  (none)'));
    } else {
      for (const entry of section.entries) {
        ctx.out.line(
          `  ${palette.bold(entry.id)}  ${entry.description}  ${palette.meta(`(${entry.date}, ${entry.sessionId})`)}`,
        );
      }
    }
    ctx.out.line('');
  }
  return 'continue';
}

// ---------------------------------------------------------------------------
// /spine pending
// ---------------------------------------------------------------------------

/** Shared helper: read and parse pending JSONL lines. Returns [] on missing/empty file. */
function readPendingLines(pendingPath: string): string[] {
  if (!existsSync(pendingPath)) return [];
  const raw = readFileSync(pendingPath, 'utf-8').trim();
  return raw ? raw.split('\n') : [];
}

function handlePending(ctx: Parameters<SlashCommand['handler']>[0]): 'continue' {
  const pendingPath = join(getAfkStateDir(), 'spine-pending.jsonl');
  const lines = readPendingLines(pendingPath);
  if (lines.length === 0) {
    ctx.out.info('No pending SPINE items.');
    return 'continue';
  }

  // Load SPINE.md so we can show the current entry for contradicts items
  const doc = readSpine(resolveRepoRoot());

  ctx.out.line(palette.heading(`## Pending SPINE items (${lines.length})`));
  ctx.out.line('');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    try {
      const entry = JSON.parse(line) as {
        type: string;
        sessionId: string;
        ts: string;
        item: Record<string, unknown>;
      };
      const label = palette.warning(`[${entry.type}]`);
      const id = typeof entry.item['existingId'] === 'string' ? entry.item['existingId'] : '';
      const desc = typeof entry.item['description'] === 'string' ? entry.item['description'] : '';
      ctx.out.line(`  ${palette.bold(String(i + 1))}. ${label}  ${id ? `${palette.bold(id)}  ` : ''}${desc}`);
      // For contradicts items, show the current SPINE.md entry inline
      if (entry.type === 'contradicts' && id && doc) {
        const existing = findEntry(doc, id);
        if (existing) {
          ctx.out.line(palette.meta(`     current: ${existing.description}`));
        }
      }
      ctx.out.line(palette.meta(`     session ${entry.sessionId}  ${entry.ts}`));
    } catch {
      ctx.out.line(palette.meta(`  ${i + 1}. [unparseable] ${line.slice(0, 80)}`));
    }
  }

  ctx.out.line('');
  ctx.out.line(palette.meta(
    'To resolve: /spine dismiss <N> to remove an item, /spine dismiss-all to clear.',
  ));
  ctx.out.line(palette.meta(
    'To accept a contradiction: edit SPINE.md directly, then dismiss the item.',
  ));
  return 'continue';
}

// ---------------------------------------------------------------------------
// /spine init
// ---------------------------------------------------------------------------

async function handleInit(
  ctx: Parameters<SlashCommand['handler']>[0],
  args: string,
): Promise<'continue'> {
  const repoRoot = resolveRepoRoot();
  const spinePath = join(repoRoot, 'SPINE.md');

  if (existsSync(spinePath) && !args.includes('--force')) {
    ctx.out.warn(
      `SPINE.md already exists at ${spinePath}.\n  Use  /spine init --force  to regenerate.`,
    );
    return 'continue';
  }

  ctx.out.info('Bootstrapping SPINE.md from codebase artifacts…');

  // Gather seed material
  const seeds: string[] = [];

  // 1. Scan for Invariant:/Contract:/History: comments
  try {
    const matches = await collectGrepMatches(repoRoot, 20);
    if (matches.length > 0) {
      seeds.push('### Discovered invariant/contract comments:', ...matches, '');
    }
  } catch {
    // No grep hits or grep not available — continue
  }

  // 2. CHANGELOG if present
  const changelogPath = join(repoRoot, 'CHANGELOG.md');
  if (existsSync(changelogPath)) {
    try {
      const cl = readFileSync(changelogPath, 'utf-8').slice(0, 2000);
      seeds.push('### CHANGELOG excerpt:', cl, '');
    } catch {
      // ignore
    }
  }

  // 3. ADR directory if present
  const adrDirs = ['docs/adr', 'adr', 'docs/decisions'];
  for (const dir of adrDirs) {
    const adrPath = join(repoRoot, dir);
    if (existsSync(adrPath)) {
      seeds.push(`### ADR directory found: ${dir}`);
      break;
    }
  }

  // Surface the draft to the model for approval
  const seedText =
    seeds.length > 0
      ? seeds.join('\n')
      : '(No seed material found — generating an empty skeleton)';

  ctx.out.line('');
  ctx.out.line(palette.heading('## SPINE.md Bootstrap'));
  ctx.out.line('');
  ctx.out.line('Seed material gathered:');
  ctx.out.line(palette.meta(seedText.slice(0, 800)));
  ctx.out.line('');
  ctx.out.warn(
    'SPINE.md init is a guided process — the model should now review the seed material\n' +
      'and draft entries. Writing a skeleton now for you to populate.',
  );

  // Write the skeleton
  const doc = makeEmptyDoc();
  const content = serializeSpine(doc);
  writeFileSync(spinePath, content, 'utf-8');

  ctx.out.success(`Wrote SPINE.md skeleton to ${spinePath}`);
  ctx.out.line(palette.meta(
    'Tip: run /spine show to view it, then manually add entries or wait for the\n' +
    '     SessionEnd hook to auto-populate it after your next coding session.',
  ));

  return 'continue';
}

// ---------------------------------------------------------------------------
// /spine dismiss N | dismiss-all
// ---------------------------------------------------------------------------

function handleDismiss(
  ctx: Parameters<SlashCommand['handler']>[0],
  args: string,
): 'continue' {
  const pendingPath = join(getAfkStateDir(), 'spine-pending.jsonl');
  const lines = readPendingLines(pendingPath);
  if (lines.length === 0) {
    ctx.out.info('No pending SPINE items to dismiss.');
    return 'continue';
  }

  const index = parseInt(args, 10);
  if (isNaN(index) || index < 1 || index > lines.length) {
    ctx.out.warn(`Invalid index: ${args}. Use 1–${lines.length} (see /spine pending).`);
    return 'continue';
  }

  lines.splice(index - 1, 1);
  writeFileSync(pendingPath, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf-8');
  ctx.out.success(`Dismissed item ${index}. ${lines.length} item(s) remaining.`);
  return 'continue';
}

function handleDismissAll(ctx: Parameters<SlashCommand['handler']>[0]): 'continue' {
  const pendingPath = join(getAfkStateDir(), 'spine-pending.jsonl');
  const lines = readPendingLines(pendingPath);
  if (lines.length === 0) {
    ctx.out.info('No pending SPINE items to dismiss.');
    return 'continue';
  }

  writeFileSync(pendingPath, '', 'utf-8');
  ctx.out.success(`Dismissed all ${lines.length} pending item(s).`);
  return 'continue';
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export const spineCmd: SlashCommand = {
  name: '/spine',
  usage: '/spine [init|show|pending|dismiss <N>|dismiss-all]',
  summary: 'Agent-maintained SPINE.md — project architecture spine',
  hint:
    'Use /spine show to view the current architecture spine, /spine init to bootstrap it, ' +
    '/spine pending to review queued items, /spine dismiss <N> to remove one, or /spine dismiss-all to clear.',
  async handler(ctx, args) {
    const trimmed = args.trim();
    const spaceIdx = trimmed.indexOf(' ');
    const verb = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    switch (verb) {
      case '':
      case 'show':
        return handleShow(ctx);

      case 'pending':
        return handlePending(ctx);

      case 'init':
        return handleInit(ctx, rest);

      case 'dismiss':
        return handleDismiss(ctx, rest);

      case 'dismiss-all':
        return handleDismissAll(ctx);

      default:
        ctx.out.warn(`Unknown subcommand: ${verb}. Try  /spine show  |  /spine init  |  /spine pending  |  /spine dismiss <N>`);
        return 'continue';
    }
  },
};
