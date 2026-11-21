/**
 * /global: open the public global chat room, or manage it.
 *
 *   /global              open the room (first run shows the notice and name screens)
 *   /global name <name>  set or change the display name
 *   /global status       local state only, no network call
 *   /global off          clear consent; the identity is kept
 *
 * Contract: arguments are never treated as a chat message. Nothing the view
 * shows goes through `ctx.out`; only the subcommands' short status lines do.
 * Not registered in `slash/index.ts` yet; the integrator wires real deps.
 *
 * @module cli/slash/commands/global
 */

import type { SlashCommand, SlashContext } from '../types.js';
import type { ChatClient, ChatIdentity, IdentityStore, MuteStore } from '../../../global-chat/client-types.js';
import { NOTICE_VERSION } from '../../../global-chat/client-types.js';
import { formatDisplayName } from '../../../global-chat/names.js';
import { validateChatUrl } from '../../../global-chat/client.transport.js';
import { runGlobalChatView, realClock, type ChatClock } from '../../commands/interactive/global-chat-view.js';
import { explainIdentityFailure } from '../../commands/interactive/global-chat-messages.js';
import type { ChatCompositor, ChatStdin, ChatStdout } from '../../commands/interactive/global-chat-terminal.js';

export interface GlobalCommandDeps {
  /** `AFK_GLOBAL_CHAT_URL`, or undefined when no relay is configured. */
  relayUrl: string | undefined;
  createIdentityStore: () => IdentityStore;
  createMuteStore: () => MuteStore;
  createClient: (opts: { url: string; identity: ChatIdentity; identityStore: IdentityStore }) => ChatClient;
  pauseRecording: () => void;
  resumeRecording: () => void;
  /** Optional: true when background results or peer messages are waiting for the agent. */
  hasPendingWork?: () => boolean;
  /** Test seam; defaults to the real process TTY flags. */
  isInteractiveTerminal?: () => boolean;
  clock?: ChatClock;
}

/** The compositor surface the view needs, plus the armed check. */
interface LiveCompositor extends ChatCompositor {
  readonly stdin: ChatStdin;
  readonly stdout: ChatStdout;
  isArmed(): boolean;
}

const USAGE = 'Usage: /global | /global name <name> | /global status | /global off';
const NO_RELAY = 'Global chat has no relay configured. Point it at one with AFK_GLOBAL_CHAT_URL.';
const NOT_TTY = '/global needs the interactive terminal REPL.';

function defaultIsTty(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * The registry skips capability checks for contexts that carry none, so this
 * handler verifies the real terminal and a live, armed compositor itself.
 */
function liveCompositor(ctx: SlashContext, deps: GlobalCommandDeps): LiveCompositor | null {
  if (ctx.capabilities && !ctx.capabilities.has('tty')) return null;
  if (!(deps.isInteractiveTerminal ?? defaultIsTty)()) return null;
  const compositor = ctx.getCompositor?.() as LiveCompositor | null | undefined;
  if (!compositor || typeof compositor.isArmed !== 'function' || !compositor.isArmed()) return null;
  return compositor;
}

function display(identity: ChatIdentity): string {
  try { return formatDisplayName(identity.name, identity.tag); } catch { return `${identity.name}#${identity.tag}`; }
}

async function openRoom(ctx: SlashContext, deps: GlobalCommandDeps, compositor: LiveCompositor): Promise<void> {
  const url = deps.relayUrl;
  if (!url) { ctx.out.info(NO_RELAY); return; }
  let relayHost: string;
  try { relayHost = new URL(validateChatUrl(url)).host; }
  catch { ctx.out.error('AFK_GLOBAL_CHAT_URL is invalid. Use wss://<host>/v1/room/global, or ws:// only on localhost.'); return; }
  const identityStore = deps.createIdentityStore();
  // Periodic footer writers would paint into the alternate screen.
  ctx.suspendFooter?.();
  try {
    await runGlobalChatView({
      compositor, stdin: compositor.stdin, stdout: compositor.stdout, relayHost,
      createClient: (identity) => deps.createClient({ url, identity, identityStore }),
      identity: identityStore, mutes: deps.createMuteStore(), clock: deps.clock ?? realClock,
      pauseRecording: deps.pauseRecording, resumeRecording: deps.resumeRecording,
      ...(deps.hasPendingWork ? { hasPendingWork: deps.hasPendingWork } : {}),
    });
  } catch {
    ctx.out.error('Global chat could not start (could not read its local state).');
  } finally {
    ctx.resumeFooter?.();
  }
}

async function setName(ctx: SlashContext, store: IdentityStore, name: string): Promise<void> {
  if (!name || /\s/.test(name)) { ctx.out.warn('Usage: /global name <name>'); return; }
  const existing = await store.load();
  if (!existing) { ctx.out.info('No chat identity yet. Run /global to set one up.'); return; }
  const result = await store.rename(name);
  if (result.ok) ctx.out.success(`Display name ${display(result.identity)} is saved and will be used the next time you join.`);
  else ctx.out.warn(explainIdentityFailure(result));
}

async function status(ctx: SlashContext, deps: GlobalCommandDeps, store: IdentityStore): Promise<void> {
  const enabled = await store.isNoticeAccepted(NOTICE_VERSION);
  const identity = await store.load();
  ctx.out.info(`Global chat: ${enabled ? 'enabled' : 'off'}`);
  ctx.out.info(`Identity: ${identity ? display(identity) : 'none yet'}`);
  ctx.out.info(`Relay: ${deps.relayUrl ? 'configured' : 'not configured (set AFK_GLOBAL_CHAT_URL)'}`);
}

export function createGlobalCommand(deps: GlobalCommandDeps): SlashCommand {
  return {
    name: '/global',
    requires: ['tty'],
    summary: 'Open public chat when a relay is configured',
    usage: '/global [name <name> | status | off]',
    async handler(ctx, args) {
      const compositor = liveCompositor(ctx, deps);
      if (!compositor) { ctx.out.warn(NOT_TTY); return 'continue'; }
      const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (sub === '') await openRoom(ctx, deps, compositor);
        else if (sub === 'name') await setName(ctx, deps.createIdentityStore(), rest.length === 1 ? rest[0] ?? '' : '');
        else if (sub === 'status' && rest.length === 0) await status(ctx, deps, deps.createIdentityStore());
        else if (sub === 'off' && rest.length === 0) {
          await deps.createIdentityStore().disable();
          ctx.out.info('Global chat is off. Your identity is kept; /global will show the notice again.');
        } else ctx.out.warn(USAGE);
      } catch {
        ctx.out.error('Global chat state could not be read or written.');
      }
      return 'continue';
    },
  };
}
