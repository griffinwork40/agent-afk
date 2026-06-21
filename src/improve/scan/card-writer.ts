/**
 * Failure-card writer.
 *
 * Two responsibilities:
 *
 *   1. Merge a {@link DetectorResult} into the on-disk card for its slug,
 *      preserving any human triage notes and any prior triage `status`.
 *   2. Render a regenerable `<slug>.md` companion view + append a row to
 *      the `.index.jsonl` event log.
 *
 * ## Merge semantics (load-bearing — tested)
 *
 *   - `firstSeen` = MIN of existing and new observations.
 *   - `lastSeen`  = MAX of existing and new observations.
 *   - `evidence`  = union, deduped by `(sessionId, eventIndices[0])`.
 *   - `occurrenceCount` = length of merged evidence.
 *   - `notes`     = preserved verbatim from disk. The writer never touches
 *                   them. A scan that re-detects the pattern after a human
 *                   left a note still sees that note on the next read.
 *   - `status`    = preserved if present on disk. A new card defaults to
 *                   `'open'`. Resolution does not auto-reopen on re-detection
 *                   in Phase 1A; that's a Phase 1B decision.
 *   - `severity`  = MAX of existing and new (escalation only — never auto-
 *                   downgrade). Severity ordering: low < medium < high.
 *   - `title`     = updated to the most recent detection's title. The slug
 *                   is the stable identity; the title is a hint.
 *   - `detail`    = REPLACED. Detector-specific blob always reflects the
 *                   most recent finding; merging arbitrary detail shapes
 *                   safely is out of scope for MVP. Historic detail lives
 *                   in `.index.jsonl` for auditability.
 *
 * ## I/O
 *
 *   - Writes are atomic per-file: `write tmp → rename` to avoid leaving
 *     a half-written JSON on crash.
 *   - The index append is best-effort (`flag: 'a'`). A failed index write
 *     does not roll back the card write; the snapshot files are the
 *     source of truth.
 *
 * @module improve/scan/card-writer
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  CardIndexEventSchema,
  type CardIndexEvent,
  type DetectorResult,
  type FailureCard,
  FailureCardSchema,
  type FailureEvidence,
} from '../schemas.js';
import {
  getFailureCardJsonPath,
  getFailureCardMarkdownPath,
  getFailureCardsDir,
  getFailureCardsIndexPath,
} from '../paths.js';

/** Outcome of a single writeCard call. */
export interface WriteCardOutcome {
  slug: string;
  /** What kind of event was logged to `.index.jsonl`. */
  event: CardIndexEvent['event'];
  /** Total evidence on the card after merge. */
  occurrenceCount: number;
  /** Evidence rows added by this write (0 for merged-noop). */
  evidenceAdded: number;
  jsonPath: string;
  markdownPath: string;
}

/**
 * Merge a detector result into the on-disk card for its slug.
 *
 * Returns the outcome — useful for CLI summary rendering.
 */
export function writeCard(detection: DetectorResult): WriteCardOutcome {
  const cardsDir = getFailureCardsDir();
  if (!existsSync(cardsDir)) mkdirSync(cardsDir, { recursive: true });

  const jsonPath = getFailureCardJsonPath(detection.slug);
  const mdPath = getFailureCardMarkdownPath(detection.slug);

  const existing = readCardIfExists(jsonPath);
  const merged = mergeCard(existing, detection);

  const isCreation = existing === undefined;
  const evidenceAdded = merged.evidence.length - (existing?.evidence.length ?? 0);
  const event: CardIndexEvent['event'] = isCreation
    ? 'created'
    : evidenceAdded > 0
      ? 'updated'
      : 'merged-noop';

  // Validate before writing — catches programming errors that would leave
  // a malformed JSON on disk.
  const validated = FailureCardSchema.parse(merged);

  atomicWriteJson(jsonPath, validated);
  atomicWriteText(mdPath, renderMarkdown(validated));
  appendIndex({
    timestamp: nowIso(),
    event,
    slug: validated.slug,
    pattern: validated.pattern,
    occurrenceCount: validated.occurrenceCount,
    evidenceAdded: Math.max(0, evidenceAdded),
  });

  return {
    slug: validated.slug,
    event,
    occurrenceCount: validated.occurrenceCount,
    evidenceAdded: Math.max(0, evidenceAdded),
    jsonPath,
    markdownPath: mdPath,
  };
}

// ---------------------------------------------------------------------------
// Read / merge — exported for unit tests
// ---------------------------------------------------------------------------

/** Read a card from disk if present. Returns undefined on missing or invalid. */
export function readCardIfExists(jsonPath: string): FailureCard | undefined {
  if (!existsSync(jsonPath)) return undefined;
  try {
    const raw = readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = FailureCardSchema.safeParse(parsed);
    if (!validated.success) return undefined;
    return validated.data;
  } catch {
    return undefined;
  }
}

