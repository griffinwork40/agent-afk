/**
 * Triage operations for failure cards.
 *
 * Two operations a reviewer needs after a scan:
 *
 *   1. Append a human note explaining what the pattern actually means in
 *      context (was it a false positive? a real issue? known and
 *      accepted?).
 *   2. Update the card's `status` — typically to `deferred` (we know,
 *      will fix later) or `resolved` (the underlying behavior has been
 *      fixed; the card stays as a historical record).
 *
 * Both operations preserve everything else: evidence, severity, detail,
 * other notes. The card-writer's merge logic is the source of truth for
 * "what survives a re-scan" — triage just performs one targeted edit
 * and persists.
 *
 * ## I/O
 *
 *   - Read-modify-write via the existing atomic-write helpers in
 *     `card-writer.ts` (write-tmp → rename).
 *   - The `.index.jsonl` log is NOT touched. Index events describe scan-
 *     time merges, not human triage. A reviewer-tracked changelog would
 *     be a future addition.
 *
 * ## Concurrency
 *
 *   - The read-modify-write window is small but real. Concurrent triage
 *     of the same slug could clobber a note. This matches existing
 *     card-writer semantics. For MVP, single-operator usage is assumed.
 *
 * @module improve/triage
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  type CardStatus,
  type FailureCard,
  FailureCardSchema,
  type TriageNote,
} from './schemas.js';
import {
  getFailureCardJsonPath,
  getFailureCardMarkdownPath,
} from './paths.js';
import {
  readCardIfExists,
  renderMarkdown,
} from './scan/card-writer.js';

export class TriageError extends Error {
  constructor(
    public readonly code: 'card-not-found' | 'invalid-note' | 'invalid-status' | 'no-change',
    message: string,
  ) {
    super(message);
    this.name = 'TriageError';
  }
}

export interface TriageOptions {
  /** Non-empty note text to append. Trimmed before storage. */
  note?: string;
  /** New status. If undefined, status is left unchanged. */
  status?: CardStatus;
  /**
   * Override the "now" timestamp. Tests use this to assert deterministic
   * markdown output; production always passes `undefined` and gets
   * `new Date().toISOString()`.
   */
  now?: () => Date;
}

export interface TriageOutcome {
  slug: string;
  /** Resulting card after the edit, validated against the schema. */
  card: FailureCard;
  noteAdded: boolean;
  /** Set when `--status` actually changed the value. */
  statusChanged: { from: CardStatus; to: CardStatus } | undefined;
  jsonPath: string;
  markdownPath: string;
}

/**
 * Apply a triage edit to a card on disk. Returns the resulting card.
 *
 * At least one of `note` or `status` must be provided; if neither is, the
 * function throws `TriageError('no-change', ...)` — silent no-ops on the
 * filesystem are a bug magnet.
 */
export function triageCard(slug: string, options: TriageOptions): TriageOutcome {
  const jsonPath = getFailureCardJsonPath(slug);
  const mdPath = getFailureCardMarkdownPath(slug);

  const existing = readCardIfExists(jsonPath);
  if (!existing) {
    throw new TriageError('card-not-found', `No failure card found for slug '${slug}'`);
  }

  // Order matters: validate the explicit `note` argument BEFORE deciding
  // whether the call is a no-op. A caller who passed `--note "   "` should
  // get an `invalid-note` error, not a misleading `no-change`.
  if (options.note !== undefined && options.note.trim().length === 0) {
    throw new TriageError('invalid-note', 'triage note must be non-empty after trim');
  }

  const trimmedNote = options.note?.trim();
  const wantsNote = trimmedNote !== undefined && trimmedNote.length > 0;
  const wantsStatus = options.status !== undefined && options.status !== existing.status;

  if (!wantsNote && !wantsStatus) {
    throw new TriageError(
      'no-change',
      'triage requires at least --note or --status to differ from current',
    );
  }

  const now = (options.now ?? (() => new Date()))().toISOString();

  const newNotes: TriageNote[] = wantsNote
    ? [...existing.notes, { at: now, text: trimmedNote }]
    : existing.notes;

  const newStatus: CardStatus = wantsStatus ? options.status! : existing.status;

  const next: FailureCard = {
    ...existing,
    status: newStatus,
    notes: newNotes,
  };

  const validated = FailureCardSchema.parse(next);

  // Atomic writes — mirror card-writer.ts. Helpers are local so triage
  // doesn't reach into card-writer's privates.
  ensureDir(jsonPath);
  atomicWriteJson(jsonPath, validated);
  atomicWriteText(mdPath, renderMarkdown(validated));

  return {
    slug,
    card: validated,
    noteAdded: wantsNote,
    statusChanged: wantsStatus
      ? { from: existing.status, to: newStatus }
      : undefined,
    jsonPath,
    markdownPath: mdPath,
  };
}

// ---------------------------------------------------------------------------
// Local I/O helpers (mirror card-writer.ts)
// ---------------------------------------------------------------------------

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function atomicWriteText(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
