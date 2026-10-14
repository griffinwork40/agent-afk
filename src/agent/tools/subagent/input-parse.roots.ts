/**
 * Named validation helpers for the path-shaped fields of `parseAgentInput`:
 * `attachments`, `cwd`, `writeRoots`, `readRoots`, and `isolation`.
 *
 * Extracted from `input-parse.ts` as part of #1865 (complexity hotspot
 * split). Each helper takes its raw value as an explicit parameter and
 * returns the validated, normalised value — no closures over enclosing
 * locals. All `Invariant:` / `Contract:` comments travel with the code
 * they govern.
 *
 * @module agent/tools/subagent/input-parse.roots
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';
import { isReadDenied, READ_DENYLIST_ENTRY_MARKER } from '../handlers/read-denylist.js';
import { realpathSafe } from '../handlers/_cwd-utils.js';
import { isTooBroadRoot, ungatedSensitiveRoot } from './root-validation.js';

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

/**
 * Validate and normalise the `attachments` field.
 *
 * Returns `undefined` when the value is absent / empty.
 * Throws on any shape violation.
 */
export function parseAttachments(
  attachmentsValue: unknown,
  mode: string,
): string[] | undefined {
  if (attachmentsValue === undefined) return undefined;

  if (!Array.isArray(attachmentsValue)) {
    throw new Error('Agent tool attachments must be an array of absolute image paths');
  }

  const paths: string[] = [];
  for (const entry of attachmentsValue) {
    if (typeof entry !== 'string') {
      throw new Error(
        `Agent tool attachments entries must be strings, got: ${JSON.stringify(entry)}`,
      );
    }
    if (entry.trim().length === 0) {
      throw new Error('Agent tool attachments entries must not be empty strings');
    }
    if (!isAbsolute(entry) && !/^img_[0-9a-f]{6,64}(?:_[1-9][0-9]*)?$/.test(entry)) {
      throw new Error(
        `Agent tool attachments entries must be absolute image paths or inbound image ids, got: ${JSON.stringify(entry)}`,
      );
    }
    paths.push(entry);
  }

  if (paths.length === 0) return undefined;

  if (mode === 'background') {
    throw new Error(
      'Agent tool attachments are not supported with mode:"background"; use mode:"foreground"',
    );
  }

  return paths;
}

// ---------------------------------------------------------------------------
// cwd
// ---------------------------------------------------------------------------

/**
 * Validate and normalise the `cwd` field.
 *
 * Rules (see full rationale in AgentInput.cwd JSDoc):
 *   1. Must be a string when meaningfully present (blank → absent).
 *   2. Must be absolute.
 *   3. Must not contain `..` segments.
 *   4. BREADTH (#740) — must not be a filesystem root, os.homedir(), or an
 *      ancestor of homedir (checked on lexical AND symlink-resolved form).
 *   5. ANCESTOR-OF-CREDENTIAL (#852) — must not sit above a bash-restricted
 *      credential root.
 *
 * Returns `undefined` when absent. Throws on any violation.
 */
export function parseCwd(cwdValue: string | undefined): string | undefined {
  if (cwdValue === undefined) return undefined;

  if (!isAbsolute(cwdValue)) {
    throw new Error(
      `Agent tool cwd must be an absolute path, got: ${JSON.stringify(cwdValue)}`,
    );
  }

  const segments = cwdValue.split(/[/\\]/);
  if (segments.includes('..')) {
    throw new Error(
      `Agent tool cwd must not contain '..' segments, got: ${JSON.stringify(cwdValue)}`,
    );
  }

  // 4. Breadth rejection (#740) — checked on BOTH the lexical path AND its
  // symlink-resolved target. A symlink to `/`/home would pass a lexical-only
  // check yet become a broad real root at read time (#664 Codex P1).
  const resolvedCwd = resolvePath(cwdValue);
  const realResolvedCwd = realpathSafe(resolvedCwd);
  if (isTooBroadRoot(resolvedCwd) || isTooBroadRoot(realResolvedCwd)) {
    throw new Error(
      `Agent tool cwd must not be a filesystem root, your home directory, ` +
        `or an ancestor of it (checked after resolving symlinks) — pass a ` +
        `specific subdirectory instead. If the child only needs to READ files ` +
        `outside its tree (dotfiles, ~/.config), do NOT move cwd there: leave ` +
        `cwd alone and grant those paths via readRoots. Got: ${JSON.stringify(cwdValue)}`,
    );
  }

  // 5. Ancestor-of-credential rejection (#852). `cwd` becomes the child's
  // `resolveBase`, which `deriveRestrictedSubstrings` seeds into `granted`
  // alongside the explicit roots — so a cwd ABOVE a credential root lifts
  // that root's bash gate exactly as a readRoots grant would, and this leg
  // is what closes the resolveBase half of the hole.
  const cwdUngates = ungatedSensitiveRoot(resolvedCwd);
  if (cwdUngates !== undefined) {
    throw new Error(
      `Agent tool cwd must not be at or above a credential root the bash ` +
        `restriction protects (${cwdUngates}) — anchoring the child there would ` +
        `silently drop that whole tree out of its bash gate. Pass a directory ` +
        `outside it. Got: ${JSON.stringify(cwdValue)}`,
    );
  }

  return cwdValue;
}

