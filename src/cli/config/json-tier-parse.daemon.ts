/**
 * Daemon-section parser extracted from `json-tier-parse.ts` to keep
 * `parseJsonConfigFile` under the 200-line function ceiling.
 *
 * @module cli/config/json-tier-parse.daemon
 */

import type { CliConfig } from './types.js';

/**
 * Parse the `daemon` block of a raw JSON config object into a typed
 * {@link CliConfig.daemon} value.  Unknown or malformed fields are ignored.
 *
 * @param raw - The raw `json.daemon` value from the config file.
 */
export function parseDaemonBlock(raw: unknown): NonNullable<CliConfig['daemon']> {
  const daemon: NonNullable<CliConfig['daemon']> = {};
  if (!raw || typeof raw !== 'object') return daemon;
  const json = raw as Record<string, unknown>;

  if (typeof json['task'] === 'string') daemon.task = json['task'];
  if (typeof json['taskId'] === 'string') daemon.taskId = json['taskId'];

  const wp = json['worktreePrune'];
  if (wp && typeof wp === 'object') {
    const w = wp as Record<string, unknown>;
    daemon.worktreePrune = {
      enabled: typeof w['enabled'] === 'boolean' ? w['enabled'] : true,
      cron: typeof w['cron'] === 'string' ? w['cron'] : '0 4 * * *',
      maxAgeDaysClean: typeof w['maxAgeDaysClean'] === 'number' ? w['maxAgeDaysClean'] : 14,
      maxAgeDaysDirty: typeof w['maxAgeDaysDirty'] === 'number' ? w['maxAgeDaysDirty'] : 30,
      scope: typeof w['scope'] === 'string' ? w['scope'] : 'all',
    };
  }

  const th = json['toolHealth'];
  if (th && typeof th === 'object') {
    const t = th as Record<string, unknown>;
    daemon.toolHealth = {
      enabled: typeof t['enabled'] === 'boolean' ? t['enabled'] : true,
      cron: typeof t['cron'] === 'string' ? t['cron'] : '17 * * * *',
    };
  }

  if (typeof json['verifyDone'] === 'boolean') daemon.verifyDone = json['verifyDone'];
  return daemon;
}
