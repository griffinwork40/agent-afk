/**
 * Path helpers for the global-chat client files.
 *
 * Extracted into a sibling module to keep `src/paths.ts` within the 350-code-line
 * ceiling. All paths derive from `getAfkConfigDir()` (`<AFK_HOME>/config`).
 *
 * Invariant: these files live in the CONFIG dir, never the state dir. The
 * identity file holds an Ed25519 private key, and the config dir is denied
 * wholesale by the agent's read floor (`BUILTIN_READ_DENYLIST` plus the
 * derived relocated-`AFK_HOME` entry in `read-denylist.ts`), the write floor,
 * and the shell guard's `SENSITIVE_PATH_SIGNAL`. The state dir is deliberately
 * grantable to subagents as a read root, so nothing secret may live there.
 *
 * @module paths.global-chat
 */

import { join } from 'node:path';
import { getAfkConfigDir } from './paths.js';

/**
 * Root directory for global-chat client files: `<config>/global-chat/`.
 * Created with mode 0700 by the stores that write into it.
 */
export function getGlobalChatDir(): string {
  return join(getAfkConfigDir(), 'global-chat');
}

/**
 * Path to the global-chat identity file.
 *
 * Stores the user's display name, public key, PKCS8-encoded private key
 * (hex), tag, notice-acceptance version, and name-change timestamp.
 * Written with mode 0600 (atomicWriteFile default) so the private key
 * is not readable by other OS users. Directory is created with mode 0700.
 */
export function getGlobalChatIdentityPath(): string {
  return join(getGlobalChatDir(), 'identity.json');
}

/**
 * Path to the global-chat local mute list.
 *
 * JSON array of `{ pubkey, name }` objects. Corrupt reads produce an empty
 * list; the file is not overwritten until the next successful mutation.
 */
export function getGlobalChatMutesPath(): string {
  return join(getGlobalChatDir(), 'mutes.json');
}
