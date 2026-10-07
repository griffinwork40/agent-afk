/**
 * /inbox — list, accept, or drop held peer messages for this session.
 *
 * Subcommands:
 *
 *   /inbox              — list held messages (from, id, age, preview); note mode
 *   /inbox accept <prefix|all> — move held → pending → buffer via forceAccept
 *   /inbox drop   <prefix|all> — permanently delete held envelopes
 *
 * Requires `ctx.peerNotifier` wired via `setPeerNotifier` (the module-scope
 * singleton pattern used by `/sh` for `ShellPassthrough`). Before the first
 * turn (no session id yet) a clear "no session yet" message is shown.
 *
 * @module cli/slash/commands/inbox
 */

import { palette } from '../../palette.js';
import type { SlashCommand } from '../types.js';
import type { PeerInboxNotifier } from '../../commands/interactive/peer-inbox-notifier.js';
import { listHeld, dropHeld, type HeldEntry } from '../../../agent/peer/inbox-store.js';
import { getPeerInboundModeConfig } from '../../../agent/peer/inbound-mode.js';

let notifierRef: PeerInboxNotifier | undefined;
let sessionIdGetter: (() => string | undefined) | undefined;

/**
 * Wire the peer inbox notifier and session-id getter from
 * `setupFooterSubsystems`. Mirrors the `setShellPassthrough` singleton pattern
 * used by `/sh`. Must be called before any `/inbox` handler fires.
 */
export function setPeerNotifier(
  notifier: PeerInboxNotifier,
  getSessionId: () => string | undefined,
): void {
  notifierRef = notifier;
  sessionIdGetter = getSessionId;
}

/** Format milliseconds as a short human-readable age ("3m", "2h", "1d"). */
function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Truncate text to at most `n` chars, appending "…" if truncated. */
function truncate(text: string, n: number): string {
  const oneLine = text.replace(/\r?\n/g, ' ');
  if (oneLine.length <= n) return oneLine;
  return oneLine.slice(0, n - 1) + '…';
}

