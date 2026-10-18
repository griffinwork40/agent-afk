/**
 * Single resolve-then-decide policy point for path access.
 *
 * ## Motivation (#3847)
 *
 * A single file path was previously checked by 6+ independent layers, each
 * performing its own `resolve()` / `safeRealpath()` call and producing its own
 * error text:
 *
 *   1. `resolveAndContain` in `_cwd-utils.ts` — called `isReadDenied(resolved)`
 *      on the `path.resolve()`-computed (not realpath-resolved) path.
 *   2. `path-approval-hook.ts` — a second independent `isReadDenied(resolvedAbs)`
 *      call with its own resolution logic. If either resolution diverged, the
 *      two gates could disagree silently.
 *   3. `bash-restriction-hook.ts` — its own `getReadDenylist()` + derived
 *      `restrictedSubstrings` derivation (see issue #3846 for the bash slice).
 *   4. `write-denylist.ts` — `assertNotDenylisted` (separate axis; not this PR).
 *   5. `denial-circuit-breaker.ts` on top of all the above.
 *
 * ## This module — first slice
 *
 * Introduces `decidePathAccess()`: one function that
 *   1. resolves the raw input path once (via `safeRealpath` — same anchor as
 *      the read-denylist internals),
 *   2. consults the credential floor (`isCanonicalPathReadDenied`), and
 *   3. returns a typed `PathAccessDecision` — `{ kind: 'allow' }` or
 *      `{ kind: 'deny', matched: string }`.
 *
 * `resolveAndContain` in `_cwd-utils.ts` and the `path-approval-hook.ts`
 * pre-check both call this function instead of calling `isReadDenied` directly.
 * Because both now go through the same canonicalization, the two layers cannot
 * silently disagree on the credential-floor verdict for a symlinked path.
 *
 * The bash hook (#3846), the write-denylist floor, and the root-containment
 * verdict are intentionally out of scope for this first slice — those are
 * separate axes or separate PRs.
 *
 * ## Security invariants (never weaken)
 *
 * - `deny` is returned whenever `isCanonicalPathReadDenied` returns
 *   `{ denied: true }`. The function never converts a denial into an allow.
 * - Symlink safety is provided by `safeRealpath` (same implementation used
 *   by `read-denylist.ts` internally). A symlink `~/link → ~/.ssh` is
 *   dereferenced before the prefix comparison; a raw `path.resolve()` is not
 *   sufficient and must never substitute for it here.
 * - `AFK_READ_DENYLIST` extras outrank built-in carve-outs (precedence is
 *   inside `isCanonicalPathReadDenied`; this layer adds nothing and takes
 *   nothing away from it).
 *
 * @module agent/tools/handlers/path-policy
 */

import { resolve } from 'node:path';
import { safeRealpath } from './write-denylist.js';
import { isCanonicalPathReadDenied } from './read-denylist.js';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * The typed verdict returned by {@link decidePathAccess}.
 *
 * `allow` — the credential floor permits this path; the caller may proceed to
 * root-containment and any other policy checks.
 *
 * `deny` — the path matches a read-denylist entry. `matched` is the exact
 * entry that triggered the denial (suitable for error messages). The caller
 * MUST NOT permit access to the path.
 */
export type PathAccessDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; matched: string };

// ─── Core function ───────────────────────────────────────────────────────────

/**
 * Resolve `rawPath` once and check it against the credential floor.
 *
 * This is the single resolve-then-decide entry point described in #3847. It
 * replaces the direct `isReadDenied(resolved)` calls scattered across
 * `_cwd-utils.ts` and `path-approval-hook.ts` so the two layers share one
 * canonicalization and cannot silently disagree on a symlinked path.
 *
 * @param rawPath - The path string as supplied by the model or hook (may be
 *   relative, may contain `~`, may be a symlink). Resolution is handled here;
 *   do NOT pre-resolve before calling.
 * @param op - The access operation. Currently only `'read'` gates the
 *   credential floor (writes have their own `assertNotDenylisted` floor in
 *   `write-denylist.ts`). Passing `'write'` always returns `{ kind: 'allow' }`
 *   from this function so callers need not branch — the write floor is a
 *   separate axis.
 *
 * @returns A {@link PathAccessDecision}. Never throws.
 *
 * @example
 * ```ts
 * const decision = decidePathAccess(rawFilePath, 'read');
 * if (decision.kind === 'deny') {
 *   throw new Error(`… ${PROTECTED_CREDENTIAL_PATH_MARKER} (${READ_DENYLIST_ENTRY_MARKER} ${decision.matched})`);
 * }
 * ```
 */
export function decidePathAccess(rawPath: string, op: 'read' | 'write'): PathAccessDecision {
  // Write access is gated by the write-denylist (`assertNotDenylisted`), not
  // by the read credential floor. Return allow immediately so callers don't
  // need to branch — they still call `assertNotDenylisted` themselves.
  if (op !== 'read') return { kind: 'allow' };

  // Resolve once, symlink-dereferenced, using the same `safeRealpath` the
  // read-denylist internals use. This is the single canonicalization point:
  // both `resolveAndContain` and `path-approval-hook` previously called
  // `isReadDenied(path.resolve(…))`, which resolves the path with
  // `path.resolve` (no symlink dereference) before passing to `isReadDenied`,
  // which then calls `safeRealpath` internally — so the dereference happened
  // twice and from a potentially different starting point each time.
  //
  // Here we call `safeRealpath(resolve(rawPath))` once and pass the result
  // directly to `isCanonicalPathReadDenied`, which skips its own
  // `safeRealpath` call. Both layers now share one canonical form.
  const real = safeRealpath(resolve(rawPath));
  const result = isCanonicalPathReadDenied(real);

  if (result.denied) {
    // `matched` is always set when `denied` is true (see isCanonicalPathReadDenied).
    return { kind: 'deny', matched: result.matched ?? real };
  }
  return { kind: 'allow' };
}
