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
 *   - `~/.afk/config` (afk.env API keys, mcp.json) IS denied — as for writes.
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
 * Symlink safety is inherited from `safeRealpath` (write-denylist.ts): a
 * symlink `~/link → ~/.ssh` is dereferenced before the prefix comparison.
 *
 * @module agent/tools/handlers/read-denylist
 */

import { env } from '../../../config/env.js';
import { resolve } from 'path';
import { homedir } from 'os';
import { safeRealpath } from './write-denylist.js';

/**
 * Paths that `read_file` / `grep` / `glob` / `list_directory` must never read —
 * credential stores and secret files. Each entry is matched against the real
 * (symlink-resolved) target path as a prefix.
 *
 * Extend via `AFK_READ_DENYLIST` (colon-separated absolute paths). As with the
 * write denylist, the built-in entries always apply on top of any custom list;
 * there is intentionally no way to remove a built-in via env.
 */
export const BUILTIN_READ_DENYLIST: readonly string[] = [
  `${homedir()}/.ssh`,
  `${homedir()}/.aws`,
  `${homedir()}/.gnupg`,
  `${homedir()}/.config/gcloud`,
  // AFK's own credential/config tree (afk.env API keys, mcp.json).
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
];

// Memoized resolved denylist, keyed by the AFK_READ_DENYLIST value so a test
// that changes the env re-resolves. Reads are a hot path (every grep/glob/
// read_file call routes through resolveAndContain), so resolving the built-in
// entries' symlinks on every call is avoided. Threat-model note: a
// denylist entry's symlink is assumed stable within a process (mirrors the
// rootRealpathCache assumption in _cwd-utils.ts).
let cached: { key: string; list: readonly string[] } | undefined;

/**
 * Return the effective read denylist (built-in + any `AFK_READ_DENYLIST`
 * extras), each as a real (symlink-resolved) absolute path.
 */
export function getReadDenylist(): readonly string[] {
  const key = env.AFK_READ_DENYLIST ?? '';
  if (cached && cached.key === key) return cached.list;
  const extras: string[] = key
    ? key.split(':').map((p) => safeRealpath(resolve(p))).filter(Boolean)
    : [];
  const list = [...BUILTIN_READ_DENYLIST.map((p) => safeRealpath(resolve(p))), ...extras];
  cached = { key, list };
  return list;
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
  for (const blocked of getReadDenylist()) {
    if (real === blocked || real.startsWith(blocked + '/')) {
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
