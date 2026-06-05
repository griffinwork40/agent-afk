#!/usr/bin/env tsx
/**
 * Mockup: friendly UX when Claude OAuth subscription usage runs out.
 *
 * Compares the CURRENT scary error path against a PROPOSED friendly
 * usage-limit card. Renders both the CLI (REPL) and the Telegram message
 * variants side-by-side so we can eyeball the new tone before wiring it
 * into the real error pipeline.
 *
 * Usage:
 *   pnpm tsx scripts/mockup-usage-limit.ts
 *
 * Nothing here writes to disk or hits the network — pure render.
 */

import { palette } from '../src/cli/palette.js';
import { errorBox, usageLimitBox } from '../src/cli/render.js';

/* ─── 1. The error the Anthropic SDK actually throws ──────────────────── */
/**
 * When a Claude.ai subscription session exhausts its 5-hour window,
 * `messages.create` rejects with an `Anthropic.APIError`:
 *
 *   status: 429
 *   error.type: 'rate_limit_error'
 *   message: 'Claude AI usage limit reached|1731620400'
 *                                          └── unix-ts reset
 *
 * For API-key billing the equivalent is a 400 with
 *   error.type: 'invalid_request_error'
 *   message: 'Your credit balance is too low to access the Anthropic API...'
 *
 * We fake one of each so the classifier has something to chew on.
 */
function fakeOauthLimitError(): Error {
  const resetTs = Math.floor(Date.now() / 1000) + 47 * 60; // 47 min from now
  const err = new Error(`Claude AI usage limit reached|${resetTs}`);
  (err as unknown as { status: number }).status = 429;
  (err as unknown as { error: { type: string } }).error = { type: 'rate_limit_error' };
  return err;
}

