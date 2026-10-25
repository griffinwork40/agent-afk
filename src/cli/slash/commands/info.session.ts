import { palette } from '../../palette.js';
import { formatCost, formatTokens } from '../../format-utils.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';
import { writeKeyValue } from '../output-blocks.js';
import type { SlashCommand } from '../types.js';

/** New command: no historical console bytes to preserve. Reads local stats only. */
export const infoCmd: SlashCommand = {
  name: '/info',
  summary: 'Show session identity, model, permissions, and recorded usage',
  async handler(ctx) {
    const { stats, out } = ctx;
    const footprint = stats.turnTokens.at(-1)?.footprint;
    const entries = [
      { key: 'Session', value: stats.sessionId ?? 'Not assigned' },
      { key: 'Name', value: stats.name ?? 'Unnamed' },
      { key: 'Model', value: stats.model },
      { key: 'Permission mode', value: stats.permissionMode },
      { key: 'Turns', value: String(stats.totalTurns) },
      { key: 'Recorded cost', value: formatCost(stats.totalCostUsd) },
      { key: 'Unpriced turns', value: String(stats.unpricedTurns) },
      { key: 'Recorded tokens', value: formatTokens(stats.totalTokens) },
      // This is the last recorded occupancy, not cumulative tokens or live SDK state.
      { key: 'Context (last turn)', value: footprint === undefined ? 'Not reported' : `${formatTokens(footprint)} tokens` },
      ...(stats.cwd === undefined ? [] : [{ key: 'Directory', value: stats.cwd }]),
    ];
    writeKeyValue(out, { title: 'Session info', entries }, () => {
      out.line();
      out.line(palette.bold('Session info'));
      for (const { key, value } of entries) {
        out.line(`  ${palette.dim(key.padEnd(20))}${palette.meta(sanitizeForDisplay(value))}`);
      }
      out.line();
    });
    return 'continue';
  },
};
