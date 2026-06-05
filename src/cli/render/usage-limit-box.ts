import { displayWidth } from '../display.js';
import { getTerminalWidth } from '../terminal-size.js';
import { palette } from '../palette.js';
import { maxInnerBoxWidth } from './utils.js';
import { drawBox } from './box.js';

// ─── UsageLimitBox ───────────────────────────────────────────────────────────

/**
 * Render a friendly "Usage paused" card for OAuth subscription limits and
 * API credit exhaustion. Uses `palette.warning` (yellow) for the border and
 * chip — distinguishable from the red `errorBox` and from plain info panels.
 *
 * `opts.reason === 'usage-limit'`   — OAuth subscription limit hit.
 * `opts.reason === 'credit-exhausted'` — API key credit balance empty.
 * When `opts.resetsAt` is provided and `reason === 'usage-limit'`, the card
 * shows the human-readable reset time.
 * When `opts.hotSwapped && opts.accountId`, the card appends a "Resumed on"
 * line.
 */
export function usageLimitBox(opts: {
  resetsAt?: Date;
  reason: 'usage-limit' | 'credit-exhausted';
  accountId?: string;
  hotSwapped?: boolean;
  /**
   * When true (the default in stock installs — see
   * `AgentConfig.autoResumeOnUsageLimit`), the provider will auto-wait for the
   * limit to reset (or a keychain hot-swap) and replay the turn. The panel
   * must reflect that so users don't manually retype, then Ctrl+C the
   * auto-replay because they think the session is stuck.
   *
   * When false, the user genuinely needs to send the message again after the
   * limit resets — keep the legacy copy in that case.
   *
   * Defaults to true: if the caller doesn't know, the default-configured
   * behavior (auto-resume) is the safer copy.
   */
  autoResume?: boolean;
}): string {
  const { resetsAt, reason, accountId, hotSwapped } = opts;
  const autoResume = opts.autoResume ?? true;

  // Build body lines based on reason.
  const bodyLines: string[] = [];
  if (reason === 'usage-limit') {
    bodyLines.push("You've hit your Claude subscription limit for now.");
    if (resetsAt !== undefined) {
      const nowMs = Date.now();
      const diffMs = resetsAt.getTime() - nowMs;
      const diffMin = Math.max(0, Math.ceil(diffMs / 60_000));
      const timeStr = resetsAt.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      bodyLines.push('');
      bodyLines.push(`Resets at ${timeStr} (in ~${diffMin} min).`);
    }
    bodyLines.push('');
    if (autoResume) {
      // Mirrors the Telegram surface (src/telegram/streaming.ts) so both
      // channels promise the same behavior.
      bodyLines.push("I'll auto-resume when the limit resets — no need to retype.");
      bodyLines.push('');
      bodyLines.push('Other options:');
      bodyLines.push('  \u2022 Switch to API-key billing: export ANTHROPIC_API_KEY=...');
      bodyLines.push('  \u2022 Log into another account in any terminal: claude login');
    } else {
      bodyLines.push('Options:');
      bodyLines.push('  \u2022 Wait, then send the message again.');
      bodyLines.push('  \u2022 Switch to API-key billing: export ANTHROPIC_API_KEY=...');
      bodyLines.push('  \u2022 Log into another account in any terminal: claude login');
    }
  } else {
    bodyLines.push('Your Anthropic API credit balance is empty.');
    bodyLines.push('');
    bodyLines.push('Top up at:  https://console.anthropic.com/settings/billing');
    bodyLines.push('');
    bodyLines.push('Or switch to your Claude subscription on the server.');
  }

  if (hotSwapped === true && accountId !== undefined) {
    bodyLines.push('');
    bodyLines.push(`Resumed on ${accountId}.`);
  }

  // Inner width: ' Usage paused ' chip / body content + 4-char padding, capped
  // to the terminal width. drawBox re-clamps to maxInnerBoxWidth().
  const chip = ' Usage paused ';
  const maxContentW = bodyLines.reduce((m, l) => Math.max(m, displayWidth(l)), 0);
  const rawInner = Math.max(40, displayWidth(chip), maxContentW) + 4;
  let innerW = Math.min(rawInner, Math.min(getTerminalWidth() - 4, 100));
  innerW = Math.min(innerW, maxInnerBoxWidth());

  // Warning-colored box with a bold ' Usage paused ' chip, routed through the
  // shared drawBox primitive (2-space padding, rectangularity + title-clamp).
  return drawBox(bodyLines, {
    border: palette.warning,
    title: 'Usage paused',
    width: innerW,
    padding: 2,
  });
}
