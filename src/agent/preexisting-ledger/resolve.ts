/**
 * Resolve a locus as agents write it in prose to a repo-relative path.
 *
 * Agents usually name a file by its basename (`anthropic-direct.test.ts`) or a
 * partial path (`openai-compatible/index.ts`), so an exact-path existence check
 * reports live files as missing. Resolution order: exact match, then path
 * suffix, then basename. Pure: callers supply the tracked-file list.
 *
 * Contract: a suffix or basename that matches MORE THAN ONE tracked file is
 * ambiguous and resolves to nothing. The repo holds both
 * `src/browser/config.test.ts` and `src/cli/config.test.ts`, so picking the
 * first match would run the wrong test and report the wrong liveness.
 *
 * @module agent/preexisting-ledger/resolve
 */

import { basename } from 'node:path';

/** Every tracked file a locus could refer to, at the most specific tier that matches. */
export function findLocusMatches(locus: string, files: readonly string[]): string[] {
  if (files.includes(locus)) return [locus];
  const suffix = files.filter((f) => f.endsWith(`/${locus}`));
  if (suffix.length > 0) return suffix;
  const base = basename(locus);
  return files.filter((f) => basename(f) === base);
}

/** The single tracked file a locus refers to, or undefined when absent or ambiguous. */
export function resolveLocusPath(locus: string, files: readonly string[]): string | undefined {
  const matches = findLocusMatches(locus, files);
  return matches.length === 1 ? matches[0] : undefined;
}
