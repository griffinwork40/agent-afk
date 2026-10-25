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

import { isAbsolute } from 'node:path';
import { validateRootPath } from './root-validation.js';

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
  return cwdValue === undefined ? undefined : validateRootPath(cwdValue, 'cwd', { kind: 'agent' });
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

  const roots = Array.from(writeRootsValue, (entry: unknown) =>
    validateRootPath(entry, 'writeRoots', { kind: 'agent' }),
  );

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

  const roots = Array.from(readRootsValue, (entry: unknown) =>
    validateRootPath(entry, 'readRoots', { kind: 'agent' }),
  );

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
