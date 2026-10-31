import { palette } from '../../palette.js';
import { writeKeyValue } from '../output-blocks.js';
import { collectUsageSummary } from '../../commands/usage.js';
import { usageRows } from '../../../agent/usage/usage-formatter.js';
import type { SlashCommand } from '../types.js';

export const usageCmd: SlashCommand = {
  name: '/usage',
  summary: 'Show subscription usage per provider (Claude, Codex) — 5h / 7d windows',
  hint: 'When you want to know how close you are to hitting your subscription\'s rolling usage limits — distinct from /cost, which is session-local spend.',
  async handler(ctx) {
    const { out } = ctx;
    const summary = await collectUsageSummary();
    out.line();

    const entries: Array<{ key: string; value: string }> = [];
    for (const p of summary.providers) {
      entries.push({ key: `${p.provider} / ${p.account}`, value: p.status });
      for (const row of usageRows(p)) {
        entries.push({ key: `  ${row.label}`, value: row.value });
      }
    }

    if (entries.length === 0) {
      entries.push({ key: 'Status', value: 'No providers found.' });
    }

    writeKeyValue(out, { title: 'Subscription usage', entries }, () => {
      out.line(palette.bold('Subscription usage'));
      out.line('─'.repeat(80));
      for (const e of entries) {
        out.line(`  ${e.key.padEnd(20)}${e.value}`);
      }
    });
    out.line();
    return 'continue';
  },
};
