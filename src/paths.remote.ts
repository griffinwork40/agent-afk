/**
 * Path helpers for remote agent dispatch (`remote_agent`).
 *
 * Extracted from `src/paths.ts` to keep that file within the 350-code-line
 * ceiling; re-exported from there.
 *
 * @module paths.remote
 */

import { join } from 'path';
import { getAfkConfigDir } from './paths.js';

/**
 * Operator-maintained host registry for `remote_agent`:
 * `$AFK_HOME/config/hosts.json`, a map of host name to `{ ssh, cwd?, afkPath? }`.
 * Optional: a host name absent from the file is used as a literal ssh target.
 */
export function getRemoteHostsPath(): string {
  return join(getAfkConfigDir(), 'hosts.json');
}
