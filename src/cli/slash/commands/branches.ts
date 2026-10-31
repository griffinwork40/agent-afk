/**
 * `/branches` — list and switch between conversation branches created by
 * `/rewind` (#4294, stage 3 of #4271).
 *
 * Before `/rewind` truncates the conversation it calls `forkJournal` to copy
 * the pre-rewind journal state into a sibling session with `meta.forkedFrom`
 * ancestry. `/branches` discovers all sessions that share a forkedFrom ancestor
 * with the current one and lets the operator switch between them.
 *
 * Switching restores the sibling session by emitting a resume control result
 * that the REPL feeds to `--resume`. The operator can then run `/rewind files`
 * in the switched session to restore the file checkpoint for that branch.
 *
 * @module cli/slash/commands/branches
 */

import { palette } from '../../palette.js';
import { loadSession, findSession, listSessions } from '../../session-store.js';
import { resolveFromFound } from './resume.js';
import { formatResumeCommand } from '../../resume-command.js';
import { isSafeLedgerSessionId } from '../../../paths.js';
import type { SlashCommand, SlashContext, SlashResult } from '../types.js';

// ---------------------------------------------------------------------------
// Ancestry helpers
// ---------------------------------------------------------------------------

/**
 * Walk the forkedFrom chain upward from `sessionId`, returning every id in
 * the chain (current → … → root). Bounded to avoid loops on corrupt sidecars.
 * Populated into `memo` as a side-effect so callers can reuse loaded sidecars.
 */
function ancestorChain(sessionId: string, memo: Map<string, ReturnType<typeof loadSession>>): string[] {
  const chain: string[] = [sessionId];
  const visited = new Set<string>([sessionId]);
  const MAX_DEPTH = 64;

  for (let i = 0; i < MAX_DEPTH; i++) {
    const tip = chain[chain.length - 1]!;
    let sidecar = memo.get(tip);
    if (sidecar === undefined) {
      sidecar = loadSession(tip);
      memo.set(tip, sidecar);
    }
    const parent = sidecar?.forkedFrom;
    if (!parent) break;
    if (!isSafeLedgerSessionId(parent)) break; // reject unsafe ids from stored sidecars
    if (visited.has(parent)) break; // cycle guard
    visited.add(parent);
    chain.push(parent);
  }
  return chain;
}

/** Return the root session id of the branch tree containing `sessionId`. */
function rootOf(sessionId: string, memo: Map<string, ReturnType<typeof loadSession>>): string {
  const chain = ancestorChain(sessionId, memo);
  return chain[chain.length - 1] ?? sessionId;
}

// ---------------------------------------------------------------------------
// Branch collection
// ---------------------------------------------------------------------------

interface BranchEntry {
  id: string;
  sessionId?: string;
  name?: string;
  model: string;
  savedAt: number;
  totalTurns: number;
  forkedFrom?: string;
  isCurrent: boolean;
}

/**
 * Collect all session sidecars that share the same branch-tree root as
 * `currentId`. Returns them sorted: current branch first, then by savedAt
 * descending (most-recent tip first).
 */
