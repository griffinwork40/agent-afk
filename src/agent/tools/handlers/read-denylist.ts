/**
 * Shared read-denylist utilities for file-reading tool handlers.
 *
 * Reads had NO secret-path floor while writes did (see `write-denylist.ts`) —
 * an asymmetry that let any UNCONFINED session (and its forks) read credential
 * stores via `read_file` / `grep` / `glob` / `list_directory`. This module
 * closes that gap: it is enforced unconditionally in `resolveAndContain`
 * (before the `allowAll` and unconfined fast-paths) and in the path-approval
 * PreToolUse hook, so no confinement mode — bypass, unconfined, or a forked
 * sub-agent — can reach a denylisted path.
 *
 * Divergence from the WRITE denylist is deliberate:
 *   - `~/.afk/config` (afk.env API keys) IS denied — as for writes — with ONE
 *     built-in exception: `mcp.json` (see `READ_ALLOWLIST_REL`).
 *   - `~/.afk/state` is NOT denied — sub-agents legitimately READ skill-preflight
 *     inputs, todos, transcripts, and session ledgers there (#544/#547/#554);
 *     denying it would re-introduce the very read failures those fixes closed.
 *   - `/etc`, `/System`, … are NOT blanket-denied for reads (unlike writes):
 *     legitimate reads of `/etc/hosts` etc. are common, and the truly-secret
 *     system files are enumerated individually below.
 *   - Conversely, this list floors a few high-value credential files the WRITE
 *     denylist does not yet cover (~/.git-credentials, ~/.netrc, gh hosts.yml,
 *     ~/.kube/config): read-exfiltration of a live token is the acute risk for
 *     an agent that runs git/gh, so reads are floored first. Mirroring these
 *     into BUILTIN_WRITE_DENYLIST is a reasonable follow-up.
 *
 * History: the REVERSE gap. `bash-restriction-hook.ts` floors
 * `~/Library/Application Support` (whole dir) and `~/.password-store` for
 * `cat`, but until now this list did not, so those credential stores were
 * blocked for the shell and freely readable via `read_file`/`grep`/`glob`.
 * `~/.password-store` closes here as a whole dir (nothing under it is
 * legitimately readable). `~/Library/Application Support` closes NARROWER —
 * per-browser secret trees only, never the whole dir — because this floor is
 * permanent and the bash one is grant-liftable; see the inline comment on
 * those entries below for the full reasoning.
 *
 * Symlink safety is inherited from `safeRealpath` (write-denylist.ts): a
 * symlink `~/link → ~/.ssh` is dereferenced before the prefix comparison.
 *
 * @module agent/tools/handlers/read-denylist
 */

import { env } from '../../../config/env.js';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { homedir } from 'os';
import { safeRealpath } from './write-denylist.js';
import { getAfkHome } from '../../../paths.js';
import { warnAfkHomeRejectedOnce } from '../afk-home-warn.js';
import { pathIsWithin } from '../fs-case.js';

/**
 * Paths that `read_file` / `grep` / `glob` / `list_directory` must never read —
 * credential stores and secret files. Each entry is matched against the real
 * (symlink-resolved) target path as a prefix.
 *
 * Extend via `AFK_READ_DENYLIST` (colon-separated absolute paths; a leading
 * `~/` is expanded — see {@link parseReadDenylistEntries}). As with the write
 * denylist, the built-in entries always apply on top of any custom list; there
 * is intentionally no way to remove a built-in via env.
 */
