/**
 * Handler for the `worktree` lifecycle tool.
 *
 * Gives the model a sanctioned lifecycle for afk-managed git worktrees under
 * `<repoRoot>/.afk-worktrees/`, replacing the raw `bash: git worktree add`
 * pattern that produced meta-less ghost worktrees the sweep engine
 * (`src/agent/worktree-sweep.ts`) reaps or leaks:
 *
 *   - `create`  — worktree + branch under `.afk-worktrees/` WITH a
 *                 `.afk-worktree-meta.json` (owner 'agent', pid, createdAt),
 *                 so all sweep guards (age, PID-liveness) apply.
 *   - `keep`    — `git worktree lock` with a reason. The sweep short-circuits
 *                 on locked trees before every other verdict — this is the
 *                 self-save primitive.
 *   - `release` — `git worktree unlock`.
 *   - `list`    — dry-run sweep: paths + verdicts + age, so the model can see
 *                 which trees are endangered or stale.
 *   - `remove`  — guarded removal: refuses dirty, locked, commits-ahead, main
 *                 worktree, and anything outside `.afk-worktrees/`. `force`
 *                 overrides the dirty/commits-ahead refusal only.
 *
 * Pattern: follows schedules.ts — manual input validation, isError: true on
 * failure, no thrown exceptions.
 *
 * @module agent/tools/handlers/worktree
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { join, resolve, isAbsolute, dirname, sep } from 'node:path';
import type { ToolHandler } from '../types.js';
import { runSweep } from '../../worktree-sweep.js';
import type { ExecFileFn } from '../../worktree-sweep.js';

const defaultExecFile: ExecFileFn = promisify(execFileCallback) as ExecFileFn;

/** Injectable deps for tests. */
export interface WorktreeHandlerDeps {
  execFile?: ExecFileFn;
}

interface RepoContext {
  repoRoot: string;
  afkWorktreesRoot: string;
}

/**
 * Resolve the repo root from the session cwd via `--git-common-dir` so the
 * answer is the MAIN checkout even when the session itself runs inside a
 * linked worktree (same trick as the `/worktree` slash command).
 */
async function resolveRepoContext(
  execFile: ExecFileFn,
  cwd: string,
): Promise<RepoContext> {
  const result = await execFile('git', ['-C', cwd, 'rev-parse', '--git-common-dir']);
  const raw = result.stdout.trim();
  if (!raw) throw new Error('Not in a git repository.');
  const absoluteGitDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const repoRoot = dirname(absoluteGitDir);
  return { repoRoot, afkWorktreesRoot: join(repoRoot, '.afk-worktrees') };
}

/** Lowercase-kebab sanitization for worktree slugs / branch fragments. */
function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
}

