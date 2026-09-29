/**
 * Lexical spellings of a restricted root, for the bash-restriction scan on
 * Windows.
 *
 * Invariant: the scanned command and every needle must share ONE separator
 * form, because the final match is a literal (optionally case-folded)
 * `includes()`. `normalizeHomeRefs` rewrites every `\` in the scanned command
 * to `/`, but the needles come from `path.join` / `safeRealpath`, which emit
 * win32 backslash paths (`C:\Users\alice\.ssh`). A backslash needle can
 * therefore NEVER match, and before this module the whole bash credential
 * floor failed OPEN on Windows (`cat ~/.ssh/id_rsa`, `cat $HOME/.aws/...`,
 * and the literal `cat C:\Users\alice\.ssh\id_rsa` all passed; #703).
 *
 * For a drive-qualified root this returns, all forward-slash:
 *   - the root itself (`C:/Users/alice/.ssh`);
 *   - the Git Bash / MSYS spelling (`/c/Users/alice/.ssh`), which is what
 *     `$HOME` and `~` expand to inside Git Bash and what a model working in
 *     that shell naturally types;
 *   - both home-prefix spellings when the root sits under the home dir: the
 *     raw `os.homedir()` form (what `~` / `$HOME` are substituted with) and its
 *     `safeRealpath` form (what the read denylist is keyed to). They differ
 *     when USERPROFILE is an 8.3 short path (`C:\Users\ALICE~1`).
 *
 * Contract: a root that is NOT drive-qualified is returned unchanged as the
 * sole spelling, so POSIX hosts (whose roots are always `/`-rooted) see
 * byte-identical behaviour. This is also why the gate is the root's SHAPE, not
 * `process.platform`: the win32-semantics tests exercise it on any host.
 *
 * @module agent/tools/hooks/bash-restriction-hook.win32-spellings
 */

import { safeRealpath } from '../handlers/write-denylist.js';

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** Whether `p` is a drive-qualified win32 path (`C:\…` or `C:/…`). */
export function isDrivePath(p: string): boolean {
  return DRIVE_PATH.test(p);
}

function toForward(p: string): string {
  return p.replace(/\\/g, '/');
}

/** `C:/Users/x` → `/c/Users/x` (Git Bash / MSYS mount spelling). */
function msysForm(fwd: string): string {
  return `/${fwd.charAt(0).toLowerCase()}${fwd.slice(2)}`;
}

/** Swap a leading `from` home prefix for `to` (case-insensitive, as NTFS is). */
function swapHomePrefix(fwd: string, from: string, to: string): string | undefined {
  if (from === to || from === '') return undefined;
  const lower = fwd.toLowerCase();
  const prefix = from.toLowerCase();
  if (lower !== prefix && !lower.startsWith(`${prefix}/`)) return undefined;
  return to + fwd.slice(from.length);
}

let canonHomeCache: { raw: string; canon: string } | undefined;

/** `safeRealpath(rawHome)` in forward-slash form, memoized per raw home. */
function canonicalHomeForward(rawHome: string): string {
  if (canonHomeCache?.raw !== rawHome) {
    canonHomeCache = { raw: rawHome, canon: toForward(safeRealpath(rawHome)).replace(/\/+$/, '') };
  }
  return canonHomeCache.canon;
}

/**
 * The drive-qualified spellings of `root` that name the SAME directory: the
 * root in forward-slash form plus its raw-home / realpath-home alias (the two
 * differ under an 8.3 USERPROFILE). No MSYS `/c/...` form — callers that feed
 * these to `path.win32.relative` (the grant filter) must not see a
 * drive-relative spelling it would resolve against the current drive.
 * Non-drive roots are returned unchanged (POSIX no-op).
 */
export function homeAliasSpellings(root: string, rawHome: string): string[] {
  if (!isDrivePath(root)) return [root];
  const fwd = toForward(root);
  const out = new Set<string>([fwd]);
  if (isDrivePath(rawHome)) {
    const raw = toForward(rawHome).replace(/\/+$/, '');
    const canon = canonicalHomeForward(rawHome);
    const swappedToRaw = swapHomePrefix(fwd, canon, raw);
    const swappedToCanon = swapHomePrefix(fwd, raw, canon);
    if (swappedToRaw !== undefined) out.add(swappedToRaw);
    if (swappedToCanon !== undefined) out.add(swappedToCanon);
  }
  return [...out];
}

/**
 * Every lexical spelling of `root` the scan must look for: the
 * {@link homeAliasSpellings} plus each one's Git Bash `/c/...` twin. See the
 * module header for the invariant and the POSIX no-op contract.
 */
export function restrictedRootSpellings(root: string, rawHome: string): string[] {
  if (!isDrivePath(root)) return [root];
  const aliases = homeAliasSpellings(root, rawHome);
  return [...new Set([...aliases, ...aliases.map(msysForm)])];
}

/** Test-only: forget the memoized canonical home. */
export function _resetWin32SpellingsCacheForTests(): void {
  canonHomeCache = undefined;
}
