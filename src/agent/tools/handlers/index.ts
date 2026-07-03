/**
 * Default tool handler registry.
 *
 * Builds a `Map<string, ToolHandler>` wiring every built-in tool name to its
 * handler function. The `SessionToolDispatcher` uses this map for routing.
 *
 * @module agent/tools/handlers
 */

import type { ToolHandler } from '../types.js';
import { bashHandler, createBashHandler } from './bash.js';
import { readFileHandler } from './read-file.js';
import { writeFileHandler } from './write-file.js';
import { editFileHandler } from './edit-file.js';
import { globHandler, createGlobHandler } from './glob.js';
import { grepHandler, createGrepHandler } from './grep.js';
import { listDirectoryHandler } from './list-directory.js';
import { sendTelegramHandler } from './send-telegram.js';
import { webScrapeHandler } from './web-scrape.js';
import {
  createScheduleHandler,
  listSchedulesHandler,
  getScheduleHistoryHandler,
  cancelScheduleHandler,
} from './schedules.js';
import { createTerminalFontSizeHandler, terminalFontSizeHandler } from './terminal-font-size.js';
import { createWorktreeHandler } from './worktree.js';
import { configGetHandler, configSetHandler } from './config-ops.js';
// below for trivial re-enable.
import { askQuestionHandler } from './ask-question.js';
// Browser-control handlers. The provider behind them lazy-loads Playwright on
// first invocation — see `src/browser/registry.ts`. Users who never call a
// browser tool never load chromium or the playwright package.
import { browserOpenHandler } from './browser-open.js';
import { browserObserveHandler } from './browser-observe.js';
import { browserActHandler } from './browser-act.js';
import { browserScreenshotHandler } from './browser-screenshot.js';
import { browserCloseHandler } from './browser-close.js';

/**
 * Build the built-in tool handler map for a session.
 *
 * @param permissionMode - The session's permission mode. When supplied,
 *   the bash handler is created with the correct mode via closure so that
 *   concurrent sessions with different modes do not clobber each other's
 *   state through `process.env`.
 * @param cwd - The session's working directory (typically a worktree path
 *   from `afk interactive -w`). When supplied, bash/grep spawn child
 *   processes with this cwd, and glob/grep use it as the default search
 *   path when the model omits one. Without this, concurrent sessions in
 *   different worktrees all spawn against the host's `process.cwd()` —
 *   causing `git stash`, `git checkout`, etc. to clobber each other.
 *   The Node process's `process.cwd()` is never mutated.
 */
export function createBuiltinHandlers(
  permissionMode?: string,
  cwd?: string,
): Map<string, ToolHandler> {
  const bash = permissionMode !== undefined
    ? createBashHandler(permissionMode, cwd)
    : (cwd !== undefined ? createBashHandler('default', cwd) : bashHandler);
  const glob = cwd !== undefined ? createGlobHandler(cwd) : globHandler;
  const grep = cwd !== undefined ? createGrepHandler(cwd) : grepHandler;
  const terminalFontSize = createTerminalFontSizeHandler();
  const worktree = createWorktreeHandler(cwd);
  return new Map<string, ToolHandler>([
    ['bash', bash],
    ['read_file', readFileHandler],
    ['write_file', writeFileHandler],
    ['edit_file', editFileHandler],
    ['glob', glob],
    ['grep', grep],
    ['list_directory', listDirectoryHandler],
    ['send_telegram', sendTelegramHandler],
    ['web_scrape', webScrapeHandler],
    ['create_schedule', createScheduleHandler],
    ['list_schedules', listSchedulesHandler],
    ['get_schedule_history', getScheduleHistoryHandler],
    ['cancel_schedule', cancelScheduleHandler],
    ['worktree', worktree],
    ['terminal_font_size', terminalFontSize],
    ['config_get', configGetHandler],
    ['config_set', configSetHandler],
    ['ask_question', askQuestionHandler],
    ['browser_open', browserOpenHandler],
    ['browser_observe', browserObserveHandler],
    ['browser_act', browserActHandler],
    ['browser_screenshot', browserScreenshotHandler],
    ['browser_close', browserCloseHandler],
  ]);
}

export {
  bashHandler,
  readFileHandler,
  writeFileHandler,
  editFileHandler,
  globHandler,
  grepHandler,
  listDirectoryHandler,
  sendTelegramHandler,
  webScrapeHandler,
  createScheduleHandler,
  listSchedulesHandler,
  getScheduleHistoryHandler,
  cancelScheduleHandler,
  terminalFontSizeHandler,
  createWorktreeHandler,
  configGetHandler,
  configSetHandler,
  askQuestionHandler,
  browserOpenHandler,
  browserObserveHandler,
  browserActHandler,
  browserScreenshotHandler,
  browserCloseHandler,
};
