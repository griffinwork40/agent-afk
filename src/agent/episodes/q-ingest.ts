/**
 * Q episode ingest adapter — reads AFK memory archive, upserts into Q store.
 *
 * This is the read-only consumer path described in issue #4567:
 *   - Reads `~/.afk/state/memory/memory.db` (AFK facts table).
 *   - Queries facts WHERE category='learning' AND content LIKE '[episode:%'.
 *   - Parses the structured content written by `writer.ts`.
 *   - Upserts each episode into the Q episodes store (`q-store.ts`).
 *
 * Idempotency: a watermark (highest `synthesized_at` seen so far) is stored
 * in the Q episodes DB. Subsequent runs only process facts with
 * `created_at` strictly after the watermark row, so cost is O(new episodes).
 *
 * The adapter is strictly read-only with respect to the AFK memory archive:
 * it opens memory.db in read-only mode and never writes to it.
 *
 * @module agent/episodes/q-ingest
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getMemoryDir } from '../../paths.js';
import { QEpisodesStore } from './q-store.js';

/** A raw fact row from the AFK memory archive. */
interface RawFact {
  id: number;
  session_id: string | null;
  created_at: string;
  category: string;
  content: string;
  source_surface: string;
  evidence: string | null;
}

/** Result of one ingest run. */
export interface IngestResult {
  /** Number of episode facts found in the memory archive. */
  found: number;
  /** Number of episodes actually upserted (may be less than found on partial runs). */
  upserted: number;
  /** The new watermark after this run (ISO timestamp), or null if nothing was ingested. */
  watermark: string | null;
  /** Total episodes now in the Q store. */
  totalStored: number;
}

// ---------------------------------------------------------------------------
// Content parsing
// ---------------------------------------------------------------------------

/**
 * Parse the structured content written by `writer.ts`.
 *
 * Expected format (each field on its own line):
 *   [episode:<sessionId>]
 *   goal: <text>
 *   approach: <text>
 *   outcome: <text>
 *   pivots: <text>            (optional)
 *   decisions: <text>         (optional)
 *   open: <text>              (optional)
 *   files: <csv>              (optional)
 *   tags: <csv>               (optional)
 *   narrative: <text>         (optional)
 *   synthesized: <iso-ts>
 *
 * Multi-line values: continuation lines (lines that do NOT start with a
 * known `key: ` pattern, i.e. `/^[a-z]+: /`) are appended to the current
 * field's value separated by a newline.
 */
export interface ParsedEpisodeContent {
  sessionId: string;
  goal: string;
  narrative: string;
  tags: string[];
  files: string[];
  synthesizedAt: string;
}

/** Pattern that identifies the start of a new key: value line.
 *
 * Restricted to known keys so narrative continuation lines like
 * "goal: to understand X" are not mistaken for a new field boundary.
 */
const KEY_PREFIX_RE = /^(goal|approach|outcome|pivots|decisions|open|files|tags|narrative|synthesized): /;

export function parseEpisodeContent(
  content: string,
  fallbackSessionId: string | null,
): ParsedEpisodeContent | null {
  const lines = content.split('\n');

  // First line must be [episode:<sessionId>]
  const header = lines[0]?.trim() ?? '';
  const headerMatch = /^\[episode:(.+)\]$/.exec(header);
  if (!headerMatch) return null;

  const sessionId = headerMatch[1] ?? fallbackSessionId;
  if (!sessionId) return null;

  // Accumulate fields, appending continuation lines to the current field.
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const line of lines.slice(1)) {
    if (KEY_PREFIX_RE.test(line)) {
      const colon = line.indexOf(': ');
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 2).trim();
      fields[key] = value;
      currentKey = key;
    } else if (currentKey !== null) {
      // Continuation line — append to the current field value.
      fields[currentKey] = (fields[currentKey] ?? '') + '\n' + line.trim();
    }
  }

  const goal = fields['goal'] ?? '';
  const narrative = fields['narrative'] ?? '';
  const synthesizedAt = fields['synthesized'] ?? '';
  const tags = fields['tags']
    ? fields['tags'].split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const files = fields['files']
    ? fields['files'].split(',').map((f) => f.trim()).filter(Boolean)
    : [];

  if (!synthesizedAt) return null;

  return { sessionId, goal, narrative, tags, files, synthesizedAt };
}

