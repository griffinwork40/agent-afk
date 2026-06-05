/**
 * REPL input history — disk-persistent ring buffer.
 *
 * Storage: `~/.afk/state/repl-history.jsonl`
 * Format:  one JSON object per line — `{ text: string, ts: number }`
 * Cap:     MAX_ENTRIES = 1 000. On overflow the file is compacted (rewritten
 *          with the newest MAX_ENTRIES entries only).
 *
 * All disk I/O is async and fire-and-forget. Write errors are reported to
 * stderr so broken/read-only filesystems surface without crashing the REPL.
 *
 * External constraint: history loads at REPL bootstrap (ordered-operation
 * invariant — `loadHistory()` is called before the read loop, not inside
 * turn/cleanup paths). Disk writes happen after each successful user
 * submission.
 */

import { readFile, mkdir, stat, open } from 'fs/promises';
import { dirname } from 'path';
import { O_WRONLY, O_CREAT, O_APPEND, O_NOFOLLOW, O_TRUNC } from 'node:constants';
import { getReplHistoryPath } from '../../paths.js';

const MAX_ENTRIES = 1_000;

/**
 * Entries matching this pattern are never persisted to disk (SEC-1).
 * Covers common credential formats: API keys (sk-*, ghp_*), GitHub fine-grained
 * PATs (github_pat_*), GitHub server-to-server tokens (ghs_*), Slack bot tokens
 * (xoxb-*), GitLab PATs (glpat-*), bearer tokens, password/token/key assignments.
 */
const SECRET_PATTERN =
  /(?:^sk-[A-Za-z0-9]|^ghp_[A-Za-z0-9]|^github_pat_[A-Za-z0-9]|^ghs_[A-Za-z0-9]|^xoxb-[0-9]|^glpat-[A-Za-z0-9]|bearer\s+\S|password\s*=\s*\S|token\s*=\s*\S|key\s*=\s*\S)/i;

/**
 * Strip ANSI/VT escape sequences from a string (SEC-5).
 * Covers CSI sequences (ESC [ ... final) and two-char ESC sequences.
 */