export const BUILTIN_READ_DENYLIST: readonly string[] = [
  `${homedir()}/.ssh`,
  `${homedir()}/.aws`,
  `${homedir()}/.gnupg`,
  `${homedir()}/.config/gcloud`,
  // AFK's own credential/config tree (afk.env API keys, afk.config.json —
  // which may carry a literal `apiKey`, see cli/config/types.ts). Floored as a
  // WHOLE DIR on purpose: the dir also accumulates operator backups
  // (`afk.env.bak-*`), so a file-level deny list here would be fail-OPEN —
  // every new or renamed sibling would default to readable. Non-secret members
  // are opted OUT one at a time via `READ_ALLOWLIST_REL` instead.
  // Invariant: only `.../config` — NEVER `.../state`, which forked sub-agents
  // must be able to read (skill-preflight inputs, todos, transcripts). Adding
  // `.../state` here would re-break #544/#547/#554.
  `${homedir()}/.afk/config`,
  // npm publish tokens and Docker registry credentials.
  `${homedir()}/.npmrc`,
  `${homedir()}/.docker/config.json`,
  // Git/HTTP credential stores and CLI OAuth tokens. This agent does heavy
  // git/gh work, so a leaked token here would let an exfiltrator push to the
  // operator's repos — highest-value reads to floor. File-level (not whole-dir)
  // so ordinary reads of sibling non-secret config (~/.kube/cache, gh config.yml)
  // still work; extend via AFK_READ_DENYLIST for non-default token locations.
  `${homedir()}/.git-credentials`,
  `${homedir()}/.netrc`,
  `${homedir()}/.config/gh/hosts.yml`,
  `${homedir()}/.kube/config`,
  // Classic system secret stores. Enumerated individually (not the whole /etc)
  // so ordinary /etc reads still work; these are usually root-only anyway.
  '/etc/shadow',
  '/etc/sudoers',
  '/private/etc/master.passwd',
  // Password-store (`pass`, passwordstore.org) — every entry underneath is a
  // GPG-encrypted secret and there is no non-secret sibling to carve out, so
  // the whole dir floors cleanly with no READ_ALLOWLIST_REL needed. This was
  // previously a bash-only root (`builtinBashSensitiveRoots` in
  // bash-restriction-hook.ts) — blocked for `cat`, wide open for `read_file` /
  // `grep` / `glob`. Adding it here is what closes that reverse gap.
  `${homedir()}/.password-store`,
  // Invariant: browser SECRET TREES, deliberately NOT the whole `~/Library/
  // Application Support` the bash hook floors (`builtinBashSensitiveRoots`).
  // The two floors differ in liftability, and that difference is why their
  // scope differs:
  //   - The bash root is GRANT-FILTERED — `/allow-dir <path>` drops it for a
  //     session (`deriveRestrictedSubstrings`) — so flooring the whole dir
  //     there costs an operator nothing permanent; they can always opt back
  //     in.
  //   - This list has no such escape hatch. It is the UNCONDITIONAL floor
  //     (module docstring): no operator, no bypass mode, no forked subagent
  //     can ever un-deny a built-in entry. Mirroring the bash root verbatim
  //     would PERMANENTLY blind read_file/grep/glob to every macOS app config
  //     that happens to live under Application Support — including this
  //     repo's own `terminal_font_size` targets (`~/Library/Application
  //     Support/Cursor/User/settings.json`, `.../Code/User/settings.json`,
  //     `permissions-store.ts`'s own grant-path example). A permanent floor
  //     has to be scoped to the actual secret material, not the whole vendor
  //     directory that contains it.
  // So each browser's profile root is floored individually — the standard
  // macOS install locations, listed even when absent on this machine, so the
  // floor does not depend on which browsers an operator happens to have
  // installed:
  //   - Chromium-family (Chrome, Chromium, Brave, Edge) keep `Login Data`
  //     (saved passwords), `Cookies` (session tokens), and `Web Data`
  //     (autofill, incl. payment cards) as SQLite files directly inside the
  //     profile directory.
  //   - Firefox keeps `logins.json` (encrypted saved logins) and `key4.db`
  //     (the key that decrypts them) inside its profile directory.
  //   - Arc is Chromium-based (`User Data/<profile>/Login Data`, `Cookies`)
  //     and floored the same way.
  // `BraveSoftware` and `Microsoft Edge` are floored as their whole vendor
  // dirs — unlike Google's, which also holds unrelated non-browser apps
  // (Google-AdWords-Editor, GoogleUpdater, RLZ), both of those vendor dirs
  // hold nothing but that browser's own channel variants, so there is no
  // sibling app config to lose by flooring the whole thing.
  //
  // Out of scope (follow-up, not folded in here): Safari's secrets live
  // OUTSIDE Application Support entirely (`~/Library/Safari`,
  // `~/Library/Cookies`) — neither this list nor the bash hook covers them
  // today.
  `${homedir()}/Library/Application Support/Google/Chrome`,
  `${homedir()}/Library/Application Support/Chromium`,
  `${homedir()}/Library/Application Support/BraveSoftware`,
  `${homedir()}/Library/Application Support/Microsoft Edge`,
  `${homedir()}/Library/Application Support/Arc`,
  `${homedir()}/Library/Application Support/Firefox`,
];