// ---------------------------------------------------------------------------
// writeRoots
// ---------------------------------------------------------------------------

/**
 * Validate and normalise the `writeRoots` field.
 *
 * Per-entry rules:
 *   (format) non-empty, absolute, no `..` segments.
 *   (a) BREADTH (#740) — must not be a filesystem root, os.homedir(), or
 *       an ancestor of homedir (checked on lexical AND symlink-resolved form).
 *   (b) DENYLIST (#1965) — must not resolve into the credential floor
 *       (`isReadDenied`).
 *   (c) ANCESTOR-OF-CREDENTIAL (#852) — must not sit above a bash-restricted
 *       credential root.
 *
 * An empty array normalises to `undefined`. Throws on any violation.
 */
export function parseWriteRoots(writeRootsValue: unknown): string[] | undefined {
  if (writeRootsValue === undefined) return undefined;

  if (!Array.isArray(writeRootsValue)) {
    throw new Error(
      `Agent tool writeRoots must be an array of absolute paths, got: ${JSON.stringify(writeRootsValue)}`,
    );
  }

  const roots: string[] = [];
  for (const entry of writeRootsValue) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(
        `Agent tool writeRoots entries must be non-empty strings, got: ${JSON.stringify(entry)}`,
      );
    }
    if (!isAbsolute(entry)) {
      throw new Error(
        `Agent tool writeRoots entries must be absolute paths, got: ${JSON.stringify(entry)}`,
      );
    }
    if (entry.split(/[/\\]/).includes('..')) {
      throw new Error(
        `Agent tool writeRoots entries must not contain '..' segments, got: ${JSON.stringify(entry)}`,
      );
    }

    // (a) Breadth rejection (#740) — lexical AND symlink-resolved.
    const resolvedEntry = resolvePath(entry);
    const realResolvedEntry = realpathSafe(resolvedEntry);
    if (isTooBroadRoot(resolvedEntry) || isTooBroadRoot(realResolvedEntry)) {
      throw new Error(
        `Agent tool writeRoots entries must not be a filesystem root, your home ` +
          `directory, or an ancestor of it (checked after resolving symlinks) — ` +
          `grant a specific subdirectory instead, got: ${JSON.stringify(entry)}`,
      );
    }

    // (b) Denylist rejection (#1965) — never let a write grant target the
    // credential floor. A write grant to a credential path does not just
    // expose it for reading; it allows overwriting secrets. isReadDenied
    // realpaths internally, so a symlinked credential path is caught too.
    const wDenied = isReadDenied(resolvedEntry);
    if (wDenied.denied) {
      throw new Error(
        `Agent tool writeRoots entries must not target a protected/credential path ` +
          `(matches ${READ_DENYLIST_ENTRY_MARKER} ${wDenied.matched}), got: ${JSON.stringify(entry)}`,
      );
    }

    // (c) Ancestor-of-credential rejection (#852) — writeRoots feed the same
    // `granted` set in `deriveRestrictedSubstrings` that cwd and readRoots
    // do, so the guard has to be identical on all three or the erosion just
    // moves to whichever field is left unchecked.
    const wUngates = ungatedSensitiveRoot(resolvedEntry);
    if (wUngates !== undefined) {
      throw new Error(
        `Agent tool writeRoots entries must not be at or above a credential root ` +
          `the bash restriction protects (${wUngates}) — granting it would silently ` +
          `drop that whole tree out of the child's bash gate. Grant a narrower ` +
          `subdirectory instead. Got: ${JSON.stringify(entry)}`,
      );
    }

    roots.push(entry);
  }

  return roots.length > 0 ? roots : undefined;
}

// ---------------------------------------------------------------------------
// readRoots
// ---------------------------------------------------------------------------

/**
 * Validate and normalise the `readRoots` field.
 *
 * Per-entry rules:
 *   (format) non-empty, absolute, no `..` segments.
 *   (a) BREADTH — must not be a filesystem root, os.homedir(), or an
 *       ancestor of homedir. Checked on BOTH the lexical path AND its
 *       symlink-resolved target (#664 Codex P1).
 *   (b) DENYLIST — must not resolve into the read-denylist credential floor
 *       (`isReadDenied`). Defense-in-depth on top of the read-time floor.
 *   (c) ANCESTOR-OF-CREDENTIAL (#852) — must not sit above a bash-restricted
 *       credential root, distinct from (b): (b) catches IS a credential path;
 *       (c) catches merely ABOVE it.
 *
 * An empty array normalises to `undefined`. Throws on any violation.
 */