/**
 * Pure merge function. No I/O. Exported so tests can assert merge invariants
 * without going through the filesystem.
 *
 * Contract: see the module JSDoc "Merge semantics" section.
 */
export function mergeCard(
  existing: FailureCard | undefined,
  detection: DetectorResult,
): FailureCard {
  if (!existing) {
    // First sighting — create from detection. No notes, status default 'open'.
    return {
      schemaVersion: 1,
      slug: detection.slug,
      title: detection.title,
      pattern: detection.pattern,
      severity: detection.severity,
      status: 'open',
      firstSeen: detection.observedAt,
      lastSeen: detection.observedAt,
      occurrenceCount: detection.evidence.length,
      evidence: detection.evidence,
      detail: detection.detail,
      notes: [],
    };
  }

  // Slug must match — defensive check.
  if (existing.slug !== detection.slug) {
    throw new Error(
      `card-writer: slug mismatch on merge (existing='${existing.slug}', detection='${detection.slug}')`,
    );
  }

  const mergedEvidence = mergeEvidence(existing.evidence, detection.evidence);
  const firstSeen = minIso(existing.firstSeen, detection.observedAt);
  const lastSeen = maxIso(existing.lastSeen, detection.observedAt);
  const severity = maxSeverity(existing.severity, detection.severity);

  return {
    schemaVersion: 1,
    slug: existing.slug,
    title: detection.title, // latest title wins
    pattern: existing.pattern,
    severity,
    status: existing.status, // preserved
    firstSeen,
    lastSeen,
    occurrenceCount: mergedEvidence.length,
    evidence: mergedEvidence,
    detail: detection.detail, // replaced; see module JSDoc
    notes: existing.notes, // preserved verbatim
  };
}

/**
 * Dedupe evidence by `(sessionId, eventIndices[0])`. Same session + same
 * first-seq event = same observation. Order preserves existing entries
 * first (so re-rendered .md keeps stable layout), then new.
 */
