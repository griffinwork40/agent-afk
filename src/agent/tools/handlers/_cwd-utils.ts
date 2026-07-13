/**
 * Shared path-resolution and containment utilities for tool handlers.
 *
 * Centralises the `resolveAndContain` logic that was previously copy-pasted
 * into every handler. All six filesystem handlers (read-file, write-file,
 * edit-file, glob, grep, list-directory) import from here.
 *
 * @module agent/tools/handlers/_cwd-utils
 */

import path from 'path';
import { realpathSync } from 'fs';
import type { ToolHandlerContext } from '../types.js';
import { isReadDenied } from './read-denylist.js';

// Invariant: symlink containment must be resolved at the filesystem level, not
// lexically. A symlink that lives INSIDE a granted root but points OUTSIDE it
// would bypass `path.relative` containment if we compare unresolved paths.
// `realpathSafe` resolves symlinks on the true filesystem before any
// containment comparison, so such escape attempts are caught. We handle the
// not-yet-existing-path case (e.g. new write_file targets) by recursively
// resolving the nearest existing ancestor and re-appending trailing segments —
// this prevents throwing on legitimate new-file writes while still resolving
// all existing symlinks in the ancestor chain.
export function realpathSafe(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    // Path may not exist yet (new write target). Resolve the nearest existing
    // ancestor, then re-append the trailing segment(s).
    const dir = path.dirname(p);
    const base = path.basename(p);
    if (dir === p) return p; // reached filesystem root
    return path.join(realpathSafe(dir), base);
  }
}

// Invariant: the realpath of a granted root is filesystem-stable within a
// session — adding or revoking a root mutates the roots array, not what
// realpathSafe(root) returns for a given string. Under this module's
// non-adversarial threat model (a granted root's symlink is not retargeted
// mid-session), caching root -> realpath across calls is safe and removes the
// N+1 realpath syscalls that resolveAndContain / wouldBeRestricted otherwise
// pay on EVERY typed-file-tool call (linear in granted-root count). The
// candidate path is always resolved fresh; only roots are memoized.
const rootRealpathCache = new Map<string, string>();

function realpathRoot(root: string): string {
  const cached = rootRealpathCache.get(root);
  if (cached !== undefined) return cached;
  const real = realpathSafe(root);
  rootRealpathCache.set(root, real);
  return real;
}

/**
 * Test-only: clear the cross-call root realpath cache so suites that point the
 * same root string at different real targets across cases don't see a stale
 * entry. Production never needs this (root realpaths are session-stable).
 */
export function _resetRootRealpathCacheForTests(): void {
  rootRealpathCache.clear();
}

/**
 * Single source of truth for the path-containment DECISION shared by
 * {@link resolveAndContain} (which throws on a restricted verdict) and
 * {@link wouldBeRestricted} (which returns it). Extracting this one function is
 * what makes the handler's throwing enforcement and the path-approval hook's
 * non-throwing pre-check provably agree: "the two layers must agree" becomes
 * structure instead of two hand-synced copies that drifted across ~6 prior PRs.
 *
 * Contract:
 * - `resolved` is the absolute path `inputPath` resolves to (relative inputs
 *   anchored against the resolveBase tier below). It is NOT symlink-resolved —
 *   realpath is used internally for the containment comparison only, never
 *   returned, so callers get back the same string `resolveAndContain` returns.
 * - `restricted: false` when the session is in bypass mode (`allowAll`), is
 *   unconfined (`resolveBase === undefined`), or the resolved path is inside at
 *   least one allowed root.
 * - `restricted: true` when a confined session's path escapes every root.
 * - `roots` is the effective allow-list that was compared against (`[]` for the
 *   bypass / unconfined fast-paths, which never consult roots).
 *
 * The read-denylist floor is deliberately NOT applied here — it is a throw-only
 * hard floor owned by `resolveAndContain` (and enforced independently by the
 * path-approval hook), never part of the shared containment verdict. Folding it
 * in would make `wouldBeRestricted` report denylisted paths as `restricted`,
 * which its callers must not see.
 */