function collectBranches(currentId: string): BranchEntry[] {
  const memo = new Map<string, ReturnType<typeof loadSession>>();
  const root = rootOf(currentId, memo);
  const branches: BranchEntry[] = [];

  for (const entry of listSessions()) {
    if (!isSafeLedgerSessionId(entry.id)) continue; // reject unsafe ids from stored sidecars
    const entryRoot = rootOf(entry.id, memo);
    if (entryRoot !== root) continue;

    // Reuse the sidecar already loaded by rootOf/ancestorChain when available.
    let sidecar = memo.get(entry.id);
    if (sidecar === undefined) {
      sidecar = loadSession(entry.id);
      memo.set(entry.id, sidecar);
    }
    const isCurrent =
      entry.id === currentId ||
      (entry.sessionId !== undefined && entry.sessionId === currentId);

    branches.push({
      id: entry.id,
      sessionId: entry.sessionId,
      name: entry.name,
      model: typeof entry.model === 'string' ? entry.model : String(entry.model),
      savedAt: entry.savedAt,
      totalTurns: entry.totalTurns,
      forkedFrom: sidecar?.forkedFrom,
      isCurrent,
    });
  }

  branches.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    return b.savedAt - a.savedAt;
  });

  return branches;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtAge(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Switch helper
// ---------------------------------------------------------------------------

async function handleSwitch(
  ctx: SlashContext,
  currentId: string,
  targetArg: string,
): Promise<SlashResult> {
  if (!targetArg) {
    ctx.out.warn('Usage: /branches switch <id>');
    return 'continue';
  }

  const branches = collectBranches(currentId);
  if (branches.length <= 1) {
    ctx.out.info('No other branches to switch to.');
    return 'continue';
  }

  // Resolve by exact match first, then prefix.
  const exact = branches.find(
    (b) => b.id === targetArg || b.sessionId === targetArg,
  );
  const prefixMatches = exact
    ? []
    : branches.filter(
        (b) =>
          b.id.startsWith(targetArg) ||
          (b.sessionId !== undefined && b.sessionId.startsWith(targetArg)),
      );

  if (!exact && prefixMatches.length > 1) {
    ctx.out.error(
      `Ambiguous id prefix "${targetArg}" matches ${prefixMatches.length} branches. Provide a longer prefix.`,
    );
    return 'continue';
  }

  const branch = exact ?? prefixMatches[0];
  if (!branch) {
    ctx.out.error(
      `No branch found matching "${targetArg}". Run /branches to list available branches.`,
    );
    return 'continue';
  }

  if (branch.isCurrent) {
    ctx.out.info('Already on this branch.');
    return 'continue';
  }

  const resumeKey = branch.sessionId ?? branch.id;
  const command = formatResumeCommand(resumeKey, branch.model);

  // Use requestResume when available (REPL interactive swap).
  if (typeof ctx.requestResume === 'function') {
    const found = findSession(resumeKey);
    if (found) {
      const currentSdkId = ctx.session.current.sessionId;
      const targetSdkId = found.data.sessionId;
      const isSameSession =
        (currentSdkId !== undefined && targetSdkId !== undefined && currentSdkId === targetSdkId) ||
        (currentSdkId !== undefined && currentSdkId === found.id);
      if (isSameSession) {
        ctx.out.info('Already on this branch.');
        return 'continue';
      }
      const result = await ctx.requestResume(resolveFromFound(found));
      // After a successful swap the REPL replaces the session; nothing more to emit.
      if (result.ok) {
        ctx.out.success(`Switching to branch ${shortId(branch.id)}…`);
        ctx.out.line('');
        ctx.out.line(palette.dim('  To restore that branch\'s files, run /rewind files after switching.'));
        ctx.out.line('');
        return 'continue';
      }
    } else {
      ctx.out.warn(`Session ${shortId(resumeKey)} not found; falling back to resume command.`);
    }
  }

  // Fallback: print the resume command (Telegram / daemon / web surfaces).
  ctx.out.line(palette.dim('  Resume this branch with:'));
  ctx.out.line(palette.brand(`    ${command}`));
  ctx.out.line('');
  return 'continue';
}

// ---------------------------------------------------------------------------
// /branches command
// ---------------------------------------------------------------------------

export const branchesCmd: SlashCommand = {
  name: '/branches',
  summary: 'List and switch between rewind branches',
  usage: '/branches [switch <id>]',
  hint: 'When you rewound to an earlier prompt, /branches shows all saved tips of this conversation tree and lets you switch back. Each /rewind saves the abandoned path as a named branch.',
  requires: ['sessionControl'],

  async handler(ctx: SlashContext, args: string): Promise<SlashResult> {
    const currentId = ctx.stats.sessionId;
    if (!currentId) {
      ctx.out.warn('No session id available — cannot list branches.');
      return 'continue';
    }

    const trimmed = args.trim();

    // Subcommand: /branches switch <id>
    if (trimmed === 'switch' || trimmed.startsWith('switch ')) {
      const targetArg = trimmed.slice('switch'.length).trim();
      return handleSwitch(ctx, currentId, targetArg);
    }

    // Default: list all branches.
    const branches = collectBranches(currentId);

    if (branches.length <= 1) {
      ctx.out.info('No branches yet — use /rewind to create a branch point.');
      ctx.out.line('');
      ctx.out.line(
        palette.dim('  Tip: /rewind saves the abandoned conversation as a branch you can return to.'),
      );
      return 'continue';
    }

    ctx.out.line('');
    ctx.out.line(
      palette.heading(
        `  ${branches.length} branch${branches.length !== 1 ? 'es' : ''} in this conversation tree:`,
      ),
    );
    ctx.out.line('');

    const colId = 10;
    const colAge = 6;
    const colTurns = 7;
    ctx.out.line(
      palette.dim(
        `  ${'ID'.padEnd(colId)}  ${'AGE'.padEnd(colAge)}  ${'TURNS'.padEnd(colTurns)}  NAME`,
      ),
    );
    ctx.out.line(
      palette.dim(
        `  ${'─'.repeat(colId)}  ${'─'.repeat(colAge)}  ${'─'.repeat(colTurns)}  ${'─'.repeat(30)}`,
      ),
    );

    for (const branch of branches) {
      const marker = branch.isCurrent ? palette.success('▶') : ' ';
      const id = shortId(branch.id);
      const age = fmtAge(branch.savedAt);
      const turns = String(branch.totalTurns);
      const label = branch.name ?? branch.id.slice(0, 20);

      ctx.out.line(
        `${marker} ${palette.info(id.padEnd(colId))}  ${palette.dim(age.padEnd(colAge))}  ${turns.padEnd(colTurns)}  ${branch.isCurrent ? palette.bold(label) : label}`,
      );
    }

    ctx.out.line('');
    ctx.out.line(palette.dim('  To switch: /branches switch <id-prefix>'));
    ctx.out.line('');

    return 'continue';
  },
};
