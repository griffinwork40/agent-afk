/**
 * SSH public-key spelling scrub for the bash-restriction hook — the bash-side
 * twin of the typed read denylist's `*.pub` pattern carve-out
 * (`SSH_PUBKEY_SUFFIX`, read-denylist.ts).
 *
 * Invariant: this runs ONLY under the read-only gate
 * (`bash-restriction-hook.readonly-gate.ts`), exactly like the exact-file
 * scrub. A non-read-only command that names `~/.ssh/x.pub` is scanned
 * unscrubbed, so the enclosing `~/.ssh` root still blocks it — the carve-out is
 * a READ grant, never a write grant.
 *
 * Contract: a spelling is blanked only when ALL of these hold:
 *   - it is `<ssh-root>/<name>.pub` where `<ssh-root>` is one of the lexical
 *     spellings of `~/.ssh` (absolute, `~/`, `$HOME/`, and on win32 every
 *     `restrictedRootSpellings` form);
 *   - `<name>` is non-empty and drawn from {@link PUBKEY_NAME} — no glob,
 *     brace, quote, or separator characters, so `~/.ssh/*.pub` and
 *     `~/.ssh/id_rsa{.pub,}` never match;
 *   - the span is followed by neither a path/glob character nor a quote that
 *     opens a concatenated suffix ({@link EXACT_REF_TAIL}), so
 *     `~/.ssh/x.pub"/../id_rsa"` and `~/.ssh/x.pub.bak` never match;
 *   - the typed read denylist ALSO permits the concrete file
 *     (`isReadDenied`), which reuses its symlink check (`foo.pub -> id_rsa`
 *     stays blocked), its per-entry carve-out gate, and the
 *     `AFK_READ_DENYLIST` precedence instead of re-deriving them.
 *
 * @module agent/tools/hooks/bash-restriction-hook.pubkey-scrub
 */

import path from 'path';

import { isReadDenied, SSH_PUBKEY_SUFFIX } from '../handlers/read-denylist.js';
import { escapeRegExp } from '../../../utils/regexp.js';
import { restrictedRootSpellings } from './bash-restriction-hook.win32-spellings.js';

/**
 * Trailing guards shared with the exact-file scrub: the first rejects a
 * prefix-extended / glob-extended lookalike, the second a quote that opens a
 * concatenated suffix (PR #805 P1). See `scrubAllowlistedRefs`.
 */
export const EXACT_REF_TAIL = `(?![\\w./\\\\*?\\[\\]{}-])(?!['"\`][\\w./\\\\*?\\[\\]{}-])`;

/** Strict basename charset for a scrubbable public key (before `.pub`). */
const PUBKEY_NAME = '[A-Za-z0-9_.@+-]+';

/** Placeholder; free of path characters so it can never satisfy a root match. */
const PUBKEY_PLACEHOLDER = '<allowlisted-pubkey>';

/**
 * Blank every permitted `~/.ssh/<name>.pub` reference in `text` (already
 * home-normalized by the caller). See the module contract.
 */
export function scrubSshPubKeyRefs(text: string, home: string): string {
  const sshAbs = path.join(home, '.ssh');
  const forms = [
    ...new Set([sshAbs, '~/.ssh', '$HOME/.ssh'].flatMap((f) => restrictedRootSpellings(f, home))),
  ];
  let out = text;
  for (const form of forms) {
    const ref = new RegExp(
      `${escapeRegExp(form)}/(${PUBKEY_NAME}${escapeRegExp(SSH_PUBKEY_SUFFIX)})${EXACT_REF_TAIL}`,
      'g',
    );
    out = out.replace(ref, (match: string, name: string) =>
      isReadDenied(path.join(sshAbs, name)).denied ? match : PUBKEY_PLACEHOLDER,
    );
  }
  return out;
}
