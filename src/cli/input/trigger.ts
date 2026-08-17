/**
 * Trigger detection and candidate filtering for the autocomplete dropdown.
 *
 * Pure functions: no I/O, no side effects on terminal state. The raw-mode
 * reader (`./reader.ts`) calls these every keystroke to decide whether to
 * pop the dropdown and which entries to show.
 */

import { readdirSync, promises as fsp, type Dirent } from 'fs';
import { list as listSlashCommands, aliasEntries, lookup } from '../slash/registry.js';
import { matchSlashCandidates, isSubsequence, type CommandEntry } from './slash-match.js';
import { resolveQuery, MAX_FILE_MATCHES } from '../multi-line-reader.js';
import type { Candidate, Trigger } from './types.js';

/**
 * Detect the trigger kind and query from the buffer at the cursor position.
 *
 * Returns:
 *   - { kind: 'slash', query } if the token at the cursor position is a slash
 *     command (i.e. starts with `/` and contains only `[A-Za-z_-]` characters).
 *     The slash token may appear at the start of the buffer OR after whitespace,
 *     enabling completion mid-buffer or in multiline drafts.
 *   - { kind: 'file', query } if the last token up to cursor matches @<path>
 *   - { kind: 'flag', command, query } if the buffer starts with `/<cmd>` followed
 *     by whitespace and ends with `--<query>` (final token), AND that command is
 *     registered with a non-empty `flags` list
 *   - null otherwise
 *
 * Note: a previous revision auto-popped the full flag menu on any trailing
 * whitespace after the command name. That was reverted because it created two
 * regressions:
 *   1. The dropdown flapped on every space the user typed mid-prompt (the
 *      regex couldn't distinguish "first space after the command name" from
 *      "Nth space mid-prose").
 *   2. Tab-completing `/cmd` inserts a trailing space, which then auto-popped
 *      the flag menu before the user could press Enter to submit — the next
 *      Enter then applied an unintended flag instead of submitting.
 * Flag completion now fires only when the user explicitly types `--`,
 * matching standard CLI completion idioms (bash compgen, zsh, etc.).
 */
export function detectTrigger(buffer: string, cursorCol: number): Trigger | null {
  const upToCursor = buffer.slice(0, cursorCol);

  // Slash command: the token at cursor must be `/[A-Za-z_-]*`.
  // Matches at buffer start OR after whitespace so completion fires mid-buffer
  // and in multiline drafts (e.g. "please run /ship" with cursor at end).
  // The trailing `$` anchors to the cursor position (end of upToCursor).
  const slashMatch = /(?:^|(?<=\s))\/[A-Za-z_-]*$/.exec(upToCursor);
  if (slashMatch) {
    return { kind: 'slash', query: slashMatch[0].slice(1) };
  }

  // File completion: last token must start with @
  const tokens = upToCursor.split(/\s+/);
  const lastToken = tokens[tokens.length - 1] ?? '';
  if (lastToken.startsWith('@') && /^@[^\s]*$/.test(lastToken)) {
    return { kind: 'file', query: lastToken.slice(1) };
  }

  // Flag completion: `/<name> [<args>] --<query>` at end of buffer.
  // Name allows `:` so plugin-namespaced commands (e.g. `/plugin:skill`) match.
  // `(?:.*\s)?` is optional: lets any args sit between the command and the flag.
  const flagMatch = /^\/([A-Za-z][A-Za-z0-9_:-]*)\s+(?:.*\s)?--([a-z0-9-]*)$/.exec(upToCursor);
  if (flagMatch) {
    const commandName = flagMatch[1]!;
    const query = flagMatch[2]!;
    // Resolve via the alias-aware registry lookup so that aliased commands
    // (e.g. /add-dir → /allow-dir) also trigger flag completion when the user
    // types the alias followed by `--`.
    const cmd = lookup(`/${commandName}`);
    if (cmd?.flags && cmd.flags.length > 0) {
      return { kind: 'flag', command: commandName, query };
    }
  }

  return null;
}

/**
 * Filter slash commands for the autocomplete dropdown.
 *
 * Ranking: prefix matches first (preserving the historical `startsWith`
 * behaviour), then subsequence matches — e.g. `cfg` → `/config` — appended
 * below, so abbreviations resolve without displacing the common prefix case.
 * Matching is case-insensitive. Canonical commands and aliases (e.g. `/quit` →
 * `/exit`, which borrow their canonical command's summary) share the same
 * ranking. Capped at 20.
 *
 * Within each bucket, candidates are ordered by how recently the user ran them
 * (`recentHistory`, newest-first), falling back to alphabetical. Omitting
 * `recentHistory` — or passing an empty array — yields exactly the previous
 * alphabetical ordering, so every existing caller and test is unaffected.
 */
export function filterSlashCandidates(
  query: string,
  recentHistory: readonly string[] = [],
): Candidate[] {
  return matchSlashCandidates(buildSlashUniverse(), query, recentHistory);
}

