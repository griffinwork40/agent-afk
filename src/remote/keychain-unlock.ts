/**
 * Automatic remote login-keychain unlock for `remote_agent` (opt-in per host
 * via `"unlockKeychain": true` in hosts.json).
 *
 * Invariant (verified on macOS over SSH, 2026-10-15):
 *   1. An SSH session sees the login keychain LOCKED even while the same user
 *      is logged in at the GUI (`errSecInteractionNotAllowed`, exit 36).
 *   2. Unlock state is per security session: an unlock in one SSH session is
 *      not visible to the next one. So the unlock must run inside the same
 *      launch script that starts afk.
 *   3. A process detached from that session stays unlocked after the SSH
 *      connection closes, so the detached afk run keeps keychain access.
 *
 * Contract: the remote's login password is read from THIS machine's keychain
 * (service {@link UNLOCK_SERVICE}, account = host name), which is unlocked in
 * the operator's GUI session. It travels only as the first stdin line of the
 * launch ssh call, pre-escaped for `security -i`, and is fed to `security -i`
 * through a pipe on the remote: never argv, never a file, never the trace.
 *
 * @module remote/keychain-unlock
 */

import { execFileAsync } from '../utils/exec-file.js';

/** Keychain service under which remote login passwords are stored locally. */
export const UNLOCK_SERVICE = 'afk-remote-unlock';

/** One-time setup command the operator runs on the dispatching machine. */
export function unlockSetupCommand(hostName: string): string {
  return `security add-generic-password -U -s ${UNLOCK_SERVICE} -a ${hostName} -w`;
}

/**
 * Escape a password for a double-quoted argument of a `security -i` command
 * line. Throws on characters that cannot be carried on one stdin line.
 */
export function escapeForSecurityInteractive(password: string): string {
  if (/[\n\r\0]/.test(password)) {
    throw new Error('keychain password contains a newline or NUL; it cannot be sent for automatic unlock');
  }
  return password.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export type ReadUnlockPassword = (hostName: string) => Promise<string>;

/** Read the stored password for `hostName` from the local keychain. */
export const readUnlockPassword: ReadUnlockPassword = async (hostName) => {
  if (process.platform !== 'darwin') {
    throw new Error('unlockKeychain needs a macOS dispatching machine (passwords are read from its keychain)');
  }
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', UNLOCK_SERVICE, '-a', hostName, '-w'],
      { timeout: 15_000 },
    );
    const password = String(stdout).replace(/\n$/, '');
    if (password === '') throw new Error('empty');
    return password;
  } catch {
    throw new Error(
      `no stored keychain password for host "${hostName}". Store it once on this machine with ` +
      `\`${unlockSetupCommand(hostName)}\` (it prompts for the remote login password).`,
    );
  }
};
