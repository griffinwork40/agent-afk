import type { FastModeInactiveReason } from '../../../agent/fast-mode.js';
import type { SlashCommand } from '../types.js';

const REASONS: Record<FastModeInactiveReason, string> = {
  'preference-off': 'preference is off',
  'unsupported-provider': 'the current provider does not support fast mode (Anthropic or OpenAI only)',
  'custom-endpoint': 'custom or local endpoints are excluded',
  'excluded-execution-path': 'this execution path is excluded (fast mode applies to the main session only)',
  'unsupported-model': 'the current model does not support fast mode (Anthropic: Opus 5 or 4.8; OpenAI: models offering the priority tier, e.g. gpt-5.5, gpt-5.6, gpt-6)',
};

export const fastCmd: SlashCommand = {
  name: '/fast', usage: '/fast [on|off]', flags: ['on', 'off'],
  summary: 'Toggle fast mode for the session (Anthropic Opus fast, OpenAI priority tier)',
  async handler(ctx, args) {
    const controller = ctx.fastMode;
    if (!controller) { ctx.out.warn('Fast mode is unavailable on this surface.'); return 'continue'; }
    const value = args.trim().toLowerCase();
    if (value && value !== 'on' && value !== 'off') { ctx.out.warn('Usage: /fast [on|off]'); return 'continue'; }
    if (value === 'on' || value === 'off') {
      controller.setPreference(value);
      ctx.out.success(`Fast mode preference set to ${value}. Takes effect on the next turn.`);
      return 'continue';
    }
    const status = controller.resolveStatus(ctx.getFastModeContext?.() ?? {
      resolvedModelId: String(ctx.stats.model), providerFamily: 'unknown', hasCustomEndpoint: false, executionPath: 'top-level',
    });
    if (status.preference === 'off') ctx.out.info('Fast mode preference: off.');
    else if (status.effective) ctx.out.info('Fast mode: active.');
    else ctx.out.info(`Fast mode preference: on, but inactive because ${REASONS[status.reason!]}.`);
    return 'continue';
  },
};