/**
 * Home-relative files that sit INSIDE a denied directory but are deliberately
 * readable. Matched as EXACT files (never as a prefix), so `mcp.json.bak`,
 * `mcp.json/<child>`, `config.bak`, and `known_hosts.old` stay denied.
 *
 * `~/.afk/config/mcp.json` is the MCP server REGISTRY, not a credential store:
 * its `env` / `headers` values are documented to hold `${VAR}` placeholders
 * expanded from the environment at connect time, not inline literals
 * (`agent/mcp/types.ts`). Agents legitimately need to read it to diagnose a
 * server that will not connect, and the floor was never real anyway — `bash`
 * (`cat ~/.afk/config/mcp.json`) is unaffected by this denylist, so the block
 * only ever cost the typed read tools.
 *
 * Operators who DO store inline secrets there can re-deny it explicitly with
 * `AFK_READ_DENYLIST=~/.afk/config/mcp.json` — see the ordering invariant in
 * {@link isReadDenied}.
 *
 * `~/.ssh/config` and `~/.ssh/known_hosts` sit inside the whole-dir `~/.ssh`
 * floor (which stays — SSH private keys have ARBITRARY names like `github_key`,
 * so a key-name glob would fail-open). These two files are well-known
 * non-secret siblings the agent legitimately needs for git/ssh host-alias
 * work: `config` carries host aliases (IdentityFile PATHS, not key material),
 * `known_hosts` is the trusted-host list. Neither is a private key. They are
 * carved out as EXACT files so `~/.ssh/id_*`, `~/.ssh/config.bak`, and any
 * other sibling stay denied. Operators who consider either sensitive in their
 * environment can re-deny explicitly with
 * `AFK_READ_DENYLIST=~/.ssh/config` (extras outrank the exception).
 *
 * Kept home-RELATIVE so the REPL `@`-file injector
 * (`cli/commands/interactive/at-file-inject.ts`), which resolves against an
 * injectable home, shares this one list instead of duplicating it.
 */
export const READ_ALLOWLIST_REL: readonly string[] = [
  '.afk/config/mcp.json',
  '.ssh/config',
  '.ssh/known_hosts',
];

/** {@link READ_ALLOWLIST_REL} resolved against the real home directory. */
export const BUILTIN_READ_ALLOWLIST: readonly string[] = READ_ALLOWLIST_REL.map(
  (rel) => `${homedir()}/${rel}`,
);

/**
 * Resolve one exception entry to the path form compared in {@link isReadDenied}:
 * the parent-directory chain IS dereferenced, the final leaf is NOT.
 *
 * Invariant: an exception must never be expressed as the symlink TARGET of its
 * own leaf. `safeRealpath` on the whole entry would do exactly that — if
 * `~/.afk/config/mcp.json` were a symlink to a protected file (an SSH private
 * key, `afk.env`), the resolved target would become the exception, and since
 * the exception is consulted before the built-in prefixes, a DIRECT read of
 * that protected file would return allowed. Resolving only the directory chain
 * keeps the carve-out working when `~/.afk` or `~/.afk/config` is itself a
 * symlink (dotfiles setups relocate the config dir), while the un-dereferenced
 * leaf means a symlinked `mcp.json` can never launder a protected target
 * through the registry's name.
 *
 * Consequence, deliberate and fail-closed: if `mcp.json` is a symlink pointing
 * OUT of the resolved config dir, the request dereferences to something that is
 * not this entry, so the carve-out does not apply and the normal floor decides
 * (denied when the target is protected). An operator who keeps the registry
 * elsewhere reads it by its own path instead.
 *
 * Exported so the leaf-non-dereference invariant is directly testable: the
 * built-in lists are keyed to the real `homedir()`, so a suite cannot fabricate
 * a symlinked `~/.afk/config` to exercise it end-to-end.
 */
export function resolveExceptionEntry(entry: string): string {
  const abs = resolve(entry);
  return join(safeRealpath(dirname(abs)), basename(abs));
}

// Memoized resolved lists, keyed by the AFK_READ_DENYLIST value so a test
// that changes the env re-resolves. Reads are a hot path (every grep/glob/
// read_file call routes through resolveAndContain), so resolving the built-in
// entries' symlinks on every call is avoided. Built-ins and extras are kept
// SEPARATE because they have different precedence (see `isReadDenied`).
// Threat-model note: a denylist entry's symlink is assumed stable within a
// process (mirrors the rootRealpathCache assumption in _cwd-utils.ts).
let cached:
  | { key: string; builtins: readonly string[]; extras: readonly string[]; allow: readonly string[] }
  | undefined;