/**
 * Snapshot the in-process registry as a surface-neutral command universe.
 *
 * Exported so the `afk web` route can serve the SAME universe the REPL ranks
 * against — one registry read, one shape, so the two surfaces cannot drift.
 * Aliases are included as first-class entries (borrowing their canonical
 * command's `hint`), exactly as the dropdown has always listed them.
 */
export function buildSlashUniverse(): CommandEntry[] {
  const cmds = listSlashCommands();
  return [
    ...cmds.map((cmd) => ({
      name: cmd.name,
      summary: cmd.summary,
      ...(cmd.hint ? { hint: cmd.hint } : {}),
    })),
    ...aliasEntries().map((entry) => {
      const canonicalCmd = cmds.find((c) => c.name === entry.canonical);
      return {
        name: entry.alias,
        summary: entry.summary,
        ...(canonicalCmd?.hint ? { hint: canonicalCmd.hint } : {}),
      };
    }),
  ];
}

/**
 * Contract: minimal Dirent slice the file-candidate core reads. A real
 * `fs.Dirent` (from `readdir(dir, { withFileTypes: true })`) satisfies this
 * structurally, and tests can supply plain objects without stubbing the
 * whole class. Only `name` and `isDirectory()` are ever consulted.
 */
export interface FileDirent {
  name: string;
  isDirectory(): boolean;
}

/**
 * Contract: one entry in the per-directory scan cache. `entries` is the raw
 * directory listing (unfiltered, unsorted); `at` is the epoch-ms timestamp the
 * scan resolved, used to expire the entry after {@link FILE_SCAN_TTL_MS}.
 */
interface ScanCacheEntry {
  entries: FileDirent[];
  at: number;
}

/**
 * Invariant: the directory-scan cache is the ONLY place fs results are
 * retained between keystrokes. Keyed by absolute `scanDir`, it lets the common
 * "user types another char in the same directory" path serve candidates
 * synchronously (see {@link filterFileCandidatesCached}) instead of hitting the
 * filesystem on every keypress. Entries older than the TTL are treated as
 * absent and re-scanned; `invalidateFileScanCache()` clears it wholesale when
 * the dropdown is dismissed or a prompt is submitted, so a directory mutated
 * between prompts is never served stale.
 *
 * History: replaced the previous synchronous `readdirSync` + per-entry
 * `statSync` that ran inline on the compositor keystroke path and blocked the
 * input thread on large / slow (network) directories.
 */
const scanCache = new Map<string, ScanCacheEntry>();

/** Cache TTL: how long a directory listing may be served without re-reading. */
export const FILE_SCAN_TTL_MS = 2000;

/**
 * Clear the directory-scan cache. Call when the dropdown is dismissed or a
 * prompt is submitted so a directory mutated between prompts is re-read fresh
 * on the next scan (belt-and-suspenders alongside the TTL).
 */
export function invalidateFileScanCache(): void {
  scanCache.clear();
}

/** Test-only: current number of cached directory listings. */
export function __fileScanCacheSize(): number {
  return scanCache.size;
}

/**
 * Pure core: turn a raw directory listing into ranked `@`-file candidates for
 * `query`. No I/O — the caller supplies `entries` (from the cache or a fresh
 * scan) so this stays trivially testable and identical across the sync and
 * async entry points.
 *
 * Values keep the leading `@` (e.g. `@src/index.ts`), mirroring how slash
 * candidates keep their `/` prefix, so `applySelection` — which replaces the
 * trailing non-whitespace run (the `@token`) with the candidate's value —
 * lines up byte-for-byte with what the user typed. `resolveQuery` yields the
 * `displayPrefix` so a `@~/foo` candidate stays `@~/foo` rather than expanding
 * to the absolute home path.
 *
 * Invariant: cap is MAX_FILE_MATCHES from the shared upstream source. Do NOT
 * re-cap to a smaller number here — a secondary cap silently hides entries
 * beyond it even when the dropdown scrolls.
 *
 * Ranking: exact-prefix matches first (alphabetical), then subsequence-only
 * matches (alphabetical). This mirrors the slash-command ranking so abbreviations
 * like `@src/inp` match `src/cli/input/` without displacing prefix hits. Both
 * buckets are capped together at MAX_FILE_MATCHES.
 *
 * Directory flag is derived from the Dirent (`isDirectory()`), NOT a follow-up
 * `statSync`. Tradeoff: a symlink that points at a directory reports as a
 * symlink (not a directory) and therefore loses its trailing `/`. That is an
 * accepted cosmetic loss — dropping the per-entry stat is what keeps the scan
 * off the blocking syscall path.
 */