function computeContainment(
  inputPath: string,
  context: ToolHandlerContext | undefined,
  mode: 'read' | 'write',
  fallbackBase: string | undefined,
): { restricted: boolean; resolved: string; roots: string[] } {
  const resolveBase = context?.resolveBase ?? context?.cwd ?? fallbackBase;

  // Resolve to absolute, anchoring relative paths against resolveBase.
  const abs = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(resolveBase ?? process.cwd(), inputPath);

  // Bypass mode: the session runs in `bypassPermissions`, which disables all
  // path containment. Admit any path. This is the same switch the path-approval
  // hook consults to skip its prompt, so the two stay in sync.
  if (context?.allowAll === true) {
    return { restricted: false, resolved: abs, roots: [] };
  }

  // Invariant: `resolveBase === undefined` marks an UNCONFINED session — a
  // top-level `afk chat`/`interactive` run with no worktree, where `config.cwd`
  // is deliberately unset (dispatcher does `this.resolveBase = opts.cwd`). We
  // disable containment here on purpose so such a session can read/write
  // anywhere (config files, /tmp, absolute paths). Do NOT "fix" this by
  // defaulting resolveBase to `process.cwd()`: that confines every top-level
  // session to its launch dir, and — because the emitted `readRoots`/`writeRoots`
  // are `[]` for a no-cwd session (`[] ?? [base]` stays `[]`) — would reject ALL
  // paths. Confinement is opt-in via a set cwd (worktree/fork) or an explicit
  // `fallbackBase`, never a default. See docs/issue #434.
  if (resolveBase === undefined) {
    return { restricted: false, resolved: abs, roots: [] };
  }

  // Resolve symlinks on the candidate path before containment comparison so a
  // symlink inside a root that points outside cannot escape containment.
  const realAbs = realpathSafe(abs);

  // Invariant: `readRoots ?? [resolveBase]` — `[] ?? x` stays `[]`, so a
  // confined session with EMPTY roots denies every path. That empty-roots
  // deny-all is deliberate (a fork with no grants reads/writes nothing); do NOT
  // "fix" it by treating `[]` as "fall back to [resolveBase]".
  const roots: string[] =
    mode === 'read'
      ? (context?.readRoots ?? [resolveBase])
      : (context?.writeRoots ?? [resolveBase]);

  // Path is allowed if it is inside ANY root (compare real paths throughout).
  for (const root of roots) {
    const realRoot = realpathRoot(root);
    const rel = path.relative(realRoot, realAbs);
    if (!rel.startsWith('..')) {
      return { restricted: false, resolved: abs, roots };
    }
  }

  // All roots rejected.
  return { restricted: true, resolved: abs, roots };
}

/**
 * Resolve `inputPath` to an absolute path (using `resolveBase` for relative
 * inputs) and verify it is contained within at least one allowed root.
 *
 * Throwing wrapper around {@link computeContainment}: applies the read-only
 * credential denylist floor, then throws when the shared verdict is restricted.
 *
 * @param inputPath   - The raw path string from the tool input.
 * @param context     - The current handler context (may be undefined for
 *                      back-compat callers that provide no context).
 * @param mode        - `'read'` or `'write'` — selects the root allow-list and
 *                      the error-message noun; the containment logic is identical.
 * @param fallbackBase - Optional session cwd closed over by a handler factory
 *                      (e.g. `createReadFileHandler(cwd)`). Used as the LAST
 *                      resolve-base tier — after `context.resolveBase` /
 *                      `context.cwd`, before `process.cwd()` — so a factory
 *                      handler invoked WITHOUT a dispatcher context still
 *                      anchors relative paths to (and confines them within)
 *                      its session tree instead of the host launch dir. Mirrors
 *                      the `?? sessionCwd` tier grep/glob already carry. On the
 *                      dispatcher path it is a no-op: `context.cwd` and the
 *                      factory cwd are the same value, so `context` wins.
 * @returns The resolved absolute path.
 * @throws  When `mode === 'read'` and the resolved path is a protected
 *          credential/secret path (read-denylist floor), OR when a resolve base
 *          is set and the resolved path falls outside every allowed root.
 */
export function resolveAndContain(
  inputPath: string,
  context: ToolHandlerContext | undefined,
  mode: 'read' | 'write' = 'read',
  fallbackBase?: string,
): string {
  const { restricted, resolved, roots } = computeContainment(
    inputPath,
    context,
    mode,
    fallbackBase,
  );

  // Invariant: the unconditional read-denylist floor — credential/secret paths
  // (~/.ssh, ~/.afk/config, …) are never readable by a typed file tool. It is
  // checked HERE (not in computeContainment) and BEFORE the restricted throw so
  // it fires even for the `allowAll` / unconfined fast-paths that report
  // not-restricted, and so a denylist hit takes precedence over a containment
  // hit. This closes the read/write asymmetry (writes are gated by
  // write-denylist.ts; reads had NO floor); it is applied to the resolved
  // absolute path, exactly as computed by computeContainment. Writes keep their
  // own floor in write-file.ts / edit-file.ts.
  if (mode === 'read') {
    const denied = isReadDenied(resolved);
    if (denied.denied) {
      throw new Error(
        `Path \`${inputPath}\` is a protected credential/secret path ` +
          `(read-denylist entry: \`${denied.matched}\`) and cannot be read.`,
      );
    }
  }

  if (restricted) {
    const rootList = roots.map((r) => `\`${r}\``).join(', ');
    const noun = mode === 'read' ? 'read roots' : 'write roots';
    throw new Error(`Path \`${inputPath}\` is outside the allowed ${noun} [${rootList}].`);
  }

  return resolved;
}

