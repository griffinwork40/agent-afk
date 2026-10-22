import { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { isAbsolute, resolve } from 'path';
import { isEnoent, isErrnoCode } from '../../utils/errors.js';
import { SessionManager } from '../session-manager.js';
import {
  formatError,
  formatCwdCurrent,
  formatCwdSwitch,
  formatSystemError,
} from '../formatter.js';
import { routeFromCtx } from '../route.js';

type LogFn = (...args: unknown[]) => void;

/*
 * Telegram-only commands. /clear, /compact, /model and /name were duplicates of
 * shared slash commands and now run through handlers/slash.ts (Stage 5).
 */

/**
 * Resolve a user-supplied path to an absolute path.
 *
 * Order:
 * 1. `~` and `~/...` → `$HOME` / `$HOME/...`
 * 2. Absolute path → use as-is
 * 3. Relative path → resolved against `base` (the current session cwd)
 *
 * Exported for test access; not part of the public bot surface.
 */
export function resolveCwdInput(input: string, base: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }
  return resolve(base, trimmed);
}

/**
 * Handle /cd (and /cwd alias) — change the working directory for the
 * current chat session.
 *
 * - No args: show the current effective cwd.
 * - With path: resolve (`~`, relative, absolute), validate it's a real
 *   directory, then persist via `sessionManager.setCwd`. The next
 *   message in this chat creates a fresh session in the new cwd.
 *
 * Refuses paths that don't exist or aren't directories — these would
 * otherwise be persisted and break the next session spawn.
 */
export async function handleCwd(
  ctx: Context,
  sessionManager: SessionManager,
  log: LogFn,
): Promise<void> {
  const route = routeFromCtx(ctx);
  if (!route) {
    await ctx.reply(formatError('Could not identify chat'));
    return;
  }

  const text = (ctx.message as Message.TextMessage).text;
  // Filter empties so `/cd ` (trailing whitespace) is treated as "no args"
  // rather than dispatching an empty path through resolveCwdInput.
  const args = text.split(/\s+/).slice(1).filter((a) => a.length > 0);

  // Reading the current cwd is allowed mid-turn since it doesn't mutate
  // session state — but mutating it via setCwd closes the active session,
  // which would orphan a streaming turn. Match the switchModel precedent
  // (unconditional close); the user can re-issue if they hit a race.
  if (args.length === 0) {
    const currentCwd = sessionManager.getCwd(route);
    await ctx.reply(formatCwdCurrent(currentCwd));
    return;
  }

  const pathArg = args[0];
  if (!pathArg) {
    await ctx.reply(formatError('Please specify a directory path'));
    return;
  }

  const base = sessionManager.getCwd(route) ?? process.cwd();
  const resolved = resolveCwdInput(pathArg, base);

  // Validate BEFORE persisting — a stat failure here means the next
  // session would fail to spawn with a confusing ENOENT from a tool
  // handler, far from the /cd call site.
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      await ctx.reply(formatError(`Not a directory: ${resolved}`));
      return;
    }
  } catch (error) {
    if (isEnoent(error)) {
      await ctx.reply(formatSystemError('ENOENT', resolved));
    } else if (isErrnoCode(error, 'EACCES')) {
      await ctx.reply(formatSystemError('EACCES', resolved));
    } else {
      log('cwd stat error:', error);
      await ctx.reply(formatError(error as Error));
    }
    return;
  }

  try {
    await sessionManager.setCwd(route, resolved);
    await ctx.reply(formatCwdSwitch(resolved));
  } catch (error) {
    log('Cwd switch error:', error);
    await ctx.reply(formatError(error as Error));
  }
}
