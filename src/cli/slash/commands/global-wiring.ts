/**
 * Wiring for the /global slash command.
 *
 * Builds the real GlobalCommandDeps from production modules:
 *   - relay URL from env.AFK_GLOBAL_CHAT_URL
 *   - FileIdentityStore and FileMuteStore backed by their default paths
 *   - GlobalChatClient wired to the identity store (not the ChatIdentity)
 *   - TTY recording pause/resume from tty-trace
 *
 * Interface note: GlobalCommandDeps.createClient receives
 * { url, identity: ChatIdentity, identityStore: IdentityStore }.
 * GlobalChatClient takes { url, identity: IdentityStore }.
 * The bridge here ignores the ChatIdentity argument and passes identityStore
 * as the client's identity, which is the correct type.
 *
 * hasPendingWork: the three notifiers (bgResultNotifier, peerNotifier,
 * processJobNotifier) are local variables inside the REPL input loop and are
 * not exposed on any module-level setter.  Wiring them here would require
 * restructuring the input loop.  This dep is left undefined; the view handles
 * the missing case gracefully (the pending-work footer line is simply omitted).
 *
 * @module cli/slash/commands/global-wiring
 */

import { env } from '../../../config/env.js';
import { FileIdentityStore } from '../../../global-chat/identity.js';
import { FileMuteStore } from '../../../global-chat/mute-store.js';
import { GlobalChatClient } from '../../../global-chat/client.js';
import { pauseTtyTrace, resumeTtyTrace } from '../../tty-trace.js';
import { createGlobalCommand, type GlobalCommandDeps } from './global.js';
import type { SlashCommand } from '../types.js';

const DEFAULT_RELAY_URL = 'wss://afk-global-chat-relay.griffinwork40.workers.dev/v1/room/global';

function buildDeps(): GlobalCommandDeps {
  return {
    get relayUrl() { return env.AFK_GLOBAL_CHAT_URL ?? DEFAULT_RELAY_URL; },
    createIdentityStore: () => new FileIdentityStore(),
    createMuteStore: () => new FileMuteStore(),
    createClient: ({ url, identityStore }) =>
      new GlobalChatClient({ url, identity: identityStore }),
    pauseRecording: pauseTtyTrace,
    resumeRecording: resumeTtyTrace,
    // hasPendingWork is intentionally omitted: the notifiers live as local
    // variables in the REPL input loop and are not exposed via a module setter.
    // See module docstring above.
  };
}

export const globalCmd: SlashCommand = createGlobalCommand(buildDeps());