/**
 * Non-throwing variant of {@link resolveAndContain}: returns the containment
 * verdict instead of throwing on a failure. Used by the path-approval
 * PreToolUse hook to decide whether to prompt the user BEFORE the handler's
 * resolveAndContain throws, and by the bash handler's advisory write-scan.
 *
 * Both this and `resolveAndContain` delegate to the same private
 * {@link computeContainment}, so their containment decisions cannot drift. The
 * one intentional asymmetry: `resolveAndContain` additionally enforces the
 * read-denylist floor (a throw-only hard floor), which is NOT reflected in this
 * verdict — callers that must honor the floor (the path-approval hook) check
 * the denylist themselves; `restricted` here is purely a roots-containment
 * verdict.
 *
 * Contract:
 * - `resolved` is always the absolute path that `resolveAndContain` would
 *   produce. Callers can pass it straight to `addReadRoot/addWriteRoot` on
 *   the grant manager after an approval prompt.
 * - `restricted: false` means the path is contained within at least one
 *   allowed root (or bypass mode / no `resolveBase` disables enforcement).
 * - `restricted: true` means EVERY root rejected the path; the caller should
 *   either elicit user approval or block.
 */
export function wouldBeRestricted(
  inputPath: string,
  context: ToolHandlerContext | undefined,
  mode: 'read' | 'write' = 'read',
  fallbackBase?: string,
): { restricted: boolean; resolved: string; roots: string[] } {
  return computeContainment(inputPath, context, mode, fallbackBase);
}

/**
 * Best-effort extraction of filesystem path candidates from a raw shell
 * command string, for the bash handler's advisory containment scan.
 *
 * Extracts, by whitespace tokenization:
 *   - Absolute paths (tokens beginning with `/`), and
 *   - Home-relative paths (tokens beginning with `~/`, or a bare `~`).
 * A leading shell redirection/pipe operator glued to the path (`>`, `>>`,
 * `<`, `|`, `&`, and fd-prefixed forms like `2>`) is stripped first, then a
 * surrounding single/double quote, then trailing shell punctuation commonly
 * abutting a path in a command line (`;`, `,`, `)`, `"`, `'`). Relative
 * tokens, flags (`-x`, `--flag`), and everything else are ignored.
 *
 * EXPLICITLY best-effort. This is NOT a shell parser and deliberately does
 * NOT resolve or catch:
 *   - command/arithmetic substitution: `$(printf /etc/hosts)`, backticks
 *   - environment-variable indirection: `$HOME`, `${SECRET_DIR}`
 *   - glob expansion: `/etc/*`, brace expansion `/a/{b,c}`
 *   - here-docs (`<<EOF`), paths synthesized across tokens, or quoted paths
 *     containing whitespace.
 * Building a real shell parser to close those gaps is a deliberate non-goal
 * (issue #354 calls it a rathole). The residual gap is the reason the bash
 * containment scan is advisory-only, documented in
 * `docs/decisions/0001-bash-tool-path-containment.md`.
 *
 * @param command - The raw command string from the bash tool input.
 * @returns Deduplicated candidate path tokens (order-preserving).
 */
export function extractCandidatePaths(command: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawToken of command.split(/\s+/)) {
    if (rawToken.length === 0) continue;
    // Strip a leading shell redirection/pipe operator glued to the path
    // (`>`, `>>`, `<`, `|`, `&`, and fd-prefixed forms like `2>`), then a
    // matching leading quote, then any trailing quote/shell punctuation that
    // commonly abuts a path token on a command line.
    let token = rawToken
      .replace(/^\d*[<>|&]+/, '')
      .replace(/^['"]/, '')
      .replace(/['";,)]+$/, '');
    if (token.length === 0) continue;
    const isAbsolute = token.startsWith('/');
    const isHomeRelative = token === '~' || token.startsWith('~/');
    if (!isAbsolute && !isHomeRelative) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