export function buildFileCandidates(
  entries: FileDirent[],
  query: string,
  rootDir: string = process.cwd(),
  homeDir?: string,
): Candidate[] {
  const { leafPrefix, displayPrefix } = resolveQuery(query, rootDir, homeDir);
  const dirFlag = new Map<string, boolean>();

  // Partition into prefix-match and subsequence-only buckets.
  // Hidden-file filter: skip dotfiles unless the leaf prefix itself starts with '.'.
  const prefixNames: string[] = [];
  const subseqNames: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && !leafPrefix.startsWith('.')) continue;
    dirFlag.set(entry.name, entry.isDirectory());
    if (entry.name.startsWith(leafPrefix)) {
      prefixNames.push(entry.name);
    } else if (leafPrefix.length > 0 && isSubsequence(leafPrefix.toLowerCase(), entry.name.toLowerCase())) {
      subseqNames.push(entry.name);
    }
  }

  // Sort each bucket alphabetically, then merge and cap at MAX_FILE_MATCHES.
  prefixNames.sort();
  subseqNames.sort();
  const names = [...prefixNames, ...subseqNames].slice(0, MAX_FILE_MATCHES);

  return names.map((name) => ({
    value: '@' + displayPrefix + name + (dirFlag.get(name) ? '/' : ''),
  }));
}

/**
 * Synchronous cache-only lookup. Returns ranked candidates when the query's
 * scan directory is cached and fresh (within the TTL); returns `null` on a
 * miss so the caller can decide to dispatch the async scan. Never touches the
 * filesystem — safe to call on the keystroke path.
 */
export function filterFileCandidatesCached(
  query: string,
  rootDir: string = process.cwd(),
  homeDir?: string,
): Candidate[] | null {
  const { scanDir } = resolveQuery(query, rootDir, homeDir);
  const hit = scanCache.get(scanDir);
  if (!hit || Date.now() - hit.at > FILE_SCAN_TTL_MS) return null;
  return buildFileCandidates(hit.entries, query, rootDir, homeDir);
}

/**
 * Async @-file candidate scan. Serves from the per-directory cache when fresh
 * (resolving without any fs call), otherwise reads the directory with
 * `fs.promises.readdir(..., { withFileTypes: true })`, caches the listing, and
 * builds candidates via the pure core.
 *
 * fs errors (unreadable / nonexistent scan dir) resolve to `[]` — the promise
 * never rejects, preserving the historical error-swallowing behavior so the
 * keystroke path has no unhandled rejection to catch.
 */
export async function filterFileCandidatesAsync(
  query: string,
  rootDir: string = process.cwd(),
  homeDir?: string,
): Promise<Candidate[]> {
  const { scanDir } = resolveQuery(query, rootDir, homeDir);
  const cached = scanCache.get(scanDir);
  if (cached && Date.now() - cached.at <= FILE_SCAN_TTL_MS) {
    return buildFileCandidates(cached.entries, query, rootDir, homeDir);
  }
  try {
    const entries: Dirent[] = await fsp.readdir(scanDir, { withFileTypes: true });
    scanCache.set(scanDir, { entries, at: Date.now() });
    return buildFileCandidates(entries, query, rootDir, homeDir);
  } catch {
    // unreadable scan dir → no candidates (never rejects)
    return [];
  }
}

/**
 * Synchronous @-file candidate scan (legacy user-turn reader path).
 *
 * The between-turn `reader.ts` repaint closure is synchronous and writes to
 * stdout inline, so it cannot await the async scan. This keeps a blocking
 * `readdirSync` for that surface only — the hot agent-turn compositor path
 * uses {@link filterFileCandidatesAsync} / {@link filterFileCandidatesCached}.
 * It reads Dirents (`withFileTypes: true`) so it shares the exact
 * `buildFileCandidates` core (no `statSync`) and warms the same cache, so a
 * later async lookup for the same directory is an instant cache hit.
 */
export function filterFileCandidates(
  query: string,
  rootDir: string = process.cwd(),
  homeDir?: string,
): Candidate[] {
  const { scanDir } = resolveQuery(query, rootDir, homeDir);
  try {
    const entries = readdirSync(scanDir, { withFileTypes: true });
    scanCache.set(scanDir, { entries, at: Date.now() });
    return buildFileCandidates(entries, query, rootDir, homeDir);
  } catch {
    // unreadable scan dir → no candidates
    return [];
  }
}

/**
 * Filter long-flag candidates for a given registered command by query prefix.
 *
 * Accepts the query with or without its leading `--` — the dropdown stores
 * queries with the dashes stripped (see `detectTrigger`) but callers using
 * the raw token also work.
 */
export function filterFlagCandidates(command: string, query: string): Candidate[] {
  // Resolve through the alias-aware lookup so flag completion works when the
  // caller passes an alias (e.g. `add-dir`) rather than the canonical name.
  const cmd = lookup(`/${command}`);
  if (!cmd?.flags || cmd.flags.length === 0) return [];
  const needle = query.startsWith('--') ? query.slice(2) : query;
  const matches = cmd.flags
    .filter((flag) => {
      const bare = flag.startsWith('--') ? flag.slice(2) : flag;
      return bare.startsWith(needle);
    })
    .map((value) => ({ value }))
    .sort((a, b) => a.value.localeCompare(b.value));
  return matches.slice(0, 20);
}
