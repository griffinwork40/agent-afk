/**
 * Path helpers for the peer-messaging inbox layer.
 *
 * Extracted from `src/paths.ts` to keep that file within the 350-code-line
 * ceiling. All peer inbox paths derive from `getAfkStateDir()`.
 *
 * Shape: `$AFK_STATE_DIR/inbox/<sessionId>/{pending,delivered,held}/`
 *
 * @module paths.peer
 */

import { join } from 'path';
import { getAfkStateDir } from './paths.js';

/**
 * Root directory containing one sub-directory per session inbox.
 *
 * Sessions write incoming envelopes under the target's sub-directory; the
 * receiver loop drains `pending/` and moves items to `delivered/` or `held/`.
 */
export function getPeerInboxRoot(): string {
  return join(getAfkStateDir(), 'inbox');
}

/**
 * Inbox directory for a specific session.
 *
 * Validates `sessionId` to reject path separators and `..` traversal
 * before joining. Throws if the id contains `/`, `\`, or the literal `..`
 * component.
 *
 * Contract: callers MUST supply the session's canonical id (as recorded in
 * its presence file), never a user-supplied string that has not been resolved
 * through the presence layer first.
 */
export function getPeerInboxDir(sessionId: string): string {
  if (
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId === '..' ||
    sessionId.includes('..')
  ) {
    throw new Error(`Invalid sessionId for inbox path: "${sessionId}"`);
  }
  return join(getPeerInboxRoot(), sessionId);
}