/**
 * Parse an `AFK_READ_DENYLIST` value into absolute, un-realpath'd paths.
 *
 * Invariant: this is the SINGLE parser for that env var. The bash-restriction
 * hook needs the entries as-SPELLED (its scan is lexical) while this module
 * needs them symlink-RESOLVED, so the two consumers differ in what they do
 * AFTER parsing — but they must never differ in the parse itself. A second
 * hand-rolled copy in `bash-restriction-hook.ts` is exactly how `~/…` came to
 * be honored on neither surface (PR #734 review, MAJOR 1).
 *
 * A leading `~` IS expanded, because the documented example for this var is
 * itself tilde-spelled (`AFK_READ_DENYLIST=~/.afk/config/mcp.json`) and
 * `resolve()` alone turns that into a literal `./~/…` directory that matches
 * nothing — a security control silently protecting no path. `~user/…` is NOT
 * expanded (no portable home lookup); spell those absolutely.
 */
export function parseReadDenylistEntries(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p))
    .map((p) => resolve(p));
}

/**
 * Best-effort derived read-denylist entry for the `AFK_HOME`-relocated config
 * dir (`${getAfkHome()}/config`), ADDITIVE alongside the hardcoded
 * `${homedir()}/.afk/config` literal in {@link BUILTIN_READ_DENYLIST} (both
 * spellings are covered; they are equal, and de-duplicated by the caller,
 * when `AFK_HOME` is unset). Computed HERE — inside {@link resolveLists}, not
 * at module scope — because a module-level `getAfkHome()` call would
 * evaluate once at import time and never observe a runtime `AFK_HOME` change
 * (the test suite mutates env vars; production operators can too via a
 * process restart with a different env).
 *
 * `getAfkHome()` throws when `AFK_HOME` is set but not absolute (or is `/`,
 * see `paths.ts`). Caught and dropped here — a malformed env var must never
 * empty the credential floor; the hardcoded `homedir()`-based entries still
 * apply regardless.
 */
function derivedAfkHomeReadEntry(): string[] {
  try {
    return [safeRealpath(resolve(join(getAfkHome(), 'config')))];
  } catch (err) {
    warnAfkHomeRejectedOnce(err);
    return [];
  }
}

const AFK_HOME_REL_PREFIX = '.afk/';

/**
 * The `AFK_HOME`-relocated spelling of every {@link READ_ALLOWLIST_REL}
 * carve-out, derived the same way {@link derivedAfkHomeReadEntry} derives the
 * denied parent.
 *
 * Invariant: the allowlist MUST follow `AFK_HOME` whenever the denylist does.
 * These two move together or the carve-out silently inverts: extending only the
 * deny side makes `${getAfkHome()}/config/mcp.json` unreadable under a
 * relocated home while the default-home spelling stays readable — the registry
 * becomes invisible to both the typed tools and the bash surface for exactly
 * the operators who relocated it. An empirical probe caught that asymmetry;
 * a diff read did not.
 *
 * Entries are declared relative to the home dir (`.afk/config/mcp.json`), so
 * the relocated form is the tail after `.afk/` rejoined under `getAfkHome()`.
 * A non-`.afk/` entry has no relocated spelling and is skipped. `getAfkHome()`
 * throws on a malformed `AFK_HOME`; caught and dropped, which fails CLOSED
 * here (no extra carve-out) rather than open.
 */
function derivedAfkHomeAllowEntries(): string[] {
  try {
    const afkHome = getAfkHome();
    return READ_ALLOWLIST_REL.filter((rel) => rel.startsWith(AFK_HOME_REL_PREFIX)).map((rel) =>
      resolveExceptionEntry(join(afkHome, rel.slice(AFK_HOME_REL_PREFIX.length))),
    );
  } catch (err) {
    warnAfkHomeRejectedOnce(err);
    return [];
  }
}

function resolveLists(): {
  builtins: readonly string[];
  extras: readonly string[];
  allow: readonly string[];
} {
  // Invariant: AFK_HOME is part of the cache key alongside AFK_READ_DENYLIST.
  // The builtins list now depends on it (derivedAfkHomeReadEntry), so a
  // runtime AFK_HOME change must invalidate the memo the same way an
  // AFK_READ_DENYLIST change does — otherwise a stale denylist survives a
  // relocated AFK_HOME. Joined with U+0000, which cannot occur in either env
  // value, so the two components can never collide into an ambiguous key.
  const key = `${env.AFK_READ_DENYLIST ?? ''}\u0000${env.AFK_HOME ?? ''}`;
  if (cached && cached.key === key) return cached;
  const extras: string[] = parseReadDenylistEntries(env.AFK_READ_DENYLIST)
    .map((p) => safeRealpath(p))
    .filter(Boolean);
  const builtins = [
    ...new Set([
      ...BUILTIN_READ_DENYLIST.map((p) => safeRealpath(resolve(p))),
      ...derivedAfkHomeReadEntry(),
    ]),
  ];
  cached = {
    key,
    builtins,
    extras,
    allow: [
      ...new Set([
        ...BUILTIN_READ_ALLOWLIST.map(resolveExceptionEntry),
        ...derivedAfkHomeAllowEntries(),
      ]),
    ],
  };
  return cached;
}

