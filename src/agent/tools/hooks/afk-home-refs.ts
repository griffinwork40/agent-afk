/**
 * AFK_HOME spelling concern for the bash-restriction hook.
 *
 * Extracted from `bash-restriction-hook.ts` (#782) — a pure move, zero logic
 * change. The bash hook's lexical scan must match AFK_HOME in whatever spelling
 * a command uses (raw env value, `$AFK_HOME`, `~`-normal form), so this module
 * owns the one place AFK_HOME is resolved to a canonical absolute form
 * ({@link configuredAfkHome}) and the relocated sensitive roots / allowlist
 * file forms derived from it. Keeping AFK_HOME resolution here means every
 * downstream consumer shares one spelling and the needle/`includes()` mismatch
 * documented in the host module cannot recur.
 *
 * @module agent/tools/hooks/afk-home-refs
 */

import path from 'path';
import { READ_ALLOWLIST_REL, isReadDenied } from '../handlers/read-denylist.js';
import { getAfkHome } from '../../../paths.js';
import { warnAfkHomeRejectedOnce } from '../afk-home-warn.js';

/**
 * Return AFK_HOME's configured absolute spelling, or nothing when malformed.
 *
 * Invariant: `path.resolve` here — NOT the raw `getAfkHome()` string — is what
 * keeps this spelling and the `path.join`-built needles
 * ({@link relocatedAfkSensitiveRoots}, {@link afkAllowlistFileForms}) in the
 * same normal form. `getAfkHome()` only rejects non-absolute paths and `/`
 * (`src/paths.ts`); it does NOT collapse a trailing separator. With
 * `AFK_HOME=/opt/my-afk/`, substituting the raw string into the command text
 * produced `/opt/my-afk//config/afk.env` (interior `//`), while
 * `path.join(afkHome, 'config')` collapses to `/opt/my-afk/config` — a literal
 * `includes()` between the two then misses, and the command that opens the
 * very file the guard exists to block sails through. Resolving once, here at
 * the source, means every downstream consumer of this function's return value
 * shares one spelling and the mismatch cannot recur.
 */
export function configuredAfkHome(): string | undefined {
  try {
    return path.resolve(getAfkHome());
  } catch (err) {
    warnAfkHomeRejectedOnce(err);
    return undefined;
  }
}

/**
 * The relocated forms of the read-denylist exact-file carve-outs (`~/.afk/...`
 * entries under `READ_ALLOWLIST_REL`), in every spelling a bash command can
 * plausibly use — filtered through {@link isReadDenied} so the precedence
 * contract of `AFK_READ_DENYLIST` is reused rather than re-derived.
 *
 * The absolute form covers a normalized `$AFK_HOME`/`$HOME` command; the
 * `$AFK_HOME/` form covers the env-var spelling the hook leaves alone until
 * `configuredAfkHome()` resolves it. Returns `[]` when AFK_HOME is unset or
 * malformed.
 */
export function afkAllowlistFileForms(afkHome: string): string[] {
  return READ_ALLOWLIST_REL.flatMap((rel) => {
    if (!rel.startsWith('.afk/')) return [];
    const relocated = path.join(afkHome, rel.slice('.afk/'.length));
    if (isReadDenied(relocated).denied) return [];
    return [relocated, `$AFK_HOME/${rel.slice('.afk/'.length)}`];
  });
}

export function relocatedAfkSensitiveRoots(): string[] {
  const afkHome = configuredAfkHome();
  return afkHome === undefined ? [] : [path.join(afkHome, 'config')];
}