function fakeCreditBalanceError(): Error {
  const err = new Error(
    'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  );
  (err as unknown as { status: number }).status = 400;
  (err as unknown as { error: { type: string } }).error = { type: 'invalid_request_error' };
  return err;
}

/* ─── 2. Classifier ───────────────────────────────────────────────────── */

type UsageLimitKind = 'oauth-subscription' | 'api-credit' | null;

interface UsageLimitInfo {
  kind: Exclude<UsageLimitKind, null>;
  /** Unix seconds when the window resets, when knowable. */
  resetsAt?: number;
}

function classifyUsageLimit(err: unknown): UsageLimitInfo | null {
  if (!(err instanceof Error)) return null;
  const status = (err as unknown as { status?: number }).status;
  const apiType = (err as unknown as { error?: { type?: string } }).error?.type;
  const msg = err.message ?? '';

  // OAuth subscription window exhausted.
  // Format: "Claude AI usage limit reached|<unix-seconds>"
  if (status === 429 && /Claude AI usage limit reached/i.test(msg)) {
    const m = msg.match(/\|(\d{9,11})/);
    const resetsAt = m && m[1] ? Number(m[1]) : undefined;
    return { kind: 'oauth-subscription', ...(resetsAt ? { resetsAt } : {}) };
  }

  // API-key credit balance depleted.
  if (
    (status === 400 || status === 402) &&
    apiType === 'invalid_request_error' &&
    /credit balance/i.test(msg)
  ) {
    return { kind: 'api-credit' };
  }

  return null;
}

/* ─── 3. Friendly renderers ───────────────────────────────────────────── */

/**
 * Convert the mockup's internal UsageLimitInfo to the render.ts usageLimitBox
 * options shape. The real implementation is imported from render.ts above.
 */
function usageLimitBoxFromInfo(info: UsageLimitInfo): string {
  if (info.kind === 'oauth-subscription') {
    return usageLimitBox({
      reason: 'usage-limit',
      ...(info.resetsAt !== undefined ? { resetsAt: new Date(info.resetsAt * 1000) } : {}),
    });
  }
  return usageLimitBox({ reason: 'credit-exhausted' });
}

function formatResetTime(resetsAt: number): { absolute: string; relative: string } {
  const date = new Date(resetsAt * 1000);
  const absolute = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const mins = Math.max(1, Math.round((resetsAt * 1000 - Date.now()) / 60_000));
  const relative =
    mins < 60 ? `in ${mins} min` : `in ${Math.round(mins / 60)}h ${mins % 60}m`;
  return { absolute, relative };
}

/* ─── 4. Telegram variant (HTML, no scary stack trace) ────────────────── */

function telegramUsageLimit(info: UsageLimitInfo): string {
  if (info.kind === 'oauth-subscription') {
    const when = info.resetsAt
      ? (() => {
          const { absolute, relative } = formatResetTime(info.resetsAt);
          return `Resets at <b>${absolute}</b> (${relative}).`;
        })()
      : 'Your 5-hour window will reset shortly.';
    return [
      '⏸️ <b>Usage paused</b>',
      '',
      "You've hit your Claude subscription limit for now.",
      when,
      '',
      'You can:',
      '• Wait for the reset, then send the message again',
      '• Set <code>ANTHROPIC_API_KEY</code> on the server to fall back to API-key billing',
    ].join('\n');
  }
  return [
    '⏸️ <b>API credit empty</b>',
    '',
    'Your Anthropic API credit balance ran out.',
    '',
    'Top up: https://console.anthropic.com/settings/billing',
    'Or switch to your Claude subscription on the server.',
  ].join('\n');
}

/* ─── 5. Side-by-side preview ─────────────────────────────────────────── */

const HR = palette.dim('─'.repeat(72));
const H = (s: string) => palette.heading(s);

function previewCli(err: Error, label: string): void {
  console.log(H(`CLI — ${label}`));
  console.log(HR);

  console.log(palette.bold('Before:'));
  console.log(errorBox(err.message, err.stack?.split('\n').slice(0, 3).join('\n')));
  console.log();

  const info = classifyUsageLimit(err);
  console.log(palette.bold('After:'));
  if (info) {
    console.log(usageLimitBoxFromInfo(info));
  } else {
    console.log(palette.dim('(classifier did not match — would fall through to errorBox)'));
  }
  console.log();
}

function previewTelegram(err: Error, label: string): void {
  console.log(H(`Telegram — ${label}`));
  console.log(HR);

  console.log(palette.bold('Before:'));
  console.log(palette.dim('  ❌ Error: ') + err.message);
  console.log();

  const info = classifyUsageLimit(err);
  console.log(palette.bold('After:'));
  if (info) {
    // strip HTML for terminal preview
    const tg = telegramUsageLimit(info).replace(/<[^>]+>/g, '');
    for (const line of tg.split('\n')) console.log('  ' + line);
  } else {
    console.log(palette.dim('  (falls through to formatError)'));
  }
  console.log();
}

const cases: Array<[string, Error]> = [
  ['Claude subscription window exhausted (OAuth)', fakeOauthLimitError()],
  ['API-key credit balance depleted', fakeCreditBalanceError()],
];

console.log();
console.log(palette.brand(palette.bold('  agent-afk · usage-limit UX mockup')));
console.log();

for (const [label, err] of cases) {
  previewCli(err, label);
  previewTelegram(err, label);
  console.log();
}

/* ─── 6. Auto-resume UX preview ──────────────────────────────────────── */

function statusLine(text: string, glyph = '⏳'): string {
  return palette.warning(glyph) + '  ' + palette.dim(text);
}

console.log(H('Auto-resume — REPL timeline (compressed)'));
console.log(HR);
console.log(palette.user('you ') + palette.dim('› ') + 'help me refactor the auth module');
console.log();
console.log(usageLimitBox({ reason: 'usage-limit', resetsAt: new Date((Math.floor(Date.now() / 1000) + 47 * 60) * 1000) }));
console.log();
console.log(statusLine('Paused. Will resume at 12:16 AM (47 min). Ctrl-C to cancel.', '⏸'));
console.log(statusLine('  …waiting (46 min remaining)', '·'));
console.log(statusLine('  …waiting (30 min remaining)', '·'));
console.log(statusLine('  …waiting (15 min remaining)', '·'));
console.log();
console.log(palette.success('▶') + '  ' + palette.dim('Quota reset. Resuming your last message…'));
console.log(palette.tool('● ') + palette.tool('Read') + palette.toolArg(' (src/auth.ts)'));
console.log(palette.dim('  ...turn continues...'));
console.log();

console.log(H('Auto-resume — account hot-swap (you re-login in another terminal)'));
console.log(HR);
console.log(statusLine('Paused. Will resume at 12:16 AM (47 min). Ctrl-C to cancel.', '⏸'));
console.log(statusLine('  …waiting (46 min remaining)', '·'));
console.log(
  palette.info('ℹ') +
    '  ' +
    palette.dim("Detected new Claude account in keychain (logged in as ") +
    palette.warning('user@example.com') +
    palette.dim('). Resuming early.'),
);
console.log(palette.success('▶') + '  ' + palette.dim('Resuming your last message…'));
console.log(palette.dim('  ...turn continues on the new account...'));
console.log();

console.log(H('Auto-resume — Telegram timeline'));
console.log(HR);
console.log(palette.dim('  [12:00 AM]  ⏸️ Usage paused'));
console.log(palette.dim('              Will resume at 12:16 AM (in 47 min).'));
console.log(palette.dim('              I\'ll pick up where we left off — no need to retype.'));
console.log(palette.dim('  [12:16 AM]  ▶️ Resumed. Working on your last message…'));
console.log(palette.dim('  [12:18 AM]  <assistant streams response>'));
console.log();
console.log(palette.dim('              (or, if you re-login mid-wait:)'));
console.log(palette.dim('  [12:04 AM]  ℹ️ New Claude account detected. Resuming early.'));
console.log();

console.log(palette.dim('Wire-up sketch:'));
console.log(palette.dim('  1. Classifier in error-utils — extract { kind, resetsAt } from the SDK error.'));
console.log(
  palette.dim(
    '  2. Generalize turnWithAuthRetry → turnWithRecoveryRetry in anthropic-direct/query.ts:',
  ),
);
console.log(palette.dim('       - 401 path: refresh token, replay (existing).'));
console.log(palette.dim('       - 429-usage-limit path:'));
console.log(palette.dim('           a) emit { type: \'status\', kind: \'usage-paused\', resetsAt }'));
console.log(palette.dim('           b) await raceUntil(resetsAt + 30s, keychainChanged())'));
console.log(palette.dim('           c) on wake: loadClaudeCodeOauthToken(), swap client, replay turn'));
console.log(palette.dim('           d) honor abort signal — Ctrl-C cancels the wait cleanly'));
console.log(palette.dim('  3. New ProviderEvent: { type: \'paused\', reason, resumesAt } — UI listens.'));
console.log(
  palette.dim('  4. CLI turn-handler: render usageLimitBox once + live "minutes remaining" line.'),
);
console.log(palette.dim('  5. Telegram streaming.ts: send paused message + edit it to "Resumed" on wake.'));
console.log(palette.dim('  6. Config gate: afk.config.json → autoResumeOnUsageLimit (default: true).'));
console.log();