/** True when `child` is `parent` or nested inside it. */
function isPathWithin(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

interface PorcelainEntry {
  path: string;
  branch?: string;
  locked: boolean;
}

async function listRegisteredWorktrees(
  execFile: ExecFileFn,
  repoRoot: string,
): Promise<PorcelainEntry[]> {
  const out = await execFile('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
  const entries: PorcelainEntry[] = [];
  let current: PorcelainEntry | undefined;
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), locked: false };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.startsWith('locked') && current) {
      current.locked = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** Find the registered entry for `path`, or undefined. */
async function findEntry(
  execFile: ExecFileFn,
  repoRoot: string,
  path: string,
): Promise<PorcelainEntry | undefined> {
  const entries = await listRegisteredWorktrees(execFile, repoRoot);
  return entries.find((e) => resolve(e.path) === resolve(path));
}

/**
 * Validate a caller-supplied worktree path: absolute or relative to the afk
 * root by slug, must resolve inside `.afk-worktrees/`, must be registered.
 * Returns the entry, or an error string.
 */
async function resolveManagedWorktree(
  execFile: ExecFileFn,
  ctx: RepoContext,
  pathInput: string,
): Promise<PorcelainEntry | string> {
  const candidate = isAbsolute(pathInput)
    ? pathInput
    : join(ctx.afkWorktreesRoot, pathInput);
  if (!isPathWithin(candidate, ctx.afkWorktreesRoot)) {
    return `Refused: ${candidate} is outside the afk-managed worktree root (${ctx.afkWorktreesRoot}). This tool only manages worktrees under .afk-worktrees/.`;
  }
  const entry = await findEntry(execFile, ctx.repoRoot, candidate);
  if (!entry) {
    return `No registered git worktree at ${candidate}. Use action "list" to see managed worktrees.`;
  }
  return entry;
}

async function isDirty(execFile: ExecFileFn, worktreePath: string): Promise<boolean> {
  try {
    const status = await execFile('git', ['-C', worktreePath, 'status', '--porcelain']);
    return status.stdout.trim().length > 0;
  } catch {
    return true; // unreadable → treat as dirty (safe fallback)
  }
}

async function commitsAhead(
  execFile: ExecFileFn,
  repoRoot: string,
  worktreePath: string,
): Promise<number> {
  // Base SHA from meta when available; unknowable without it → report 0 and
  // rely on the dirty/lock guards (mirrors the sweep engine's fallback).
  try {
    const metaRaw = await fs.readFile(join(worktreePath, '.afk-worktree-meta.json'), 'utf-8');
    const meta = JSON.parse(metaRaw) as { baseSha?: string };
    if (!meta.baseSha) return 0;
    const head = await execFile('git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
    const count = await execFile('git', [
      '-C', repoRoot, 'rev-list', `${meta.baseSha}..${head.stdout.trim()}`, '--count',
    ]);
    return parseInt(count.stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Build the `worktree` tool handler bound to a session cwd.
 *
 * @param cwd - Session working directory (worktree path under `afk -w`).
 *   Repo-root resolution anchors here; falls back to `process.cwd()`.
 * @param deps - Test injection point for the git exec function.
 */
export function createWorktreeHandler(
  cwd?: string,
  deps?: WorktreeHandlerDeps,
): ToolHandler {
  const execFile = deps?.execFile ?? defaultExecFile;

  return async (input, _signal, context) => {
    if (!input || typeof input !== 'object') {
      return { content: 'Invalid input: expected object', isError: true };
    }
    const obj = input as Record<string, unknown>;
    const action = obj['action'];
    if (
      action !== 'create' && action !== 'keep' && action !== 'release' &&
      action !== 'list' && action !== 'remove'
    ) {
      return {
        content: 'Invalid input: action must be one of create | keep | release | list | remove',
        isError: true,
      };
    }

    const anchor = context?.resolveBase ?? context?.cwd ?? cwd ?? process.cwd();
    let ctx: RepoContext;
    try {
      ctx = await resolveRepoContext(execFile, anchor);
    } catch (err) {
      return {
        content: `Cannot resolve git repo root from ${anchor}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    try {
      switch (action) {
        case 'create': {
          if (typeof obj['name'] !== 'string' || !obj['name']) {
            return { content: 'Invalid input: name required for create', isError: true };
          }
          const slug = sanitizeSlug(obj['name']);
          if (!slug) {
            return { content: `Invalid input: name "${obj['name']}" sanitizes to empty`, isError: true };
          }
          const worktreePath = join(ctx.afkWorktreesRoot, slug);
          const existing = await findEntry(execFile, ctx.repoRoot, worktreePath);
          if (existing) {
            return { content: `Worktree already exists at ${worktreePath}`, isError: true };
          }
          const prefix = process.env['AFK_WORKTREE_BRANCH_PREFIX'] ?? 'afk/';
          const branch = `${prefix}${slug}`;
          const baseRef = typeof obj['base'] === 'string' && obj['base'] ? obj['base'] : 'HEAD';
          await execFile('git', [
            '-C', ctx.repoRoot, 'worktree', 'add', '-b', branch, worktreePath, baseRef,
          ]);
          // Meta write is what makes this tree a first-class citizen of the
          // sweep protocol (age from createdAt, PID liveness). Best-effort:
          // never fail the create over it.
          let baseSha = '';
          try {
            const sha = await execFile('git', ['-C', ctx.repoRoot, 'rev-parse', baseRef]);
            baseSha = sha.stdout.trim();
          } catch { /* non-fatal */ }
          try {
            await fs.writeFile(
              join(worktreePath, '.afk-worktree-meta.json'),
              JSON.stringify(
                {
                  owner: 'agent',
                  pid: process.pid,
                  createdAt: new Date().toISOString(),
                  baseSha,
                  baseBranch: baseRef,
                },
                null,
                2,
              ),
              'utf-8',
            );
          } catch { /* best-effort */ }
          return {
            content: JSON.stringify({ path: worktreePath, branch, base: baseRef }),
          };
        }

        case 'keep': {
          if (typeof obj['path'] !== 'string' || !obj['path']) {
            return { content: 'Invalid input: path required for keep', isError: true };
          }
          const entry = await resolveManagedWorktree(execFile, ctx, obj['path']);
          if (typeof entry === 'string') return { content: entry, isError: true };
          const reason = typeof obj['reason'] === 'string' && obj['reason']
            ? obj['reason']
            : 'kept by agent';
          await execFile('git', [
            '-C', ctx.repoRoot, 'worktree', 'lock', '--reason', `afk: ${reason}`, entry.path,
          ]);
          return {
            content: JSON.stringify({
              path: entry.path,
              locked: true,
              note: 'The sweep engine never removes or warns about locked worktrees. Use action "release" to unlock.',
            }),
          };
        }

        case 'release': {
          if (typeof obj['path'] !== 'string' || !obj['path']) {
            return { content: 'Invalid input: path required for release', isError: true };
          }
          const entry = await resolveManagedWorktree(execFile, ctx, obj['path']);
          if (typeof entry === 'string') return { content: entry, isError: true };
          await execFile('git', ['-C', ctx.repoRoot, 'worktree', 'unlock', entry.path]);
          return { content: JSON.stringify({ path: entry.path, locked: false }) };
        }

        case 'list': {
          const result = await runSweep({
            execFile,
            repoRoot: ctx.repoRoot,
            dryRun: true,
            scope: 'all',
          });
          return {
            content: JSON.stringify(
              result.candidates.map((c) => ({
                path: c.path,
                verdict: c.verdict,
                owner: c.owner,
                ageDays: Math.round(c.ageMs / 86_400_000),
              })),
            ),
          };
        }

        case 'remove': {
          if (typeof obj['path'] !== 'string' || !obj['path']) {
            return { content: 'Invalid input: path required for remove', isError: true };
          }
          const entry = await resolveManagedWorktree(execFile, ctx, obj['path']);
          if (typeof entry === 'string') return { content: entry, isError: true };
          if (resolve(entry.path) === resolve(ctx.repoRoot)) {
            return { content: 'Refused: cannot remove the main worktree.', isError: true };
          }
          if (entry.locked) {
            return {
              content: `Refused: ${entry.path} is locked. Use action "release" first if removal is really intended.`,
              isError: true,
            };
          }
          const force = obj['force'] === true;
          if (!force) {
            if (await isDirty(execFile, entry.path)) {
              return {
                content: `Refused: ${entry.path} has uncommitted changes. Commit/stash them, or pass force: true to discard.`,
                isError: true,
              };
            }
            const ahead = await commitsAhead(execFile, ctx.repoRoot, entry.path);
            if (ahead > 0) {
              return {
                content: `Refused: ${entry.path} has ${ahead} commit(s) ahead of its base. The branch ref would survive, but pass force: true to confirm removing the checkout.`,
                isError: true,
              };
            }
          }
          const args = ['-C', ctx.repoRoot, 'worktree', 'remove'];
          if (force) args.push('--force');
          args.push(entry.path);
          await execFile('git', args);
          // Branch intentionally left intact — removal drops the checkout only.
          return {
            content: JSON.stringify({ path: entry.path, removed: true, branchPreserved: entry.branch ?? null }),
          };
        }
      }
    } catch (err) {
      return {
        content: `worktree ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
    // Unreachable — switch is exhaustive over validated actions.
    return { content: 'Unhandled action', isError: true };
  };
}
