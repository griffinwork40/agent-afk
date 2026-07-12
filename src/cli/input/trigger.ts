/**
 * Trigger detection and candidate filtering for the autocomplete dropdown.
 *
 * Pure functions: no I/O, no side effects on terminal state. The raw-mode
 * reader (`./reader.ts`) calls these every keystroke to decide whether to
 * pop the dropdown and which entries to show.
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { list as listSlashCommands, aliasEntries } from '../slash/registry.js';
import { resolveQuery, MAX_FILE_MATCHES } from '../multi-line-reader.js';
import type { Candidate, Trigger } from './types.js';
import type { SlashCommand } from '../slash/types.js';

/**
 * Detect the trigger kind and query from the buffer at the cursor position.
 *
 * Returns:
 *   - { kind: 'slash', query } if buffer up to cursor matches /^\/[A-Za-z_-]*$/
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

  // Slash command: matches /^\/[A-Za-z_-]*$/ from start
  if (/^\/[A-Za-z_-]*$/.test(upToCursor)) {
    return { kind: 'slash', query: upToCursor.slice(1) };
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
    const cmd = listSlashCommands().find((c) => c.name === `/${commandName}`);
    if (cmd?.flags && cmd.flags.length > 0) {
      return { kind: 'flag', command: commandName, query };
    }
  }

  return null;
}

/**
 * True when every character of `needle` appears in `haystack` in order (not
 * necessarily contiguous). Used for the subsequence fallback so an abbreviation
 * like `cfg` matches `config`. Both inputs are expected pre-lowercased.
 */
function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Filter slash commands for the autocomplete dropdown.
 *
 * Ranking: prefix matches first (preserving the historical `startsWith`
 * behaviour and its alphabetical ordering), then subsequence matches — e.g.
 * `cfg` → `/config` — appended below, so abbreviations resolve without
 * displacing the common prefix case. Matching is case-insensitive. Canonical
 * commands and aliases (e.g. `/quit` → `/exit`, which borrow their canonical
 * command's summary) share the same ranking. Capped at 20.
 */
export function filterSlashCandidates(query: string): Candidate[] {
  const cmds = listSlashCommands();
  const q = query.toLowerCase();

  const canonicalCand = (cmd: SlashCommand): Candidate => ({
    value: cmd.name,
    summary: cmd.summary,
    ...(cmd.hint ? { hint: cmd.hint } : {}),
  });
  const aliasCand = (entry: { alias: string; canonical: string; summary: string }): Candidate => {
    const canonicalCmd = cmds.find((c) => c.name === entry.canonical);
    return {
      value: entry.alias,
      summary: entry.summary,
      ...(canonicalCmd?.hint ? { hint: canonicalCmd.hint } : {}),
    };
  };

  // (searchKey without leading slash, candidate) universe over commands + aliases.
  const universe: Array<{ key: string; cand: Candidate }> = [
    ...cmds.map((cmd) => ({ key: cmd.name.slice(1).toLowerCase(), cand: canonicalCand(cmd) })),
    ...aliasEntries().map((entry) => ({ key: entry.alias.slice(1).toLowerCase(), cand: aliasCand(entry) })),
  ];

  const prefix = universe.filter((u) => u.key.startsWith(q));
  const prefixValues = new Set(prefix.map((u) => u.cand.value));
  const subseq =
    q.length === 0
      ? []
      : universe.filter((u) => !prefixValues.has(u.cand.value) && isSubsequence(q, u.key));

  const byValue = (a: { cand: Candidate }, b: { cand: Candidate }): number =>
    a.cand.value.localeCompare(b.cand.value);
  prefix.sort(byValue);
  subseq.sort(byValue);
  return [...prefix, ...subseq].map((u) => u.cand).slice(0, 20);
}

/**
 * Filter @-file candidates. Values are returned with the leading `@`
 * preserved (e.g. `@src/index.ts`), mirroring how slash candidates keep
 * their `/` prefix. The dropdown then reads as a unified menu of
 * trigger-shaped tokens, and `applySelection` — which replaces the
 * trailing non-whitespace run (the `@token`) with the candidate's value —
 * lines up byte-for-byte with what the user typed.
 *
 * `resolveQuery` (shared with the multi-line reader's tab-completer) routes
 * the query into one of three scan modes — tilde (`~/`), absolute (`/`), or
 * relative — and yields the `displayPrefix` so a `@~/foo` candidate stays
 * `@~/foo` rather than expanding to the absolute home path. `homeDir` is
 * injectable for test isolation; production lets it default to `os.homedir()`.
 */
export function filterFileCandidates(
  query: string,
  rootDir: string = process.cwd(),
  homeDir?: string,
): Candidate[] {
  // Invariant: cap is MAX_FILE_MATCHES from the shared upstream source.
  // Do NOT re-cap to a smaller number here — a secondary cap silently hides
  // entries beyond it even when the dropdown scrolls. filter → sort → cap →
  // stat matches the fileMatchesFor ordering contract.
  const { scanDir, leafPrefix, displayPrefix } = resolveQuery(query, rootDir, homeDir);
  try {
    const names = readdirSync(scanDir)
      .filter((name) => name.startsWith(leafPrefix))
      .filter((name) => !(name.startsWith('.') && !leafPrefix.startsWith('.')))
      .sort()
      .slice(0, MAX_FILE_MATCHES);
    return names
      .map((name) => {
        let relPath = displayPrefix + name;
        try {
          if (statSync(join(scanDir, name)).isDirectory()) relPath += '/';
        } catch {
          // stat errors don't block completion
        }
        return { value: '@' + relPath };
      });
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
  const cmd = listSlashCommands().find((c) => c.name === `/${command}`);
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