function stripAnsiEscapes(text: string): string {
  return text.replace(/\x1b\[[^@-~]*[@-~]|\x1b[^[]/g, '');
}

interface HistoryEntry {
  text: string;
  ts: number;
}

// ---------------------------------------------------------------------------
// COR-9: Serialized write queue — prevents race conditions on concurrent
// appendHistory calls. Each write is chained onto `_chain` so they execute
// one at a time. The chain pointer itself never rejects (the `.then(() => {},
// () => {})` swallow), but the promise returned to the caller does propagate
// the rejection so the caller's `.catch` fires correctly.
// ---------------------------------------------------------------------------
/** Serialize all appendHistory calls onto a single promise chain (COR-9). */
let _chain: Promise<void> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = _chain.then(fn, fn);
  _chain = next.then(() => {}, () => {});
  return next;
}

/**
 * Wait for all queued disk writes to settle. For use in tests only — ensures
 * that fire-and-forget writes enqueued by `push()` complete before the test
 * tears down mocks or inspects disk state.
 *
 * @internal
 */
export function flushHistoryWrites(): Promise<void> {
  return _chain;
}

// ---------------------------------------------------------------------------
// PERF-3: Module-level disk-entry counter.
//
// Starts as `null` (not yet known). Set to `entries.length` by `loadHistory`
// on first call, or lazily populated from the file in `appendHistory` when
// compaction eligibility must be checked. After compaction the count is reset
// to MAX_ENTRIES (the file now holds exactly MAX_ENTRIES lines).
// ---------------------------------------------------------------------------
let _diskEntryCount: number | null = null;

/**
 * In-session history ring.
 *
 * The `_entries` array is ordered oldest→newest (index 0 = oldest).
 * Recall navigates from the newest end backward, mirroring bash `history`.
 *
 * Invariant: `_index` is either -1 (no active recall session) or a valid
 * index into `_entries`. Recall state is reset by any buffer edit or new
 * submission.
 */
export class ReplHistory {
  private _entries: string[];
  /** Current recall position. -1 = not in recall mode. */
  private _index: number;
  /** Draft saved when recall begins so we can restore it on forward-past-end. */
  private _draft: string;

  constructor(entries: string[]) {
    this._entries = entries;
    this._index = -1;
    this._draft = '';
  }

  /** Number of persisted entries. */
  get length(): number {
    return this._entries.length;
  }

  /**
   * Return a snapshot of all current entries, newest-first.
   * Used by the ghost-text suggestion engine to find prefix matches
   * without disturbing the active recall session state.
   */
  getEntries(): readonly string[] {
    return this._entries.slice().reverse();
  }

  /**
   * Push a new entry. De-duplicates consecutive identical submissions.
   * Fires async disk write; never throws.
   *
   * Safety gates (applied before persisting):
   *   1. Leading-space escape hatch (à la bash HISTCONTROL=ignorespace):
   *      if the raw (pre-trim) input starts with a space, skip persisting.
   *   2. Secret-pattern deny-list: entries that look like API keys, tokens,
   *      or passwords are never written to disk.
   */
  push(text: string): void {
    // Leading-space escape hatch — honour intentional "don't record this".
    if (text.startsWith(' ')) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    // Secret-pattern deny-list — never persist credentials.
    if (SECRET_PATTERN.test(trimmed)) return;

    // De-duplicate consecutive identical entries.
    const last = this._entries[this._entries.length - 1];
    if (last === trimmed) return;

    this._entries.push(trimmed);
    if (this._entries.length > MAX_ENTRIES) this._entries.shift();

    // Reset recall whenever the history changes.
    this._index = -1;
    this._draft = '';

    // Fire-and-forget disk append (no await — never blocks the REPL).
    appendHistory(trimmed).catch((err: Error) => {
      process.stderr.write(`[afk] history write failed: ${err.message}\n`);
    });
  }

  /**
   * Begin or continue backward recall (↑ / Ctrl+P).
   *
   * @param currentDraft - The current buffer text (saved when recall starts).
   * @returns The recalled entry, or `null` if there's no older entry.
   */
  back(currentDraft: string): string | null {
    if (this._entries.length === 0) return null;

    if (this._index === -1) {
      // Start of recall — save the current draft.
      this._draft = currentDraft;
      this._index = this._entries.length - 1;
    } else if (this._index > 0) {
      this._index--;
    }
    // else: already at oldest entry — fall through to return below.

    return this._entries[this._index] ?? null;
  }

  /**
   * Forward recall (↓ / Ctrl+N) — moves toward the draft.
   *
   * @returns The next-newer entry, the saved draft when navigating past the
   *          newest entry, or `null` if not in recall mode.
   */
  forward(): string | null {
    if (this._index === -1) return null;

    if (this._index < this._entries.length - 1) {
      // _index advances by exactly one step. When at the oldest entry
      // (_index === 0), this moves to index 1 — the next-newer entry —
      // which is correct: entry[0] is the current display, entry[1] is
      // one step forward. No entries are skipped.
      this._index++;
      return this._entries[this._index] ?? null;
    }

    // Moved past the newest entry — restore draft and exit recall.
    this._index = -1;
    const draft = this._draft;
    this._draft = '';
    return draft;
  }

  /**
   * Reset the recall session. Call when the user edits the buffer while in
   * recall mode, or after a new submission.
   */
  resetRecall(): void {
    this._index = -1;
    this._draft = '';
  }

  /** True when a backward recall session is in progress. */
  get inRecall(): boolean {
    return this._index !== -1;
  }
}

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

/**
 * Load history from disk. Returns a `ReplHistory` instance populated with
 * previously-stored entries. Malformed JSONL lines are skipped silently.
 * Called once at REPL bootstrap.
 *
 * Side-effect: initialises the `_diskEntryCount` module variable so subsequent
 * `appendHistory` calls can skip the file-read on the fast path (PERF-3).
 *
 * Non-ENOENT read errors are reported to stderr (PERF-5).
 */
export async function loadHistory(): Promise<ReplHistory> {
  const path = getReplHistoryPath();
  try {
    const raw = await readFile(path, 'utf8');
    const entries: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'text' in parsed &&
          typeof (parsed as HistoryEntry).text === 'string'
        ) {
          const entry = parsed as HistoryEntry;
          // Strip ANSI/VT escape sequences before storing in memory (SEC-5).
          const safe = stripAnsiEscapes(entry.text);
          // Skip empty after strip; enforce no-consecutive-duplicates (COR-5).
          if (safe.trim() && safe !== entries[entries.length - 1]) {
            entries.push(safe);
          }
        }
      } catch {
        // Malformed line — skip silently.
      }
    }
    // PERF-3: seed the disk-entry counter so appendHistory can use the fast
    // path without re-reading the file on the next write.
    _diskEntryCount = entries.length;
    return new ReplHistory(entries);
  } catch (err) {
    // PERF-5: surface unexpected errors; ENOENT is normal (first run).
    if (err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[afk] history load failed: ${(err as Error).message}\n`);
    }
    return new ReplHistory([]);
  }
}

/**
 * Append one entry to the history file. If the file reaches MAX_ENTRIES,
 * compact it (rewrite with the newest MAX_ENTRIES only).
 * Never throws — errors are swallowed by the caller's `.catch`.
 *
 * Writes are serialised through `_chain` (COR-9) to prevent interleaved
 * concurrent writes. The file is opened with O_NOFOLLOW (SEC-4) to guard
 * against symlink-based attacks. A 5 MB size cap (SEC-3) prevents runaway
 * growth in degenerate cases. The module-level `_diskEntryCount` counter
 * (PERF-3) avoids a full file-read on every write when below the compaction
 * threshold.
 */
function appendHistory(text: string): Promise<void> {
  return serialize(async () => {
    const path = getReplHistoryPath();
    // Ensure parent directory exists.
    await mkdir(dirname(path), { recursive: true });

    const entry: HistoryEntry = { text, ts: Date.now() };
    const line = JSON.stringify(entry) + '\n';

    // PERF-3: fast path — if we know the count is safely below the compaction
    // threshold, skip reading the file entirely.
    if (_diskEntryCount !== null && _diskEntryCount < MAX_ENTRIES - 1) {
      // SEC-4: open with O_NOFOLLOW to prevent symlink attacks.
      const fd = await open(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o600);
      try {
        await fd.writeFile(line);
      } finally {
        await fd.close();
      }
      _diskEntryCount++;
      return;
    }

    // Slow path: we need to read the file to decide whether to compact.
    // SEC-3: guard against runaway file growth before reading.
    const st = await stat(path).catch(() => null);
    if (st && st.size > 5 * 1024 * 1024) {
      process.stderr.write(
        `[afk] history file exceeds 5MB cap (${st.size} bytes); skipping write\n`,
      );
      return;
    }

    // Read current entries to determine whether compaction is needed.
    let existing: HistoryEntry[] = [];
    try {
      const raw = await readFile(path, 'utf8');
      for (const l of raw.split('\n')) {
        const trimmed = l.trim();
        if (!trimmed) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            'text' in parsed &&
            typeof (parsed as HistoryEntry).text === 'string'
          ) {
            existing.push(parsed as HistoryEntry);
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      // File doesn't exist yet — existing stays empty.
    }

    // PERF-3: update the counter now that we have an accurate reading.
    _diskEntryCount = existing.length;

    if (existing.length < MAX_ENTRIES - 1) {
      // Fast path: append a single line (owner-only file permissions, SEC-2).
      // SEC-4: O_NOFOLLOW prevents symlink attacks.
      const fd = await open(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o600);
      try {
        await fd.writeFile(line);
      } finally {
        await fd.close();
      }
      _diskEntryCount++;
    } else {
      // Compact: keep newest (MAX_ENTRIES - 1) plus the new entry so the file
      // never exceeds MAX_ENTRIES lines (COR-4).
      const kept = existing.slice(-(MAX_ENTRIES - 1));
      kept.push(entry);
      const compacted = kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
      // SEC-4: O_NOFOLLOW prevents symlink attacks; O_TRUNC truncates in-place.
      // Owner-only permissions (SEC-2).
      const fd = await open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
      try {
        await fd.writeFile(compacted);
      } finally {
        await fd.close();
      }
      // PERF-3: file now holds exactly MAX_ENTRIES lines.
      _diskEntryCount = MAX_ENTRIES;
    }
  });
}
