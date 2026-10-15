/**
 * /peers — list live peer sessions (read-only).
 *
 * Prints name, short id, surface, turnState (via describeTargetState),
 * acceptsMessages (peerInbox), cwd basename, and branch for every live
 * session that is NOT this session. Uses readLivePresenceFiles + the
 * existing describeTargetState helper.
 *
 * @module cli/slash/commands/peers
 */

import { basename } from 'path';
import { palette } from '../../palette.js';
import type { SlashCommand } from '../types.js';
import { readLivePresenceFiles } from '../../../agent/awareness/presence.js';
import { describeTargetState } from '../../../agent/peer/send.js';

export const peersCmd: SlashCommand = {
  name: '/peers',
  usage: '/peers',
  summary: 'List live peer sessions (read-only)',
  hint:
    'Use to discover other afk REPL sessions you can send messages to. ' +
    'Shows name, id, surface, state, peerInbox, cwd, and branch.',
  async handler(ctx, _args) {
    const selfId = ctx.stats.sessionId;
    const records = await readLivePresenceFiles();
    const peers = records.filter((r) => r.sessionId !== selfId);

    if (peers.length === 0) {
      ctx.out.info(
        selfId === undefined
          ? 'No peer sessions found (self id not known yet — run a turn first).'
          : 'No other live sessions found.',
      );
      return 'continue';
    }

    ctx.out.line(
      palette.dim(
        '  name              id        surface  state    inbox  cwd             branch',
      ),
    );

    for (const r of peers) {
      const name = (r.name ?? '').padEnd(16).slice(0, 16);
      const idShort = r.sessionId.slice(0, 8);
      const surface = (r.surface ?? '?').padEnd(7).slice(0, 7);
      const state = describeTargetState(r).padEnd(7);
      const inbox = r.peerInbox === true ? 'yes' : 'no ';
      const cwd = (basename(r.cwd ?? '') || '?').padEnd(14).slice(0, 14);
      const branch = (r.workspace?.branch ?? '?').slice(0, 16);
      ctx.out.line(
        `  ${name}  ${idShort}  ${surface}  ${state}  ${inbox}    ${cwd}  ${branch}`,
      );
    }

    return 'continue';
  },
};
