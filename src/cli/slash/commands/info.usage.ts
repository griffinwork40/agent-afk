import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import type { UsageWindow } from '../../../agent/subscription-usage.js';
import { readSubscriptionUsage } from '../../../agent/session-control/index.js';
import { writeKeyValue } from '../output-blocks.js';
import type { SlashCommand } from '../types.js';

/** Render a single usage window as a percentage plus reset time when present. */
function formatUsageWindowLine(label: string, w: UsageWindow): string {
  const pct = `${Math.round(w.utilization * 100)}%`;
  const resets = w.resetsAt ? palette.dim(`  (resets ${w.resetsAt.toLocaleString()})`) : '';
  return `  ${label.padEnd(16)}${palette.meta(pct)}${resets}`;
}

export const usageCmd: SlashCommand = {
  name: '/usage',
  summary: 'Show Claude subscription usage (5h / 7d windows)',
  hint: 'When you want to know how close you are to hitting your Claude subscription\'s rolling usage limits — distinct from /cost, which is session-local spend.',
  async handler(ctx) {
    const { out } = ctx;
    const result = await readSubscriptionUsage();
    out.line();
    if (result.kind === 'unavailable') {
      out.line(palette.bold('Subscription usage'));
      out.line(divider());
      if (result.reason === 'no-token') {
        out.warn('No Claude subscription token found — run `claude login`, then try /usage again.');
      } else {
        out.warn(`Usage unavailable (${result.reason}): ${result.detail}`);
      }
      out.line();
      return 'continue';
    }

    const windows: Array<[string, UsageWindow | undefined]> = [
      ['5-hour', result.fiveHour],
      ['7-day', result.sevenDay],
      ['7-day (Sonnet)', result.sevenDaySonnet],
      ['7-day (Opus)', result.sevenDayOpus],
    ];
    const available = windows.filter((entry): entry is [string, UsageWindow] => entry[1] !== undefined);

    writeKeyValue(out, {
      title: 'Subscription usage',
      entries: available.length === 0
        ? [{ key: 'Status', value: 'No usage windows reported.' }]
        : available.map(([key, w]) => ({
          key,
          value: `${Math.round(w.utilization * 100)}%${w.resetsAt ? `  (resets ${w.resetsAt.toLocaleString()})` : ''}`,
        })),
    }, () => {
      out.line(palette.bold('Subscription usage'));
      out.line(divider());
      if (available.length === 0) {
        out.line(palette.dim('  No usage windows reported.'));
      } else {
        for (const [label, w] of available) {
          out.line(formatUsageWindowLine(label, w));
        }
      }
    });
    out.line();
    return 'continue';
  },
};

