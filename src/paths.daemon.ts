/**
 * Path helpers for daemon builtin tasks.
 *
 * Extracted from `src/paths.ts` to keep that file within the 350-code-line
 * ceiling. All daemon builtin paths derive from `getAfkStateDir()`.
 *
 * @module paths.daemon
 */

import { join } from 'path';
import { getAfkStateDir } from './paths.js';

/**
 * Persisted alert-state for the tool-health daemon builtin.
 *
 * Maps `"${tool}::${errorHead}"` → last-alerted epoch ms. Used by
 * `src/agent/daemon/tool-health-task.ts` to enforce the 24-hour
 * per-(tool, errorHead) alert cooldown across daemon restarts.
 *
 * Lives in the state tier alongside other daemon-managed files so it is
 * included in any state-dir sweep / backup.
 */
export function getToolHealthAlertStatePath(): string {
  return join(getAfkStateDir(), 'daemon', 'tool-health-alerts.json');
}