// ---------------------------------------------------------------------------
// Main ingest function
// ---------------------------------------------------------------------------

/**
 * Ingest episode facts from the AFK memory archive into the Q episodes store.
 *
 * Opens the AFK memory.db READ-ONLY and the Q episodes store READ-WRITE.
 * Returns an {@link IngestResult} summary.
 *
 * @param memoryDir  Override for the AFK memory directory (default: getMemoryDir()).
 * @param storeDir   Override for the Q episodes store directory (same default).
 */
export function ingestEpisodes(
  memoryDir?: string,
  storeDir?: string,
): IngestResult {
  const resolvedMemoryDir = memoryDir ?? getMemoryDir();
  const memoryDbPath = join(resolvedMemoryDir, 'memory.db');

  if (!existsSync(memoryDbPath)) {
    return { found: 0, upserted: 0, watermark: null, totalStored: 0 };
  }

  const resolvedStoreDir = storeDir ?? resolvedMemoryDir;
  mkdirSync(resolvedStoreDir, { recursive: true });

  const store = new QEpisodesStore(resolvedStoreDir);
  const watermark = store.getWatermark();

  // Open AFK memory.db read-only — the adapter must never write to it.
  // null-init so the finally guard can use optional-chaining even when
  // the Database constructor throws before assignment completes.
  let memDb: InstanceType<typeof Database> | null = null;
  memDb = new Database(memoryDbPath, { readonly: true });

  let found = 0;
  let upserted = 0;
  let newWatermark: string | null = watermark;
  let totalStored = 0;

  try {
    // Query only episode facts, optionally filtered by watermark for efficiency.
    // The watermark filters on `created_at` (the column used in ORDER BY) with
    // strict `>` so the watermark row itself is excluded on the next run.
    const sql = watermark
      ? `SELECT id, session_id, created_at, category, content, source_surface, evidence
           FROM facts
          WHERE category = 'learning'
            AND content LIKE '[episode:%'
            AND content LIKE '%synthesized: %'
            AND created_at > ?
          ORDER BY created_at ASC`
      : `SELECT id, session_id, created_at, category, content, source_surface, evidence
           FROM facts
          WHERE category = 'learning'
            AND content LIKE '[episode:%'
            AND content LIKE '%synthesized: %'
          ORDER BY created_at ASC`;

    const rows = (
      watermark
        ? memDb.prepare(sql).all(watermark)
        : memDb.prepare(sql).all()
    ) as RawFact[];

    found = rows.length;

    for (const row of rows) {
      const parsed = parseEpisodeContent(row.content, row.session_id);
      if (!parsed) continue;

      store.upsertEpisode({
        sessionId: parsed.sessionId,
        goal: parsed.goal,
        narrative: parsed.narrative,
        tags: parsed.tags,
        files: parsed.files,
        synthesizedAt: parsed.synthesizedAt,
      });

      upserted++;

      // Track created_at (the column the watermark filter runs on) so the
      // next run's `created_at > ?` query uses the same timestamp domain.
      if (
        newWatermark === null ||
        row.created_at > newWatermark
      ) {
        newWatermark = row.created_at;
      }
    }

    // Persist the new watermark after every run that fetched rows, regardless
    // of whether any parsed successfully. Advancing over unparseable rows
    // prevents them from being re-fetched on every subsequent run.
    if (found > 0 && newWatermark !== null) {
      store.setWatermark(newWatermark);
    }

    // Read total count before closing the store (avoids TOCTOU re-open).
    totalStored = store.count();
  } finally {
    memDb?.close();
    store.close();
  }

  return { found, upserted, watermark: newWatermark, totalStored };
}
