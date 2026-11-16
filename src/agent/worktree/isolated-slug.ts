/**
 * Slug builder for `isolation:"worktree"` dispatches (agent tool + compose).
 *
 * The slug becomes both the `.afk-worktrees/<slug>` directory and the branch
 * name (`afk/<slug>`), which in turn shows up as a PR head branch and in merge
 * commits. A caller-supplied `task_slug` makes that name readable
 * (`iso-issue-4112-telegram-retry-k3x9q2`); without it the legacy shape
 * (`iso-<id_prefix>-<counter>-<suffix>`) is produced unchanged.
 *
 * Names are never derived from the prompt text: prompts can carry secrets and
 * branch names are public once pushed.
 *
 * @module agent/worktree/isolated-slug
 */

import { randomBytes } from 'node:crypto';

/** Fixed length of the random suffix appended to every isolated slug. */
export const ISOLATED_SLUG_SUFFIX_LENGTH = 6;

/** Max length of the cleaned human part of a `task_slug` before the suffix. */
export const MAX_TASK_SLUG_LENGTH = 48;

/**
 * Random base36 suffix of {@link ISOLATED_SLUG_SUFFIX_LENGTH} chars. Uses
 * crypto randomness (not a counter) so names stay unique across sessions,
 * whose counters all restart at 1.
 */
export function randomSlugSuffix(): string {
  return Array.from(randomBytes(ISOLATED_SLUG_SUFFIX_LENGTH), (b) => (b % 36).toString(36)).join('');
}

/**
 * Strict kebab-case for the human part of a task slug: lowercase `a-z0-9`
 * joined by single hyphens, no dots, no leading/trailing hyphen, truncated to
 * {@link MAX_TASK_SLUG_LENGTH}. Returns `''` when nothing usable remains.
 */
export function cleanTaskSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TASK_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

export interface BuildIsolatedSlugArgs {
  /** Caller-supplied 2-5 word kebab summary; optional. */
  taskSlug?: string | undefined;
  /** Legacy label (agent `id_prefix`, or `compose-<nodeId>`). */
  idPrefix: string | undefined;
  /** Per-session isolation counter (legacy shape only). */
  counter: number;
  /** Injected suffix for tests; defaults to {@link randomSlugSuffix}. */
  suffix?: string;
}

/**
 * Build the slug hint passed to `createIsolatedWorktree`.
 *
 * - With a `taskSlug` that cleans to something non-empty:
 *   `iso-<clean>-<suffix>` — at most 4 + 48 + 1 + 6 = 59 chars, so
 *   `sanitizeSlug`'s 80-char slice can never cut the random suffix.
 * - Otherwise: the legacy `iso-<idPrefix>-<counter>-<suffix>` shape.
 */
export function buildIsolatedSlug(args: BuildIsolatedSlugArgs): string {
  const suffix = args.suffix ?? randomSlugSuffix();
  const clean = args.taskSlug !== undefined ? cleanTaskSlug(args.taskSlug) : '';
  if (clean.length > 0) return `iso-${clean}-${suffix}`;
  return `iso-${args.idPrefix}-${args.counter}-${suffix}`;
}
