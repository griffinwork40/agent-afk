/**
 * `/worktree` slash command — REPL surface over the worktree sweep engine.
 *
 * Subcommands:
 *   /worktree list                  — show afk-managed worktrees + verdicts
 *   /worktree prune [flags]         — actually remove prunable worktrees
 *
 * Both reuse `runSweep` from `src/agent/worktree-sweep.ts` (the same engine
 * the daemon's nightly cron and `afk worktree` CLI subcommand use). This
 * file is intentionally a thin formatter — no policy decisions live here.
 *
 * Rows owned by the current REPL process (i.e. the worktree the user is
 * actively typing in) are marked with a `→` glyph so the user can see at
 * a glance which one is "theirs" without cross-referencing PIDs or paths.
 *
 * Repo root resolution uses `git rev-parse --git-common-dir` (not
 * `--show-toplevel`) so the slash works correctly when the REPL is itself
 * running inside a linked worktree — the common-dir trick gives us the
 * main repo's `.git`, whose parent is the canonical root.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { runSweep } from '../../../agent/worktree-sweep.js';
import type { ExecFileFn, SweepOptions } from '../../../agent/worktree-sweep.js';
import { palette } from '../../palette.js';
import type { SlashCommand, SlashContext, SlashResult, Writer } from '../types.js';

const execFile: ExecFileFn = promisify(execFileCallback) as ExecFileFn;

const VALID_SCOPES = ['interactive', 'diagnose', 'all'] as const;
type Scope = (typeof VALID_SCOPES)[number];

// 'stale-clean' is intentionally absent: the sweep engine preserves + warns
// on stale-clean (commits ahead of base) rather than removing.
const PRUNABLE_VERDICTS = new Set([
  'empty',
  'orphaned-dir',
  'orphaned-registration',
  'dead-owner',
]);

const WARNING_VERDICTS = new Set([
  'stale-clean',
  'stale-dirty',
]);

async function resolveRepoRoot(): Promise<string> {
  const result = await execFile('git', ['rev-parse', '--git-common-dir']);
  const raw = result.stdout.trim();
  if (!raw) throw new Error('Not in a git repository.');
  const absoluteGitDir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  return dirname(absoluteGitDir);
}

function formatAge(ageMs: number): string {
  if (ageMs <= 0) return '-';
  const days = ageMs / 86_400_000;
  if (days < 1) {
    const hours = Math.max(1, Math.round(ageMs / 3_600_000));
    return `${hours}h`;
  }
  return `${Math.round(days)}d`;
}

function verdictColor(verdict: string, text: string): string {
  if (PRUNABLE_VERDICTS.has(verdict)) return palette.error(text);
  if (WARNING_VERDICTS.has(verdict)) return palette.warning(text);
  if (verdict === 'locked') return palette.dim(text);
  return palette.dim(text);
}

interface ParsedArgs {
  scope: Scope;
  apply: boolean;
  unknown: string[];
}

function parseArgs(args: string, defaultScope: Scope): ParsedArgs {
  const tokens = args
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const result: ParsedArgs = { scope: defaultScope, apply: false, unknown: [] };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    if (tok === '--apply') {
      result.apply = true;
    } else if (tok === '--scope' && i + 1 < tokens.length) {
      const next = tokens[i + 1] as string;
      i++;
      if ((VALID_SCOPES as readonly string[]).includes(next)) {
        result.scope = next as Scope;
      } else {
        result.unknown.push(`--scope=${next}`);
      }
    } else if (tok.startsWith('--scope=')) {
      const value = tok.slice('--scope='.length);
      if ((VALID_SCOPES as readonly string[]).includes(value)) {
        result.scope = value as Scope;
      } else {
        result.unknown.push(tok);
      }
    } else {
      result.unknown.push(tok);
    }
  }
  return result;
}

/**
 * Read `.afk-worktree-meta.json` and return the `pid` field, or undefined
 * if missing/unreadable/malformed. Used purely to mark the row owned by
 * the current REPL — never for any cleanup decisions.
 */
async function readMetaPid(worktreePath: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(join(worktreePath, '.afk-worktree-meta.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return parsed.pid;
    }
  } catch { /* missing or malformed — return undefined */ }
  return undefined;
}

async function renderList(
  out: Writer,
  candidates: ReadonlyArray<{
    path: string;
    verdict: string;
    owner: string;
    ageMs: number;
  }>,
  ownerships: ReadonlyMap<string, number | undefined>,
): Promise<void> {
  if (candidates.length === 0) {
    out.info('No afk-managed worktrees found.');
    return;
  }

  const myPid = process.pid;

  out.line();
  out.line(palette.bold('Worktrees'));
  out.line(
    palette.dim(
      '  ' +
        'PATH'.padEnd(45) +
        '  ' +
        'OWNER'.padEnd(12) +
        '  ' +
        'AGE'.padEnd(5) +
        '  ' +
        'VERDICT'.padEnd(22) +
        '  ' +
        'PRUNE?',
    ),
  );

  for (const c of candidates) {
    const ownerPid = ownerships.get(c.path);
    const isMine = ownerPid === myPid;
    const marker = isMine ? palette.brand('→ ') : '  ';
    const pathDisplay = c.path.slice(-44).padEnd(45);
    const owner = c.owner.padEnd(12);
    const age = formatAge(c.ageMs).padEnd(5);
    const verdict = c.verdict.padEnd(22);
    const wouldPrune = PRUNABLE_VERDICTS.has(c.verdict)
      ? palette.error('yes')
      : WARNING_VERDICTS.has(c.verdict)
        ? palette.warning('warn')
        : palette.dim('no');
    const verdictColored = verdictColor(c.verdict, verdict);
    out.line(`${marker}${pathDisplay}  ${owner}  ${age}  ${verdictColored}  ${wouldPrune}`);
  }
  out.line();
  out.line(palette.dim('  → this session'));
  out.line();
}

