/**
 * Telegram `/inbox` command — list, release, or drop held peer messages for
 * this chat's session.
 *
 * Reuses the peer inbox store (agent/peer/inbox-store) and mirrors the
 * semantics of the REPL `/inbox` slash command without re-implementing the
 * underlying logic.
 *
 * Subcommands:
 *   /inbox                       — list held messages
 *   /inbox release <prefix|all>  — move held → pending (deliver next turn)
 *   /inbox drop <prefix|all>     — permanently delete held envelopes
 *
 * Authority note: peer messages carry NO user authority. This handler never
 * elevates them; it only surfaces metadata (from, age, preview) so the
 * operator can decide whether to release or drop them.
 *
 * @module telegram/handlers/inbox
 */

import type { Context } from 'telegraf';
import {
  listHeld,
  releaseHeld,
  claimPending,
  dropHeld,
  type HeldEntry,
} from '../../agent/peer/inbox-store.js';
import { getPeerInboundModeConfig } from '../../agent/peer/inbound-mode.js';
import type { SessionManager } from '../session-manager.js';
import { routeFromCtx } from '../route.js';
import { escapeHtml, splitLongMessage } from '../formatter.js';

// ---------------------------------------------------------------------------
// Formatting helpers (no chalk — Telegram uses HTML parse_mode)
// ---------------------------------------------------------------------------

/** Format milliseconds as a short human-readable age ("3m", "2h", "1d"). */
function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Truncate text to at most `n` chars, collapsing newlines, appending "…". */
function truncate(text: string, n: number): string {
  const oneLine = text.replace(/\r?\n/g, ' ');
  if (oneLine.length <= n) return oneLine;
  return oneLine.slice(0, n - 1) + '…';
}

