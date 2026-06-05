/**
 * Shared changelog generation logic.
 *
 * Parses conventional-commit messages since the last git tag,
 * groups them into Keep a Changelog categories, and can merge
 * into an existing [Unreleased] section.
 *
 * Used by: /changelog slash command, scripts/generate-changelog.mjs (CI).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CommitEntry {
  hash: string;
  subject: string;
  category: string;
}

const CATEGORY_MAP: Record<string, string> = {
  feat: 'Added',
  fix: 'Fixed',
  refactor: 'Changed',
  perf: 'Changed',
  docs: 'Changed',
  chore: 'Changed',
  ci: 'Changed',
  test: 'Changed',
  'test+fix': 'Fixed',
  build: 'Changed',
  style: 'Changed',
};

const CATEGORY_ORDER = ['Added', 'Fixed', 'Changed', 'Deprecated', 'Removed', 'Security'];

export function parseCommits(repoRoot: string): CommitEntry[] {
  let lastTag: string;
  try {
    lastTag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    lastTag = '';
  }

  const gitArgs = lastTag
    ? ['log', `${lastTag}..HEAD`, '--format=%h %s']
    : ['log', '-50', '--format=%h %s'];

  const raw = execFileSync('git', gitArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();

  if (!raw) return [];

  return raw.split('\n').map((line) => {
    const spaceIdx = line.indexOf(' ');
    const hash = line.slice(0, spaceIdx);
    const subject = line.slice(spaceIdx + 1);

    const match = subject.match(/^(\w+(?:\+\w+)?)(?:\([^)]*\))?!?:\s*(.+)/);
    if (match) {
      const prefix = match[1]!.toLowerCase();
      const category = CATEGORY_MAP[prefix] ?? 'Changed';
      return { hash, subject: match[2]!, category };
    }
    return { hash, subject, category: 'Changed' };
  });
}

/**
 * Format commit entries into Keep a Changelog markdown sections.
 *
 * @param commits - Parsed commit entries to format.
 * @param options.includeHash - When true, appends `(<short-hash>)` to each
 *   bullet. Required for `updateChangelog`/`updateAndStampChangelog` dedup
 *   to function (dedup matches on the trailing hash). When false (default),
 *   bullets are plain `- <subject>` — matching the pre-refactor /changelog
 *   slash-command output for human-facing changelogs.
 *
 *   CI (scripts/generate-changelog.mjs) sets this to true so repeated runs
 *   skip already-written commits. The /changelog slash command leaves it
 *   false to preserve historical bullet format.
 */
export function formatEntries(
  commits: CommitEntry[],
  options: { includeHash?: boolean } = {},
): string {
  const includeHash = options.includeHash ?? false;
  const grouped = new Map<string, CommitEntry[]>();
  for (const c of commits) {
    const list = grouped.get(c.category) ?? [];
    list.push(c);
    grouped.set(c.category, list);
  }

  const sections: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const entries = grouped.get(cat);
    if (!entries?.length) continue;
    sections.push(`### ${cat}`);
    for (const e of entries) {
      sections.push(includeHash ? `- ${e.subject} (${e.hash})` : `- ${e.subject}`);
    }
    sections.push('');
  }
  return sections.join('\n');
}

export function getExistingUnreleased(changelog: string): string {
  const match = changelog.match(/## \[Unreleased\][^\n]*\n([\s\S]*?)(?=\n## \[|$)/);
  return match?.[1]?.trim() ?? '';
}

/**
 * Parse the short commit hashes already present in an [Unreleased] block.
 * Entries are formatted as `- <subject> (<hash>)` by `formatEntries`.
 */
function parseExistingHashes(unreleasedBlock: string): Set<string> {
  const hashes = new Set<string>();
  for (const line of unreleasedBlock.split('\n')) {
    const m = line.match(/\(([0-9a-f]{7,})\)\s*$/);
    if (m?.[1]) hashes.add(m[1]);
  }
  return hashes;
}

/**
 * Apply updateChangelog and stampRelease transformations in memory,
 * then perform a single write.
 *
 * Use this in CI (generate-changelog.mjs) to avoid the partial-state window
 * that exists when two separate write calls are interleaved — the file is
 * read once and written once. This is NOT a POSIX-atomic write (no tempfile
 * + rename); a SIGKILL mid-write can still truncate the file. Adequate for
 * a CI release step where re-running is safe.
 */
export function updateAndStampChangelog(
  repoRoot: string,
  newEntries: string,
  version: string,
  date: string,
): void {
  const changelogPath = resolve(repoRoot, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');

  // Step 1: apply updateChangelog logic in memory
  const existing = getExistingUnreleased(changelog);
  const existingHashes = parseExistingHashes(existing);

  const dedupedLines = newEntries
    .split('\n')
    .filter((line) => {
      const m = line.match(/\(([0-9a-f]{7,})\)\s*$/);
      if (m?.[1] && existingHashes.has(m[1])) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const combined =
    existing && dedupedLines
      ? existing + '\n\n' + dedupedLines
      : existing || dedupedLines;

  let updated = changelog.replace(
    /## \[Unreleased\][^\n]*\n[\s\S]*?(?=\n## \[|$)/,
    `## [Unreleased]\n\n${combined}\n`,
  );

  if (updated === changelog) {
    throw new Error('No ## [Unreleased] section found');
  }

  // Step 2: apply stampRelease logic in memory
  updated = updated.replace(
    /## \[Unreleased\]/,
    `## [Unreleased]\n\n## [${version}] - ${date}`,
  );

  // Single write — combines updateChangelog + stampRelease into one I/O call
  // to shrink the interruption window. Not POSIX-atomic; see JSDoc above.
  writeFileSync(changelogPath, updated);
}

/**
 * Prepend new entries into the [Unreleased] section, skipping any commits
 * whose short hash already appears in the existing block (dedup guard).
 *
 * Kept for backward compatibility with the /changelog slash command.
 */
export function updateChangelog(repoRoot: string, newEntries: string): void {
  const changelogPath = resolve(repoRoot, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  const existing = getExistingUnreleased(changelog);
  const existingHashes = parseExistingHashes(existing);

  const dedupedLines = newEntries
    .split('\n')
    .filter((line) => {
      const m = line.match(/\(([0-9a-f]{7,})\)\s*$/);
      if (m?.[1] && existingHashes.has(m[1])) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const combined =
    existing && dedupedLines
      ? existing + '\n\n' + dedupedLines
      : existing || dedupedLines;

  const updated = changelog.replace(
    /## \[Unreleased\][^\n]*\n[\s\S]*?(?=\n## \[|$)/,
    `## [Unreleased]\n\n${combined}\n`,
  );

  if (updated === changelog) {
    throw new Error('No ## [Unreleased] section found');
  }

  writeFileSync(changelogPath, updated);
}

export function stampRelease(repoRoot: string, version: string, date: string): void {
  const changelogPath = resolve(repoRoot, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');

  const updated = changelog.replace(
    /## \[Unreleased\]/,
    `## [Unreleased]\n\n## [${version}] - ${date}`,
  );

  writeFileSync(changelogPath, updated);
}
