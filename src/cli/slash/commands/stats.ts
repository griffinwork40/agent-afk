/**
 * /stats slash command — displays session statistics including trusted-skill runs.
 */

import { getTrustedSkill } from '../../trusted-skill-badge.js';
import { palette } from '../../palette.js';
import type { SlashCommand } from '../types.js';

export const statsCmd: SlashCommand = {
  name: '/stats',
  summary: 'Show session statistics including skill runs',
  hint: 'When you want a summary of skill invocations, token usage, and cost for the current session.',
  async handler(ctx) {
    const ledger = ctx.ledger;
    if (!ledger) {
      ctx.out.info('No skill stats available.');
      return 'continue';
    }
    const summary = ledger.summary();
    if (!summary) {
      ctx.out.info('No skill runs recorded this session.');
      return 'continue';
    }
    ctx.out.line();
    ctx.out.line(palette.bold('Skill runs'));
    for (const [skillName, entry] of summary) {
      const glyph = getTrustedSkill(skillName)?.glyph ?? '';
      const prefix = glyph ? `${glyph} ` : '';
      const durationStr = `${(entry.totalDurationMs / 1000).toFixed(1)}s total`;
      const runsStr = `${entry.runs} run${entry.runs !== 1 ? 's' : ''}`;
      let claimsStr = '';
      if (entry.totalClaims !== undefined) {
        claimsStr = ` · ${entry.totalClaims} claims`;
        if (entry.totalConfirmed !== undefined) claimsStr += ` · ${entry.totalConfirmed} confirmed`;
        if (entry.totalRefuted !== undefined) claimsStr += ` · ${entry.totalRefuted} refuted`;
        if (entry.totalInconclusive !== undefined) claimsStr += ` · ${entry.totalInconclusive} inconclusive`;
      }
      ctx.out.line(`  ${prefix}${skillName}    ${runsStr}${claimsStr} · ${durationStr}`);
    }
    ctx.out.line();
    return 'continue';
  },
};