/** Strip C0/C1 control characters (except space) for safe display. */
function stripControls(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

// ---------------------------------------------------------------------------
// Sub-command implementations
// ---------------------------------------------------------------------------

async function handleList(ctx: Context, sessionId: string): Promise<void> {
  const held = await listHeld(sessionId);
  const modeCfg = getPeerInboundModeConfig();

  if (held.length === 0) {
    await ctx.reply(
      `📭 No held messages.\n<code>AFK_PEER_INBOUND=${escapeHtml(modeCfg.mode)}</code>`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const now = Date.now();
  const lines: string[] = [`<b>Held peer messages</b> (${held.length}):\n`];

  for (const entry of held) {
    if (entry.corrupt) {
      const fileShort = escapeHtml(stripControls(entry.file).slice(0, 8));
      lines.push(`• <code>${fileShort}</code> — <i>[corrupt — use /inbox drop to remove]</i>`);
      continue;
    }
    const e = entry.envelope;
    const idShort = escapeHtml(e.messageId.slice(0, 8));
    const fromLabel =
      e.from.name !== undefined
        ? `${escapeHtml(truncate(e.from.name, 40))} (${escapeHtml(e.from.id.slice(0, 6))})`
        : escapeHtml(e.from.id.slice(0, 8));
    const age = fmtAge(now - new Date(e.ts).getTime());
    const preview = escapeHtml(truncate(e.body, 60));
    lines.push(`• <code>${idShort}</code> from <b>${fromLabel}</b> [${age}]\n  ${preview}`);
  }

  lines.push(
    `\n<code>AFK_PEER_INBOUND=${escapeHtml(modeCfg.mode)}</code>`,
    `Use <code>/inbox release all</code> or <code>/inbox drop all</code>`,
  );

  if (modeCfg.invalid) {
    lines.push(
      `⚠️ <code>AFK_PEER_INBOUND=${escapeHtml(modeCfg.rawTruncated ?? '')}</code> ` +
      `not recognised; falling back to 'accept'.`,
    );
  }

  const fullText = lines.join('\n');
  for (const chunk of splitLongMessage(fullText)) {
    await ctx.reply(chunk, { parse_mode: 'HTML' });
  }
}

async function handleRelease(
  ctx: Context,
  sessionId: string,
  arg: string,
): Promise<void> {
  const held = await listHeld(sessionId);
  if (held.length === 0) {
    await ctx.reply('📭 No held messages to release.');
    return;
  }

  let targets: HeldEntry[];
  if (arg === '' || arg === 'all') {
    targets = held;
  } else {
    targets = held.filter(
      (h) => !h.corrupt && h.envelope.messageId.startsWith(arg),
    );
    if (targets.length === 0) {
      await ctx.reply(
        `⚠️ No held message id starts with <code>${escapeHtml(arg)}</code>.`,
        { parse_mode: 'HTML' },
      );
      return;
    }
  }

  // Corrupt entries cannot be released (no envelope to re-enqueue).
  const releasable = targets.filter((h) => !h.corrupt);
  if (releasable.length === 0) {
    await ctx.reply(
      '⚠️ All matched messages are corrupt and cannot be released. Use <code>/inbox drop</code>.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Invariant: Telegram sessions lack the REPL's PeerInboxNotifier, so
  // releasing to pending alone would let scanPeerInbox re-hold the message
  // in hold mode. We chain releaseHeld → claimPending (held → pending →
  // delivered) to match the REPL's forceAccept semantics. Messages land in
  // delivered/ which the scan loop never touches.
  //
  // Race note: a concurrent scanPeerInbox may claim the pending file between
  // releaseHeld and claimPending, delivering the message anyway. Count a
  // successful releaseHeld as accepted so the reply is never an undercount.
  let accepted = 0;
  for (const entry of releasable) {
    const released = await releaseHeld(sessionId, entry.file);
    if (!released) {
      console.warn('[inbox] releaseHeld returned false for', entry.file);
      continue;
    }
    accepted++;
    await claimPending(sessionId, entry.file).catch(() => null);
  }

  await ctx.reply(
    `✅ Accepted ${accepted} message${accepted !== 1 ? 's' : ''}. ` +
    `Delivered (bypasses hold mode).`,
  );
}

async function handleDrop(
  ctx: Context,
  sessionId: string,
  arg: string,
): Promise<void> {
  const held = await listHeld(sessionId);
  if (held.length === 0) {
    await ctx.reply('📭 No held messages to drop.');
    return;
  }

  let targets: HeldEntry[];
  if (arg === '' || arg === 'all') {
    targets = held;
  } else {
    // Match parseable by messageId prefix, corrupt by filename prefix.
    targets = held.filter((h) =>
      h.corrupt
        ? h.file.startsWith(arg)
        : h.envelope.messageId.startsWith(arg),
    );
    if (targets.length === 0) {
      await ctx.reply(
        `⚠️ No held message id starts with <code>${escapeHtml(arg)}</code>.`,
        { parse_mode: 'HTML' },
      );
      return;
    }
  }

  let dropped = 0;
  for (const entry of targets) {
    if (await dropHeld(sessionId, entry.file)) dropped++;
  }

  await ctx.reply(`🗑️ Dropped ${dropped} message${dropped !== 1 ? 's' : ''}.`);
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

/**
 * Handle the Telegram `/inbox [release|drop] [<prefix>|all]` command.
 *
 * Authority: peer messages are never elevated to user authority here.
 */
export async function handleInbox(
  ctx: Context,
  sessionManager: SessionManager,
): Promise<void> {
  const route = routeFromCtx(ctx);
  if (!route) {
    await ctx.reply('❌ Could not identify chat.');
    return;
  }

  const sessionId = sessionManager.getSessionId(route);
  if (sessionId === undefined) {
    await ctx.reply(
      '⚠️ No session active yet — send a message first to start a session, ' +
      'then use /inbox to manage held peer messages.',
    );
    return;
  }

  // Parse subcommand from the message text: "/inbox [verb] [arg]"
  const text: string =
    typeof ctx.message === 'object' &&
    ctx.message !== null &&
    'text' in ctx.message &&
    typeof (ctx.message as { text?: unknown }).text === 'string'
      ? (ctx.message as { text: string }).text
      : '';

  // Strip the command token (/inbox or /inbox@botname).
  const afterCmd = text.replace(/^\/inbox(?:@\S+)?/, '').trim();
  const parts = afterCmd === '' ? [] : afterCmd.split(/\s+/);
  const verb = (parts[0] ?? 'list').toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  if (verb === 'list') {
    await handleList(ctx, sessionId);
    return;
  }
  if (verb === 'release') {
    await handleRelease(ctx, sessionId, arg);
    return;
  }
  if (verb === 'drop') {
    await handleDrop(ctx, sessionId, arg);
    return;
  }

  await ctx.reply(
    `⚠️ Unknown subcommand: <code>${escapeHtml(verb)}</code>.\n` +
    `Usage: /inbox · /inbox release &lt;prefix|all&gt; · /inbox drop &lt;prefix|all&gt;`,
    { parse_mode: 'HTML' },
  );
}