/** Strip C0/C1 control characters (except space) from a string for safe display. */
function stripControls(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

export const inboxCmd: SlashCommand = {
  name: '/inbox',
  usage: '/inbox [accept <id-prefix|all> | drop <id-prefix|all>]',
  summary: 'List, accept, or drop held peer messages',
  hint:
    'Use when AFK_PEER_INBOUND=hold: /inbox to list, /inbox accept <prefix|all> ' +
    'to deliver on the next turn, /inbox drop <prefix|all> to discard.',
  async handler(ctx, args) {
    if (!notifierRef || !sessionIdGetter) {
      ctx.out.error('Peer inbox not available in this session.');
      return 'continue';
    }

    const sessionId = sessionIdGetter();
    if (sessionId === undefined) {
      ctx.out.warn(
        'No session id yet — peer inbox is not active before the first turn.',
      );
      return 'continue';
    }

    const trimmed = args.trim();
    const [verb, ...rest] = trimmed === '' ? ['list'] : trimmed.split(/\s+/);
    const arg = rest.join(' ').trim();

    const modeCfg = getPeerInboundModeConfig();

    if (verb === 'list' || verb === undefined) {
      const held = await listHeld(sessionId);
      if (held.length === 0) {
        ctx.out.info('No held messages.');
      } else {
        ctx.out.line(palette.dim('  id        from                  age   preview'));
        const now = Date.now();
        for (const entry of held) {
          if (entry.corrupt) {
            // Show unparseable held files so the operator can drop them.
            const fileShort = stripControls(entry.file).slice(0, 8);
            ctx.out.line(
              `  ${fileShort}  ${'[corrupt]'.padEnd(20)}  ${'?'.padEnd(4)}  ` +
              palette.dim('(unparseable — use /inbox drop to remove)'),
            );
            continue;
          }
          const e = entry.envelope;
          const idShort = e.messageId.slice(0, 8);
          const fromLabel =
            e.from.name !== undefined
              ? `${e.from.name}(${e.from.id.slice(0, 6)})`
              : e.from.id.slice(0, 8);
          const age = fmtAge(now - new Date(e.ts).getTime());
          const preview = truncate(e.body, 80);
          ctx.out.line(
            `  ${idShort}  ${fromLabel.padEnd(20)}  ${age.padEnd(4)}  ${palette.dim(preview)}`,
          );
        }
      }
      ctx.out.line(palette.dim(`  mode: AFK_PEER_INBOUND=${modeCfg.mode}`));
      if (modeCfg.invalid) {
        // Surface the typo in a TUI-safe warning so the operator notices without
        // needing AFK_DEBUG=1. The raw value is already capped (≤20 chars + "…")
        // by getPeerInboundModeConfig to prevent display corruption.
        ctx.out.warn(
          `AFK_PEER_INBOUND=${JSON.stringify(modeCfg.rawTruncated)} is not recognised ` +
          `(expected 'accept', 'hold', or 'off'); falling back to 'accept'.`,
        );
      }
      return 'continue';
    }

    if (verb === 'accept') {
      const held = await listHeld(sessionId);
      if (held.length === 0) {
        ctx.out.info('No held messages to accept.');
        return 'continue';
      }

      let ids: ReadonlySet<string> | 'all';
      if (arg === '' || arg === 'all') {
        ids = 'all';
      } else {
        // Match the prefix against held message ids. Corrupt entries have no
        // messageId and cannot be accepted; they can only be dropped.
        const matched = held
          .filter((h): h is Extract<HeldEntry, { corrupt?: never }> => !h.corrupt)
          .filter(({ envelope: e }) => e.messageId.startsWith(arg))
          .map(({ envelope: e }) => e.messageId);
        if (matched.length === 0) {
          ctx.out.warn(`No held message id starts with "${arg}".`);
          return 'continue';
        }
        ids = new Set(matched);
      }

      // When every held entry is corrupt, forceAccept skips all of them and
      // returns 0 — which would show the generic "may have already been claimed"
      // warning. Detect this case early and give the operator a clearer message.
      if (ids === 'all' && held.every((h) => h.corrupt)) {
        ctx.out.warn('All held messages are corrupt and cannot be accepted. Use /inbox drop to remove them.');
        return 'continue';
      }

      const count = await notifierRef.forceAccept(ids);
      if (count === 0) {
        ctx.out.warn('No messages were accepted (may have already been claimed).');
      } else {
        ctx.out.success(
          `Accepted ${count} message${count !== 1 ? 's' : ''}. ` +
          'Will be delivered on the next turn ' +
          palette.dim('(an idle prompt wakes automatically)'),
        );
      }
      return 'continue';
    }

    if (verb === 'drop') {
      const held = await listHeld(sessionId);
      if (held.length === 0) {
        ctx.out.info('No held messages to drop.');
        return 'continue';
      }

      let targets: Array<{ file: string; id: string }>;
      if (arg === '' || arg === 'all') {
        // Corrupt entries have no messageId; use the filename as a fallback id
        // so the operator can still drop them with /inbox drop all.
        targets = held.map((h) => ({
          file: h.file,
          id: h.corrupt ? `[corrupt:${h.file}]` : h.envelope.messageId,
        }));
      } else {
        // Match parseable entries by messageId prefix, and corrupt entries by
        // filename prefix so the operator can drop individual corrupt files
        // without resorting to "drop all".
        const parseableMatches = held
          .filter((h): h is Extract<HeldEntry, { corrupt?: never }> => !h.corrupt)
          .filter(({ envelope: e }) => e.messageId.startsWith(arg))
          .map(({ file, envelope: e }) => ({ file, id: e.messageId }));
        const corruptMatches = held
          .filter((h): h is Extract<HeldEntry, { corrupt: true }> => !!h.corrupt)
          .filter((h) => h.file.startsWith(arg))
          .map((h) => ({ file: h.file, id: `[corrupt:${h.file}]` }));
        targets = [...parseableMatches, ...corruptMatches];
        if (targets.length === 0) {
          ctx.out.warn(`No held message id starts with "${arg}".`);
          return 'continue';
        }
      }

      let dropped = 0;
      for (const { file } of targets) {
        if (await dropHeld(sessionId, file)) dropped++;
      }
      ctx.out.success(`Dropped ${dropped} message${dropped !== 1 ? 's' : ''}.`);
      return 'continue';
    }

    ctx.out.warn(
      `Unknown subcommand: ${verb}. Try /inbox, /inbox accept <prefix|all>, or /inbox drop <prefix|all>.`,
    );
    return 'continue';
  },
};