function mergeEvidence(
  existing: FailureEvidence[],
  incoming: FailureEvidence[],
): FailureEvidence[] {
  const key = (e: FailureEvidence): string =>
    `${e.sessionId}::${e.eventIndices[0] ?? 'NA'}`;
  const seen = new Set<string>(existing.map(key));
  const merged = [...existing];
  for (const ev of incoming) {
    const k = key(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(ev);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Render a card to its human-friendly `.md` view. Pure function; tests can
 * snapshot the output. Regenerated on every write — never read back, so
 * stale `.md` files don't affect merge logic.
 */
export function renderMarkdown(card: FailureCard): string {
  const lines: string[] = [];
  lines.push(`# ${card.slug} — \`${card.severity}\` — \`${card.status}\``);
  lines.push('');
  lines.push(card.title);
  lines.push('');
  lines.push(
    `**Pattern:** \`${card.pattern}\` · **Occurrences:** ${card.occurrenceCount} · **First seen:** ${card.firstSeen} · **Last seen:** ${card.lastSeen}`,
  );
  lines.push('');

  lines.push('## Evidence');
  lines.push('');
  for (const ev of card.evidence) {
    lines.push(`### Session \`${ev.sessionId}\``);
    lines.push('');
    lines.push(`- Trace: \`${ev.tracePath}\``);
    lines.push(`- Event seqs: ${ev.eventIndices.join(', ')}`);
    if (ev.annotation) {
      lines.push(`- Note: ${ev.annotation}`);
    }
    lines.push('');
    lines.push('```jsonl');
    lines.push(ev.excerpt);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Detail');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(card.detail, null, 2));
  lines.push('```');
  lines.push('');

  lines.push('## Triage notes');
  lines.push('');
  if (card.notes.length > 0) {
    for (const note of card.notes) {
      lines.push(`- _${note.at}_ — ${note.text}`);
    }
    lines.push('');
  } else {
    lines.push('_(none — add one with `afk improve cards triage <slug> --note "…"`)_');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Index append
// ---------------------------------------------------------------------------

function appendIndex(event: CardIndexEvent): void {
  const validated = CardIndexEventSchema.parse(event);
  const path = getFailureCardsIndexPath();
  const dir = getFailureCardsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Best-effort: a single line append. Failure here doesn't roll back the
  // snapshot files written above.
  try {
    writeFileSync(path, JSON.stringify(validated) + '\n', { flag: 'a' });
  } catch {
    // intentionally swallowed — index is derived, snapshots are source of truth.
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

function nowIso(): string {
  return new Date().toISOString();
}

function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

const SEVERITY_RANK: Record<FailureCard['severity'], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function maxSeverity(a: FailureCard['severity'], b: FailureCard['severity']): FailureCard['severity'] {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// List / Show — read-side helpers for `afk improve cards`
// ---------------------------------------------------------------------------

export interface CardListEntry {
  slug: string;
  title: string;
  pattern: FailureCard['pattern'];
  severity: FailureCard['severity'];
  status: FailureCard['status'];
  occurrenceCount: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * List all cards on disk. Returns an empty array if the directory is
 * missing. Corrupt cards are silently skipped — they show up as a count
 * mismatch with `.index.jsonl` if anyone investigates.
 */
export function listCards(): CardListEntry[] {
  const dir = getFailureCardsDir();
  if (!existsSync(dir)) return [];
  const entries: CardListEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('.')) continue;
    const card = readCardIfExists(join(dir, name));
    if (!card) continue;
    entries.push({
      slug: card.slug,
      title: card.title,
      pattern: card.pattern,
      severity: card.severity,
      status: card.status,
      occurrenceCount: card.occurrenceCount,
      firstSeen: card.firstSeen,
      lastSeen: card.lastSeen,
    });
  }
  // Most recent first by lastSeen, then by slug for stability.
  entries.sort((a, b) => {
    if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? 1 : -1;
    return a.slug < b.slug ? -1 : 1;
  });
  return entries;
}

/** Read a single card by slug. Returns undefined on missing/invalid. */
export function getCard(slug: string): FailureCard | undefined {
  return readCardIfExists(getFailureCardJsonPath(slug));
}

// ---------------------------------------------------------------------------
// Regressed-card selection — read-side observability view
//
// Invariant: regression is a READ-SIDE signal only. None of the helpers below
// mutate a card, change its status, or touch scan merge semantics. A regressed
// card stays exactly as triaged on disk; we merely surface that it kept firing
// after a human closed/deferred it. This deliberately does NOT auto-reopen,
// because most `resolved` cards are resolved-as-expected (Ctrl+C aborts,
// network noise) and recur by design — auto-reopen would re-spam them.
// ---------------------------------------------------------------------------

/** Projection returned for a regressed card. Derived on read; never persisted. */
export interface RegressedCardEntry {
  slug: string;
  pattern: FailureCard['pattern'];
  severity: FailureCard['severity'];
  status: FailureCard['status'];
  /** Union evidence count (`occurrenceCount`) at time of read. */
  occurrenceCount: number;
  lastSeen: string;
  /** The most recent triage-note timestamp the recurrence is measured against. */
  latestNoteAt: string;
}

/**
 * Most recent triage-note timestamp on a card, or undefined when it has no
 * notes. Notes are not guaranteed ordered on disk, so take the max rather than
 * the last element. Pure; no I/O.
 */
export function latestNoteAt(card: FailureCard): string | undefined {
  let max: string | undefined;
  for (const note of card.notes) {
    if (max === undefined || Date.parse(note.at) > Date.parse(max)) max = note.at;
  }
  return max;
}

/**
 * A card is "regressed" when a human triaged it but it kept firing afterwards:
 *   - status is `resolved` or `deferred`, AND
 *   - it has at least one triage note, AND
 *   - `lastSeen` is strictly later than the latest triage note.
 *
 * Pure predicate; no I/O; never mutates. Timestamps are compared as epoch
 * millis (not lexically) so any RFC3339 offset form compares correctly; an
 * unparseable timestamp is treated as not-regressed (conservative).
 */
export function isRegressed(card: FailureCard): boolean {
  if (card.status !== 'resolved' && card.status !== 'deferred') return false;
  const noteAt = latestNoteAt(card);
  if (noteAt === undefined) return false;
  const last = Date.parse(card.lastSeen);
  const note = Date.parse(noteAt);
  if (Number.isNaN(last) || Number.isNaN(note)) return false;
  return last > note;
}

/**
 * Filter + project the regressed cards from a list, most-recent recurrence
 * first (then slug for stable ordering). Pure (no I/O) so the selection logic
 * is unit-testable without the filesystem.
 */
export function selectRegressed(cards: FailureCard[]): RegressedCardEntry[] {
  const out: RegressedCardEntry[] = [];
  for (const card of cards) {
    if (!isRegressed(card)) continue;
    const latest = latestNoteAt(card);
    // isRegressed guarantees a note exists; this guard satisfies the type
    // checker and stays defensive without an assertion.
    if (latest === undefined) continue;
    out.push({
      slug: card.slug,
      pattern: card.pattern,
      severity: card.severity,
      status: card.status,
      occurrenceCount: card.occurrenceCount,
      lastSeen: card.lastSeen,
      latestNoteAt: latest,
    });
  }
  out.sort((a, b) => {
    if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? 1 : -1;
    return a.slug < b.slug ? -1 : 1;
  });
  return out;
}

/**
 * Read every card from disk and return the regressed subset. Mirrors
 * {@link listCards}, but reads full cards because the regression check needs
 * `notes`, which {@link CardListEntry} omits. Missing dir → empty; corrupt
 * cards are skipped (same policy as listCards).
 */
export function listRegressedCards(): RegressedCardEntry[] {
  const dir = getFailureCardsDir();
  if (!existsSync(dir)) return [];
  const cards: FailureCard[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('.')) continue;
    const card = readCardIfExists(join(dir, name));
    if (!card) continue;
    cards.push(card);
  }
  return selectRegressed(cards);
}
