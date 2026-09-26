/**
 * Episode collection for the what-if prediction engine.
 *
 * Three sources:
 *   - Real: recent user turns from the session ledger (preambles stripped,
 *     secrets redacted, deduped).
 *   - Synthetic: one episode per prediction, using its probe prompts.
 *   - Suite: JSON files from a user-supplied directory.
 *
 * @module whatif/episodes
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { parseRecord } from '../agent/session-ledger-reader.js';
import { getSessionsDir } from '../paths.js';
import { redactInlineSecrets } from '../agent/session/prompt-dump.js';
import { extractUserContent } from '../agent/session/preamble-strip.js';
import type { Episode, Prediction } from './types.js';

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Minimum and maximum prompt lengths for real episodes. */
const MIN_LEN = 15;
const MAX_LEN = 4000;

/** Substrings that disqualify a prompt from real-episode inclusion. */
const DISQUALIFY_SUBSTRINGS = [
  '<bash-passthrough',
  '<background-subagent-result',
  '<command-name>',
  'The user has switched off plan mode',
] as const;

function isUsable(text: string): boolean {
  if (text.startsWith('/')) return false;
  if (text.length < MIN_LEN || text.length > MAX_LEN) return false;
  for (const sub of DISQUALIFY_SUBSTRINGS) {
    if (text.includes(sub)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// collectRealTurns
// ---------------------------------------------------------------------------

interface CollectOpts {
  /** Maximum number of episodes to return. */
  limit: number;
  /** Session IDs to skip entirely. */
  excludeSessionIds?: string[];
  /** Override for the sessions directory (tests inject a tmp dir). */
  sessionsDir?: string;
  /** Reference time for maxAgeDays (default: now). */
  now?: Date;
  /** Exclude sessions whose events.jsonl mtime is older than this many days. */
  maxAgeDays?: number;
}

interface SessionEntry {
  id: string;
  mtime: number;
  ledgerPath: string;
}

async function listSessions(sessionsDir: string): Promise<SessionEntry[]> {
  let entries: SessionEntry[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dirContents: any[];
  try {
    dirContents = await fsp.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const ent of dirContents) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    const ledgerPath = path.join(sessionsDir, id, 'events.jsonl');
    try {
      const stat = await fsp.stat(ledgerPath);
      entries.push({ id, mtime: stat.mtimeMs, ledgerPath });
    } catch {
      // Session has no ledger — skip.
    }
  }

  // Newest first.
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries;
}

/**
 * Collect real user turns from the session ledger, newest sessions first.
 *
 * Preambles are stripped via `extractUserContent`; secrets via
 * `redactInlineSecrets`. Case-insensitive dedup across the collected set.
 */
export async function collectRealTurns(opts: CollectOpts): Promise<Episode[]> {
  const { limit, excludeSessionIds = [], sessionsDir, now, maxAgeDays } = opts;

  const dir = sessionsDir ?? getSessionsDir();
  const sessions = await listSessions(dir);

  const excludeSet = new Set(excludeSessionIds);

  const cutoffMs =
    maxAgeDays !== undefined
      ? (now ?? new Date()).getTime() - maxAgeDays * 24 * 60 * 60 * 1000
      : undefined;

  const episodes: Episode[] = [];
  const seenLower = new Set<string>();
  let idx = 1;

  for (const sess of sessions) {
    if (episodes.length >= limit) break;
    if (excludeSet.has(sess.id)) continue;
    if (cutoffMs !== undefined && sess.mtime < cutoffMs) break; // sorted newest first

    let lines: string;
    try {
      lines = await fsp.readFile(sess.ledgerPath, 'utf8');
    } catch {
      continue;
    }

    for (const rawLine of lines.split('\n')) {
      if (episodes.length >= limit) break;
      const rec = parseRecord(rawLine);
      if (!rec || rec.kind !== 'user') continue;

      const rawText: string = (rec as { kind: string; text: string }).text;
      if (!rawText) continue;

      // Strip preamble.
      const stripped = extractUserContent(rawText) ?? rawText;
      // Redact secrets.
      const redacted = redactInlineSecrets(stripped);

      if (!isUsable(redacted)) continue;

      // Case-insensitive dedup.
      const lower = redacted.toLowerCase();
      if (seenLower.has(lower)) continue;
      seenLower.add(lower);

      episodes.push({
        id: `r${idx++}`,
        source: 'real',
        prompt: redacted,
      });
    }
  }

  return episodes;
}

// ---------------------------------------------------------------------------
// syntheticEpisodes
// ---------------------------------------------------------------------------

/**
 * Create synthetic episodes from prediction probe prompts.
 *
 * Each prediction contributes up to its `probes` array length of episodes,
 * all tagged with the prediction id as `targets`.
 */
export function syntheticEpisodes(predictions: Prediction[]): Episode[] {
  const episodes: Episode[] = [];
  let idx = 1;

  for (const pred of predictions) {
    for (const probe of pred.probes) {
      episodes.push({
        id: `s${idx++}`,
        source: 'synthetic',
        prompt: probe,
        targets: pred.id,
      });
    }
  }

  return episodes;
}

// ---------------------------------------------------------------------------
// loadSuiteEpisodes
// ---------------------------------------------------------------------------

/**
 * Load episodes from JSON suite files in a directory.
 *
 * Each file must be valid JSON matching `{ "episodes": [{ "prompt": string }] }`.
 * Files that do not parse or do not match the shape are skipped with a console
 * warning.
 *
 * Episode ids are `u1`, `u2`, ... globally across all files in the directory.
 */
export async function loadSuiteEpisodes(dir: string): Promise<Episode[]> {
  let fileNames: string[];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    fileNames = entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const episodes: Episode[] = [];
  let idx = 1;

  for (const fileName of fileNames) {
    const filePath = path.join(dir, fileName);
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[whatif/episodes] Skipping ${fileName}: invalid JSON`);
      continue;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>)['episodes'])
    ) {
      console.warn(
        `[whatif/episodes] Skipping ${fileName}: missing "episodes" array`,
      );
      continue;
    }

    const suiteData = parsed as Record<string, unknown>;
    const rows = suiteData['episodes'] as unknown[];
    for (const row of rows) {
      if (
        typeof row !== 'object' ||
        row === null ||
        typeof (row as Record<string, unknown>)['prompt'] !== 'string'
      ) {
        continue;
      }
      const prompt = (row as Record<string, string>)['prompt']!;
      episodes.push({
        id: `u${idx++}`,
        source: 'suite',
        prompt,
      });
    }
  }

  return episodes;
}