export function parseReadRoots(readRootsValue: unknown): string[] | undefined {
  if (readRootsValue === undefined) return undefined;

  if (!Array.isArray(readRootsValue)) {
    throw new Error(
      `Agent tool readRoots must be an array of absolute paths, got: ${JSON.stringify(readRootsValue)}`,
    );
  }

  const roots: string[] = [];
  for (const entry of readRootsValue) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(
        `Agent tool readRoots entries must be non-empty strings, got: ${JSON.stringify(entry)}`,
      );
    }
    if (!isAbsolute(entry)) {
      throw new Error(
        `Agent tool readRoots entries must be absolute paths, got: ${JSON.stringify(entry)}`,
      );
    }
    if (entry.split(/[/\\]/).includes('..')) {
      throw new Error(
        `Agent tool readRoots entries must not contain '..' segments, got: ${JSON.stringify(entry)}`,
      );
    }

    // (a) Breadth rejection. Resolve lexically AND to the symlink target, then
    // reject if EITHER is too broad. The symlink pass is load-bearing: the
    // containment layer realpaths granted roots before comparison (realpathRoot,
    // _cwd-utils.ts), so a symlink to `/` or the home dir would pass a
    // lexical-only check yet grant the confined child a broad real root at
    // read time (#664 Codex P1). realpathSafe resolves existing symlinks and
    // falls back to the nearest existing ancestor for a not-yet-created path.
    const resolved = resolvePath(entry);
    const realResolved = realpathSafe(resolved);
    if (isTooBroadRoot(resolved) || isTooBroadRoot(realResolved)) {
      throw new Error(
        `Agent tool readRoots entries must not be a filesystem root, your home directory, ` +
          `or an ancestor of it (checked after resolving symlinks) — grant specific ` +
          `subdirectories, or the individual FILES you need: a single file is a valid ` +
          `read root and grants exactly that file, which is how to reach home-root ` +
          `dotfiles (e.g. "<home>/.zshrc", "<home>/.gitconfig") without granting the ` +
          `home directory. Got: ${JSON.stringify(entry)}`,
      );
    }

    // (b) Denylist rejection — never let a grant target the credential floor.
    // isReadDenied realpaths internally, so a symlinked credential path is
    // caught here too.
    const denied = isReadDenied(resolved);
    if (denied.denied) {
      throw new Error(
        `Agent tool readRoots entries must not target a protected/credential path ` +
          `(matches ${READ_DENYLIST_ENTRY_MARKER} ${denied.matched}), got: ${JSON.stringify(entry)}`,
      );
    }

    // (c) Ancestor-of-credential rejection (#852). Distinct from (b): the
    // denylist catches an entry that IS (or resolves into) a credential path,
    // but says nothing about one that merely sits ABOVE it. Those are exactly
    // the grants that empty the bash floor — `~/Library/Application Support`
    // is neither too broad nor read-denied, yet covers every browser secret
    // tree beneath it.
    const ungates = ungatedSensitiveRoot(resolved);
    if (ungates !== undefined) {
      throw new Error(
        `Agent tool readRoots entries must not be at or above a credential root ` +
          `the bash restriction protects (${ungates}) — granting it would silently ` +
          `drop that whole tree out of the child's bash gate. Grant a narrower ` +
          `subdirectory, or the individual FILES you need: a single file is a valid ` +
          `read root and grants exactly that file. Got: ${JSON.stringify(entry)}`,
      );
    }

    roots.push(entry);
  }

  return roots.length > 0 ? roots : undefined;
}

// ---------------------------------------------------------------------------
// isolation
// ---------------------------------------------------------------------------

/**
 * Validate the `isolation` field, given already-validated `cwd` and
 * `writeRoots` values (needed for mutual-exclusion checks).
 *
 * Returns `'worktree'` or `undefined`. `'none'` normalises to `undefined`
 * so the executor's `=== 'worktree'` check is total. Throws on any
 * violation or mutual-exclusion conflict.
 *
 * Every mutual-exclusion message names the ESCAPE, not just the conflict —
 * the model gets another tool round after a validation throw and a
 * message that states only the rule leaves the caller guessing which field
 * to drop.
 */
export function parseIsolation(
  isolationValue: unknown,
  cwd: string | undefined,
  writeRoots: string[] | undefined,
): 'worktree' | undefined {
  if (isolationValue === undefined || isolationValue === 'none') return undefined;

  if (isolationValue !== 'worktree') {
    throw new Error(
      `Agent tool isolation must be "none" or "worktree", got: ${JSON.stringify(isolationValue)}`,
    );
  }

  if (cwd !== undefined) {
    throw new Error(
      'Agent tool cwd and isolation are mutually exclusive — pass one or the other. ' +
        'To isolate, OMIT cwd entirely (the runtime creates and owns the worktree). ' +
        'To run in a specific directory, omit isolation instead.',
    );
  }

  if (writeRoots !== undefined) {
    throw new Error(
      'Agent tool writeRoots and isolation are mutually exclusive — a worktree-isolated ' +
        'child is fully confined by design. Omit writeRoots to isolate, or omit isolation ' +
        'to keep the extra write grants.',
    );
  }

  return 'worktree';
}
