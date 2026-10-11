/**
 * SPINE.md reader/writer.
 *
 * Parses the repo's SPINE.md into a structured `SpineDocument` and serializes
 * it back to canonical markdown. The schema is intentionally minimal for v1:
 * three top-level sections (Invariants, Rejected Patterns, Taste Calls), each
 * containing entries with a stable ID, ISO date, originating session ID, and
 * a one-line description. No evidence links in v1.
 *
 * SPINE.md lives at the repo root and is git-tracked. This module never
 * auto-commits — that is the hook's responsibility.
 *
 * @module agent/spine/spine-store
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from '../../utils/atomic-write.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpineSectionName =
  | 'Invariants'
  | 'Explicitly Rejected Patterns'
  | 'Taste Calls Made';

export type SpineIdPrefix = 'INV' | 'REJ' | 'TST';

export interface SpineEntry {
  /** Stable identifier, e.g. INV-001 */
  id: string;
  /** ISO 8601 date string, e.g. 2026-09-12 */
  date: string;
  /** Session ID that originated this entry */
  sessionId: string;
  /** Single-line description */
  description: string;
}

export interface SpineSection {
  name: SpineSectionName;
  prefix: SpineIdPrefix;
  entries: SpineEntry[];
}

export interface SpineDocument {
  sections: SpineSection[];
  /** Raw trailing content after the last section (comments, notes, etc.) */
  trailer: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECTION_ORDER: Array<{ name: SpineSectionName; prefix: SpineIdPrefix }> = [
  { name: 'Invariants', prefix: 'INV' },
  { name: 'Explicitly Rejected Patterns', prefix: 'REJ' },
  { name: 'Taste Calls Made', prefix: 'TST' },
];

const SPINE_FILENAME = 'SPINE.md';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a SPINE.md string into a `SpineDocument`.
 *
 * Entry lines follow the pattern:
 *   - **INV-001** (2026-09-12, session-abc): One-line description.
 *
 * Lines that don't match are collected in `trailer`.
 */
export function parseSpine(content: string): SpineDocument {
  const sections: SpineSection[] = SECTION_ORDER.map(({ name, prefix }) => ({
    name,
    prefix,
    entries: [],
  }));

  const lines = content.split('\n');
  let currentSection: SpineSection | null = null;
  const trailerLines: string[] = [];
  let inTrailer = false;

  // Regex: - **PREFIX-NNN** (YYYY-MM-DD, sessionId): description
  const entryRe =
    /^- \*\*([A-Z]+-\d+)\*\* \((\d{4}-\d{2}-\d{2}), ([^)]+)\): (.+)$/;
  // Regex: ## Section Name
  const headingRe = /^## (.+)$/;
  // Canonical preamble lines (title + blockquote) that appear before the first
  // section heading. serializeSpine regenerates these on every write, so they
  // must be skipped here to prevent duplication on round-trip parse+serialize.
  const PREAMBLE_RE = /^(# SPINE\.md|> Auto-maintained)/;

  for (const line of lines) {
    const headingMatch = headingRe.exec(line);
    if (headingMatch) {
      const name = (headingMatch[1] ?? '').trim() as SpineSectionName;
      const found = sections.find((s) => s.name === name);
      if (found) {
        currentSection = found;
        inTrailer = false;
        continue;
      }
      // Unknown heading — treat as trailer
      inTrailer = true;
      currentSection = null;
      trailerLines.push(line);
      continue;
    }

    const entryMatch = entryRe.exec(line);
    if (entryMatch && currentSection) {
      const id = entryMatch[1] ?? '';
      const date = entryMatch[2] ?? '';
      const sessionId = entryMatch[3] ?? '';
      const description = entryMatch[4] ?? '';
      currentSection.entries.push({ id, date, sessionId, description });
      continue;
    }

    // Not a known structural line — accumulate in trailer unless inside a
    // known section (where blank/comment lines are swallowed).
    if (!currentSection || inTrailer) {
      // Skip canonical preamble lines that appear before the first section
      // heading — serializeSpine regenerates these, so capturing them here
      // would cause duplication on every round-trip write.
      if (!currentSection && !inTrailer && PREAMBLE_RE.test(line)) continue;
      trailerLines.push(line);
    }
    // Blank lines inside a known section are silently dropped on
    // re-serialization (they come back as the canonical separator).
  }

  return { sections, trailer: trailerLines.join('\n') };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a `SpineDocument` back to canonical SPINE.md markdown.
 */
export function serializeSpine(doc: SpineDocument): string {
  const parts: string[] = [];

  parts.push('# SPINE.md — Project Architecture Spine\n');
  parts.push(
    '> Auto-maintained by agent-afk at session end. ' +
      'Edit entries manually if needed; IDs are stable.\n',
  );

  for (const section of doc.sections) {
    parts.push(`\n## ${section.name}\n`);
    if (section.entries.length === 0) {
      parts.push('_(none yet)_\n');
    } else {
      for (const entry of section.entries) {
        parts.push(
          `- **${entry.id}** (${entry.date}, ${entry.sessionId}): ${entry.description}`,
        );
      }
      parts.push('');
    }
  }

  if (doc.trailer.trim()) {
    parts.push('\n' + doc.trailer.trim() + '\n');
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Next-ID generation
// ---------------------------------------------------------------------------

/**
 * Generate the next available ID for the given prefix, scanning all sections
 * in the document to avoid collisions.
 */
export function nextId(doc: SpineDocument, prefix: SpineIdPrefix): string {
  let max = 0;
  for (const section of doc.sections) {
    for (const entry of section.entries) {
      if (entry.id.startsWith(`${prefix}-`)) {
        const num = parseInt(entry.id.slice(prefix.length + 1), 10);
        if (!isNaN(num) && num > max) max = num;
      }
    }
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse SPINE.md from the repo root. Returns `null` when the file
 * does not exist (first run before `/spine init`).
 */
export function readSpine(repoRoot: string): SpineDocument | null {
  const spineFile = join(repoRoot, SPINE_FILENAME);
  if (!existsSync(spineFile)) return null;
  try {
    const content = readFileSync(spineFile, 'utf-8');
    return parseSpine(content);
  } catch {
    return null;
  }
}

/**
 * Serialize and write a `SpineDocument` to SPINE.md at the repo root.
 *
 * Uses an atomic write: serializes to a PID-namespaced temp file in the same
 * directory as SPINE.md, then `renameSync`s it into place. This ensures that
 * a process kill mid-write never leaves SPINE.md in a partially-written state.
 */
export function writeSpine(repoRoot: string, doc: SpineDocument): void {
  const spineFile = join(repoRoot, SPINE_FILENAME);
  const content = serializeSpine(doc);
  atomicWriteFile(spineFile, content);
}

/**
 * Return the section whose prefix matches. Throws if not found (programming
 * error — all three prefixes are in SECTION_ORDER).
 */
export function sectionForPrefix(
  doc: SpineDocument,
  prefix: SpineIdPrefix,
): SpineSection {
  const section = doc.sections.find((s) => s.prefix === prefix);
  if (!section) throw new Error(`No section for prefix ${prefix}`);
  return section;
}

/**
 * Add an entry to the appropriate section. Generates the next ID,
 * appends the entry, and returns the generated ID.
 */
export function addEntry(
  doc: SpineDocument,
  prefix: SpineIdPrefix,
  sessionId: string,
  description: string,
  date?: string,
): string {
  const id = nextId(doc, prefix);
  const isoDate = date ?? new Date().toISOString().slice(0, 10);
  const section = sectionForPrefix(doc, prefix);
  section.entries.push({ id, date: isoDate, sessionId, description });
  return id;
}

/**
 * Find an entry by ID across all sections. Returns `undefined` when not found.
 */
export function findEntry(
  doc: SpineDocument,
  id: string,
): SpineEntry | undefined {
  for (const section of doc.sections) {
    const found = section.entries.find((e) => e.id === id);
    if (found) return found;
  }
  return undefined;
}
