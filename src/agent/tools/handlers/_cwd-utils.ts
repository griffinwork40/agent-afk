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
import { lstatSync, readlinkSync } from 'fs';
import type { ToolHandlerContext } from '../types.js';
import {
  READ_DENYLIST_ENTRY_MARKER,
  PROTECTED_CREDENTIAL_PATH_MARKER,
} from './read-denylist.js';
import { assertNotDenylisted } from './write-denylist.js';
import { decidePathAccess } from './path-policy.js';
import { isEnoent, isErrnoCode } from '../../../utils/errors.js';
import { decideActorContainment, resolvePolicyPath, realpathSafe } from './path-policy.roots.js';
export { realpathSafe, _resetRootRealpathCacheForTests } from './path-policy.roots.js';

/**
 * Resolve `inputPath` to an absolute path (using `resolveBase` for relative
 * inputs) and verify it is contained within at least one allowed root.
 *
 * Throwing wrapper around decidePathAccess: credential floor first, then roots.
 *
 * @param inputPath   - The raw path string from the tool input.
 * @param context     - The current handler context (may be undefined for
 *                      back-compat callers that provide no context).
 * @param mode        - `'read'` or `'write'` — selects the root allow-list and
 *                      the error-message noun; the containment logic is identical.
 * @param fallbackBase - Optional session cwd closed over by a handler factory
 *                      (e.g. `createReadFileHandler(cwd)`). Used as the LAST
 *                      resolve-base tier — after `context.resolveBase`,
 *                      before `process.cwd()` — so a factory handler invoked
 *                      WITHOUT a dispatcher context still anchors relative paths
 *                      to (and confines them within) its session tree instead of
 *                      the host launch dir. Mirrors the `?? sessionCwd` tier
 *                      grep/glob already carry.
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
  const decision = decidePathAccess(inputPath, mode, context, fallbackBase);
  const { resolved } = decision;
  if (decision.kind === 'deny') {
    if (decision.reason === 'credential') {
      if (mode === 'write') {
        throw new Error(`refusing to write to protected path: ${resolved} (matches denylist entry: ${decision.matched})`);
      }
      throw new Error(
        `Path \`${inputPath}\` ${PROTECTED_CREDENTIAL_PATH_MARKER} ` +
          `(${READ_DENYLIST_ENTRY_MARKER} \`${decision.matched}\`) and cannot be read.`,
      );
    }
    const rootList = decision.roots.map((r) => `\`${r}\``).join(', ');
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
 * Both this and decidePathAccess share decideActorContainment. This legacy
 * adapter deliberately reports roots ONLY, never credential-floor denials.
 * Approval hooks must use decidePathAccess before offering grants; bash
 * advisories use this adapter without changing their never-block contract.
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
  return decideActorContainment(resolvePolicyPath(inputPath, context, fallbackBase), mode, context, fallbackBase);
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
    const isAbsolute = path.isAbsolute(token);
    const isHomeRelative = token === '~' || token.startsWith('~/');
    if (!isAbsolute && !isHomeRelative) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

// Maximum symlink hops before giving up (mirrors ELOOP limit).
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolve the final write target for `p`, following any symlink chain.
 *
 * `realpathSafe` (used inside `resolveAndContain`) handles dangling links by
 * walking up to the nearest existing ancestor and reappending the tail — which
 * returns the symlink's own path as if it were a regular file, passing the
 * containment check. But `fs.writeFile(p, ...)` follows the link and writes to
 * its target. This function resolves that target so callers can re-validate it.
 *
 * Returns `p` unchanged when `p` is not a symlink or does not exist.
 */
function resolveSymlinkTarget(p: string): string {
  let current = p;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (err) {
      // Treat ENOENT (dangling chain) and ENOTDIR (non-directory component) as
      // "not a symlink / end of chain" — return current unchanged. Any other
      // error (EACCES, EPERM, …) must fail closed: a permission-denied stat on
      // a symlink inside the write root cannot be silently treated as "not a
      // link", because fs.writeFile would still follow it. Throw so the caller
      // reports the access error rather than granting a silent pass.
      if (isEnoent(err) || isErrnoCode(err, 'ENOTDIR')) return current;
      throw new Error(
        `Cannot stat \`${current}\` while resolving symlink chain from \`${p}\`: ${(err as Error).message}`,
      );
    }
    if (!isLink) return current;
    const dest = readlinkSync(current);
    // Item 1: Resolve relative symlinks against the PHYSICAL parent directory,
    // not the lexical one. If current was reached through a symlinked directory,
    // path.dirname(current) is the lexical parent, which may differ from the
    // filesystem parent the kernel uses. realpathSafe resolves the real parent
    // first, preventing an intermediate-directory symlink from providing a
    // different relative-path base than the kernel would use.
    if (path.isAbsolute(dest)) {
      current = dest;
    } else {
      const parentDir = path.dirname(current);
      const physicalParent = realpathSafe(parentDir);
      current = path.join(physicalParent, dest);
    }
  }
  return current; // hit ELOOP ceiling
}

/**
 * Re-validate the actual write target when `savePath` is a symlink.
 *
 * `resolveAndContain` and `assertNotDenylisted` see the symlink's own path
 * (which is contained), but `fs.writeFile` follows the link and writes to the
 * target. A dangling link inside a write root can point outside it or at a
 * denylisted path, bypassing both checks.
 *
 * Call this AFTER the initial `resolveAndContain` + `assertNotDenylisted`
 * guards and BEFORE any `fs.writeFile` / `mkdir` / `mkdirp`. When `savePath`
 * is not a symlink the function is a no-op. Throws the same errors as
 * `resolveAndContain` and `assertNotDenylisted`.
 *
 * @param savePath   - The already-resolved (contained) output path.
 * @param context    - Handler context forwarded from the tool call.
 * @param toolName   - Tool name used in error messages.
 * @param cwd        - Session cwd used as the fallback resolve base.
 */
export function assertWriteTargetContained(
  savePath: string,
  context: ToolHandlerContext | undefined,
  toolName: string,
  cwd: string,
): void {
  const target = resolveSymlinkTarget(savePath);
  if (target === savePath) return; // not a symlink — initial checks already cover it
  resolveAndContain(target, context, 'write', cwd);
  assertNotDenylisted(target, toolName);
}
