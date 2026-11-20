/**
 * Path helpers for global-chat client state.
 *
 * Extracted into a sibling module to keep `src/paths.ts` within the 350-code-line
 * ceiling. All paths derive from `getAfkStateDir()`.
 *
 * @module paths.global-chat
 */

import { join } from 'node:path';
import { getAfkStateDir } from './paths.js';

/**
 * Path to the global-chat identity file.
 *
 * Stores the user's display name, public key, PKCS8-encoded private key
 * (hex), tag, notice-acceptance version, and name-change timestamp.
 * Written with mode 0600 (atomicWriteFile default) so the private key
 * is not readable by other OS users. Directory is created with mode 0700.
 */
export function getGlobalChatIdentityPath(): string {
  return join(getAfkStateDir(), 'global-chat', 'identity.json');
}

/**
 * Path to the global-chat local mute list.
 *
 * JSON array of `{ pubkey, name }` objects. Corrupt reads produce an empty
 * list; the file is not overwritten until the next successful mutation.
 */
export function getGlobalChatMutesPath(): string {
  return join(getAfkStateDir(), 'global-chat', 'mutes.json');
}