/**
 * Return the effective read denylist (built-in + any `AFK_READ_DENYLIST`
 * extras), each as a real (symlink-resolved) absolute path.
 *
 * @note This is the raw prefix list — it does NOT reflect
 * {@link BUILTIN_READ_ALLOWLIST} exceptions. Call {@link isReadDenied} for the
 * effective verdict.
 */
export function getReadDenylist(): readonly string[] {
  const { builtins, extras } = resolveLists();
  return [...builtins, ...extras];
}

/**
 * Denylist entries INSIDE `root`, as root-relative POSIX segments (glob-ready).
 *
 * Invariant: the normalization CHOKEPOINT for descendant-pruning callers
 * (`grep.ts`). `getReadDenylist()` entries are always `safeRealpath`-resolved,
 * but a caller's own root (e.g. `resolveAndContain`'s return value) typically
 * is NOT. macOS symlinks `/tmp` -> `/private/tmp`, so an unresolved root vs. a
 * resolved denylist via raw `path.relative` never lines up and pruning
 * silently no-ops (grep.test.ts "prunes protected descendants"). Resolving
 * `root` HERE with the same `safeRealpath` makes both sides symmetric.
 */
export function getReadDenylistDescendants(root: string): string[] {
  const realRoot = safeRealpath(resolve(root));
  const rels = getReadDenylist().map((blocked) => relative(realRoot, blocked));
  return rels
    .filter((rel) => rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`))
    .map((rel) => rel.split(sep).join('/'));
}

/**
 * Test-only: clear the memoized denylist so suites that mutate
 * `AFK_READ_DENYLIST` or repoint a denylisted symlink don't see a stale list.
 */
export function _resetReadDenylistCacheForTests(): void {
  cached = undefined;
}

/**
 * Return whether `filePath` resolves (symlink-dereferenced) inside a
 * read-denylisted prefix. Never throws.
 */
export function isReadDenied(filePath: string): { denied: boolean; matched?: string } {
  const real = safeRealpath(resolve(filePath));
  const { builtins, extras, allow } = resolveLists();

  // Invariant: operator-supplied `AFK_READ_DENYLIST` extras are matched BEFORE
  // the built-in exception list, and are never weakened by it. The documented
  // contract for that env var is that it only ever ADDS denials
  // (`config/env.ts`), so a built-in carve-out must remain re-deniable: setting
  // AFK_READ_DENYLIST=~/.afk/config/mcp.json has to win. Checking the exception
  // first (an early return at the top of this function) would silently invert
  // that contract and make the carve-out unremovable.
  for (const blocked of extras) {
    if (pathIsWithin(real, blocked)) {
      return { denied: true, matched: blocked };
    }
  }
  // Exact-file exceptions only — a prefix match here would carve out a whole
  // directory and re-open the fail-open hole the whole-dir floor exists to
  // close. Entries are leaf-un-dereferenced (see `resolveExceptionEntry`), so a
  // symlinked `mcp.json` cannot smuggle a protected target into this set.
  if (allow.includes(real)) return { denied: false };
  for (const blocked of builtins) {
    if (pathIsWithin(real, blocked)) {
      return { denied: true, matched: blocked };
    }
  }
  return { denied: false };
}

/**
 * Throw if the resolved (symlink-dereferenced) path falls inside a
 * read-denylisted prefix. Mirrors `assertNotDenylisted` for writes.
 *
 * @param filePath    - The raw path as supplied by the model.
 * @param handlerName - Tool name for the error message.
 */
export function assertNotReadDenied(filePath: string, handlerName = 'read_file'): void {
  const { denied, matched } = isReadDenied(filePath);
  if (denied) {
    const real = safeRealpath(resolve(filePath));
    throw new Error(
      `${handlerName}: refusing to read protected path: ${real}` +
        ` (matches read-denylist entry: ${matched})`,
    );
  }
}