async function gatherOwnerships(
  candidates: ReadonlyArray<{ path: string }>,
): Promise<Map<string, number | undefined>> {
  const out = new Map<string, number | undefined>();
  // Sequential reads keep semantics simple; the candidate list is small
  // (single-digit to low-hundreds) and meta reads are cheap.
  for (const c of candidates) {
    out.set(c.path, await readMetaPid(c.path));
  }
  return out;
}

async function handleList(ctx: SlashContext, args: string): Promise<SlashResult> {
  const parsed = parseArgs(args, 'interactive');
  if (parsed.unknown.length > 0) {
    ctx.out.warn(`Unknown args ignored: ${parsed.unknown.join(' ')}`);
  }

  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot();
  } catch (err) {
    ctx.out.error(`Not in a git repository: ${(err as Error).message}`);
    return 'continue';
  }

  let result;
  try {
    const options: SweepOptions = {
      execFile,
      repoRoot,
      dryRun: true,
      scope: parsed.scope,
    };
    result = await runSweep(options);
  } catch (err) {
    ctx.out.error(`Sweep failed: ${(err as Error).message}`);
    return 'continue';
  }

  const ownerships = await gatherOwnerships(result.candidates);
  await renderList(ctx.out, result.candidates, ownerships);

  for (const warning of result.warnings) {
    ctx.out.warn(warning);
  }

  return 'continue';
}

async function handlePrune(ctx: SlashContext, args: string): Promise<SlashResult> {
  const parsed = parseArgs(args, 'interactive');
  if (parsed.unknown.length > 0) {
    ctx.out.warn(`Unknown args ignored: ${parsed.unknown.join(' ')}`);
  }

  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot();
  } catch (err) {
    ctx.out.error(`Not in a git repository: ${(err as Error).message}`);
    return 'continue';
  }

  let result;
  try {
    const options: SweepOptions = {
      execFile,
      repoRoot,
      dryRun: !parsed.apply,
      scope: parsed.scope,
    };
    result = await runSweep(options);
  } catch (err) {
    ctx.out.error(`Sweep failed: ${(err as Error).message}`);
    return 'continue';
  }

  const verdictTally: Record<string, number> = {};
  for (const c of result.candidates) {
    verdictTally[c.verdict] = (verdictTally[c.verdict] ?? 0) + 1;
  }
  const tallyParts = Object.entries(verdictTally)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([v, n]) => `${v}=${n}`);

  if (result.dryRun) {
    const prunableCount = result.candidates.filter((c) => PRUNABLE_VERDICTS.has(c.verdict)).length;
    ctx.out.line();
    ctx.out.line(
      palette.warning('🔍 Dry-run — pass --apply to actually remove.') +
        ` Would prune ${prunableCount} worktree(s).` +
        (tallyParts.length > 0 ? `  [${tallyParts.join(' ')}]` : ''),
    );
  } else {
    const warnCount = result.warnings.filter((w) => w.startsWith('[WARN]')).length;
    const errorCount = result.warnings.filter((w) => w.startsWith('[ERROR]')).length;
    ctx.out.line();
    ctx.out.success(
      `Removed ${result.removed.length}, warned ${warnCount}, errors ${errorCount}` +
        (tallyParts.length > 0 ? `  [${tallyParts.join(' ')}]` : ''),
    );
  }

  for (const c of result.candidates) {
    const isRemoved = result.removed.includes(c.path);
    const glyph = isRemoved
      ? palette.error('✗')
      : PRUNABLE_VERDICTS.has(c.verdict)
        ? palette.warning('•')
        : palette.dim('·');
    ctx.out.line(`  ${glyph} [${c.verdict.padEnd(22)}] ${c.path}`);
  }

  for (const w of result.warnings) {
    if (w.startsWith('[ERROR]')) ctx.out.error(w);
    else ctx.out.warn(w);
  }

  ctx.out.line();
  return 'continue';
}

export const worktreeCmd: SlashCommand = {
  name: '/worktree',
  summary: 'List or prune afk-managed git worktrees',
  usage: '/worktree list | /worktree prune [--apply] [--scope <interactive|diagnose|all>]',
  hint: 'When you want to audit or clean up stale afk-managed git worktrees from past sessions.',
  async handler(ctx, args) {
    const trimmed = args.trim();
    if (trimmed.length === 0 || trimmed.startsWith('list')) {
      return handleList(ctx, trimmed.replace(/^list\s*/, ''));
    }
    if (trimmed.startsWith('prune')) {
      return handlePrune(ctx, trimmed.replace(/^prune\s*/, ''));
    }
    ctx.out.error(
      `Unknown /worktree subcommand. Usage:\n  /worktree list\n  /worktree prune [--apply] [--scope <interactive|diagnose|all>]`,
    );
    return 'continue';
  },
};
