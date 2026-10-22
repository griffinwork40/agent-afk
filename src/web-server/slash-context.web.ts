/**
 * Web-surface SlashContext adapter.
 *
 * Creates a SlashContext-compatible object for use in the command execution
 * route. Only the fields that slash handlers actually need are populated;
 * optional fields that require terminal machinery (compositor, soft-stop,
 * ledger, etc.) are absent.
 */

import type { SlashContext, UiSurface } from '../cli/slash/types.js';
import type { SessionRef } from '../agent/session-ref.js';
import type { SessionStats } from '../cli/slash/types.js';
import type { BufferingWriter } from './writer.buffer.js';
import { webCapabilities } from '../cli/slash/capabilities.js';

const NO_OP_UI: UiSurface = {
  clearScreen: () => {},
  repaintStatusLine: () => {},
};

/**
 * Build a SlashContext suitable for web command execution.
 *
 * @param sessionRef - Mutable session reference (may have undefined current).
 * @param stats - Session statistics (or a fresh stub if not yet initialized).
 * @param writer - BufferingWriter that captures all handler output.
 * @param cwd - Working directory for the session.
 */
export function createWebSlashContext(
  sessionRef: SessionRef,
  stats: SessionStats,
  writer: BufferingWriter,
  cwd: string,
  controls: Pick<SlashContext, 'fastMode' | 'getFastModeContext'> = {},
): SlashContext {
  // cwd lives on SessionStats, not SlashContext — populate it there so
  // commands that read ctx.stats.cwd (e.g. /tasks) see the correct path.
  stats.cwd = cwd;
  return {
    capabilities: webCapabilities(),
    session: sessionRef,
    stats,
    out: writer.asWriterInterface(),
    ui: NO_OP_UI,
    fastMode: controls.fastMode,
    getFastModeContext: controls.getFastModeContext,
    // Intentionally absent: setSoftStopHandler, getCompositor, ledger,
    // requestResume, mcpManager, etc.
    // Commands needing these integrations declare positive requirements.
  };
}
