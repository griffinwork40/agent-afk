/**
 * Eval-case writer.
 *
 * Builds an {@link EvalCase} from a {@link FailureCard} and a chosen
 * evidence row, slices a byte-identical fixture out of the source witness
 * trace, and persists all three artifacts atomically:
 *
 *   <id>.json            EvalCase JSON (the contract)
 *   <id>.fixture.jsonl   byte-identical slice of the source trace
 *   <id>.md              human-friendly rendered view
 *
 * ## Invariants the writer enforces
 *
 *   1. The fixture file's bytes equal the slice the builder produced.
 *      After the atomic rename, the writer reads the fixture back, computes
 *      SHA-256, and asserts equality with `evalCase.replay.sliceSha256`.
 *      Any mismatch throws {@link EvalGenError} with code
 *      `'fixture-mismatch'`; no `.index.jsonl` event is appended.
 *
 *   2. Eval-cases are NEVER merged. Re-running `eval-gen` against the same
 *      `(card, evidence-row)` pair writes a fresh `<id>.json` because the
 *      id includes a `<yyyymmdd>-<6hex>` suffix. The previous artifact is
 *      left in place for review / `superseded` triage.
 *
 *   3. Sprint 3 does NOT mutate `proposals/<id>.json` even when the
 *      eval-case carries a `proposalId`. The forward link from a proposal's
 *      `validationPlan.evalCases` array back to the eval-case is the
 *      operator's call — a later sprint adds an atomic linker.
 *
 * ## Eval-case ID format
 *
 *   `<cardSlug>-eval-<yyyymmdd>-<6hex>`
 *
 * Cards: `repeated-tool-grep-ac8317edd609`.
 * Proposals: `repeated-tool-grep-ac8317edd609-20260524-ab12cd`.
 * Eval-cases: `repeated-tool-grep-ac8317edd609-eval-20260524-9c4d2f`.
 *
 * The `-eval-` infix makes the three kinds mechanically distinguishable
 * by name alone, without consulting the directory.
 *
 * @module improve/eval-gen/writer
 */

import { randomBytes } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { join, relative } from 'path';
import {
  EvalCaseIndexEventSchema,
  EvalCaseSchema,
  type EvalCase,
  type EvalCaseIndexEvent,
  type FailureCard,
} from '../schemas.js';
import {
  getEvalCaseFixturePath,
  getEvalCaseJsonPath,
  getEvalCaseMarkdownPath,
  getEvalCasesDir,
  getEvalCasesIndexPath,
} from '../paths.js';
import { getAfkHome } from '../../paths.js';
import { EvalGenError, sha256Bytes, sliceTracePrefix } from './replay-fixture.js';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Optional injection seams for deterministic tests. */
export interface IdContext {
  /** Override the timestamp source. Defaults to `new Date()`. */
  now?: () => Date;
  /** Override the random-suffix source. Must return 6 lowercase hex chars. */
  randomSuffix?: () => string;
}

/**
 * Build an eval-case id from a card slug.
 *
 * Format: `<cardSlug>-eval-<yyyymmdd>-<6hex>`. Guaranteed to match the
 * `^[a-z0-9][a-z0-9-]*$` regex so long as `cardSlug` already does.
 */
export function generateEvalCaseId(cardSlug: string, ctx: IdContext = {}): string {
  const now = (ctx.now ?? (() => new Date()))();
  const yyyymmdd = formatYyyymmdd(now);
  const suffix =
    ctx.randomSuffix !== undefined ? ctx.randomSuffix() : randomBytes(3).toString('hex');
  if (!/^[0-9a-f]{6}$/.test(suffix)) {
    throw new Error(
      `generateEvalCaseId: randomSuffix must be 6 lowercase hex chars (got '${suffix}')`,
    );
  }
  return `${cardSlug}-eval-${yyyymmdd}-${suffix}`;
}

function formatYyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ---------------------------------------------------------------------------
// Builder — pure modulo the disk read inside the slicer
// ---------------------------------------------------------------------------

export interface BuildEvalCaseContext {
  /** Pre-generated id. Tests inject; CLI uses {@link generateEvalCaseId}. */
  evalCaseId: string;
  /**
   * Which evidence row on the card backs this eval-case (0-based). The
   * CLI default is the LAST row (`card.evidence.length - 1`) — most-recent
   * sighting wins. Out-of-range throws `EvalGenError {'evidence-row-out-of-range'}`.
   */
  evidenceRowIndex: number;
  /**
   * Optional proposal back-reference. The writer does NOT validate that the
   * proposal exists on disk; surface the check in the CLI layer if desired.
   * `null` or omitted is the card-only case.
   */
  proposalId?: string | null;
  /** Override timestamp source. Defaults to `new Date()`. */
  now?: () => Date;
  /**
   * Resolve the absolute path of a session's source trace given the card
   * evidence row's relative tracePath. Defaults to
   * `join(getAfkHome(), evidence.tracePath)`. Tests inject for isolation.
   */
  resolveTraceAbsPath?: (relativeTracePath: string) => string;
}

export interface BuildEvalCaseResult {
  evalCase: EvalCase;
  /**
   * The byte-identical slice that must be written to
   * `evalCase.replay.fixturePath` before the JSON is persisted. The writer
   * verifies this Buffer's SHA-256 against `evalCase.replay.sliceSha256`.
   */
  sliceBytes: Buffer;
}

/**
 * Build an eval-case + fixture bytes from a card. Pure modulo the disk
 * read the slicer performs.
 *
 * Slice rule (Sprint 3): full prefix from line 1 through the line carrying
 * `max(evidence.eventIndices)`. Documented in {@link EvalReplaySchema}.
 *
 * @throws EvalGenError {'evidence-row-out-of-range'} index ≥ card.evidence.length
 * @throws EvalGenError {'source-not-found' | 'seq-not-found' | …} from the slicer
 */
export function buildEvalCase(
  card: FailureCard,
  ctx: BuildEvalCaseContext,
): BuildEvalCaseResult {
  if (ctx.evidenceRowIndex < 0 || ctx.evidenceRowIndex >= card.evidence.length) {
    throw new EvalGenError(
      `buildEvalCase: evidence row ${ctx.evidenceRowIndex} out of range (card has ${card.evidence.length} row(s))`,
      'evidence-row-out-of-range',
    );
  }
  const evidence = card.evidence[ctx.evidenceRowIndex]!;
  if (evidence.eventIndices.length === 0) {
    // Schema enforces .min(1) but defensively guard against runtime drift.
    throw new EvalGenError(
      `buildEvalCase: evidence row ${ctx.evidenceRowIndex} has no eventIndices`,
      'seq-not-found',
    );
  }

  const endSeq = Math.max(...evidence.eventIndices);
  const resolveAbs = ctx.resolveTraceAbsPath ?? defaultResolveTraceAbsPath;
  const sourceAbsPath = resolveAbs(evidence.tracePath);
  const slice = sliceTracePrefix(sourceAbsPath, { endSeq });

  const createdAt = (ctx.now ?? (() => new Date()))().toISOString();
  const fixtureAbsPath = getEvalCaseFixturePath(ctx.evalCaseId);
  const fixtureRel = relative(getAfkHome(), fixtureAbsPath);

  // Detector / fingerprint provenance — both optional fields in `detail`.
  const detectorAtGeneration =
    typeof card.detail['detector'] === 'string'
      ? card.detail['detector']
      : card.pattern; // fall back to bare pattern id
  const fingerprintAtGeneration =
    typeof card.detail['fingerprint'] === 'string'
      ? (card.detail['fingerprint'] as string)
      : null;

  const proposalId = ctx.proposalId ?? null;

  const evalCase: EvalCase = {
    schemaVersion: 1,
    evalCaseId: ctx.evalCaseId,
    cardSlug: card.slug,
    proposalId,
    title: buildTitle(card, endSeq),
    createdAt,
    kind: 'replay',
    replay: {
      sourceSessionId: evidence.sessionId,
      sourceTracePath: evidence.tracePath,
      fixturePath: fixtureRel,
      evidenceRowIndex: ctx.evidenceRowIndex,
      evidenceEventIndices: [...evidence.eventIndices],
      sliceLineRange: { startLine: slice.startLine, endLine: slice.endLine },
      sliceLineCount: slice.sliceLineCount,
      sliceSha256: slice.sliceSha256,
    },
    assertion: {
      kind: 'pattern-absent',
      patternId: card.pattern,
      detectorVersion: detectorAtGeneration,
      rationale: buildAssertionRationale({
        patternId: card.pattern,
        detectorVersion: detectorAtGeneration,
        endSeq,
        sliceLineCount: slice.sliceLineCount,
        sessionId: evidence.sessionId,
      }),
    },
    provenance: {
      detectorAtGeneration,
      fingerprintAtGeneration,
      cardOccurrenceCountAtGeneration: card.occurrenceCount,
      cardLastSeenAtGeneration: card.lastSeen,
      generatedBy: 'replay-fixture',
    },
    status: 'draft',
    notes: [],
  };

  // Validate up-front so the writer never persists a malformed object.
  EvalCaseSchema.parse(evalCase);

  return { evalCase, sliceBytes: slice.bytes };
}

function defaultResolveTraceAbsPath(relativeTracePath: string): string {
  return join(getAfkHome(), relativeTracePath);
}

function buildTitle(card: FailureCard, endSeq: number): string {
  // Cap at the schema's 200-char limit while keeping the card title visible.
  const head = `Replay [pattern-absent]: `;
  const tail = ` (through seq ${endSeq})`;
  const budget = 200 - head.length - tail.length;
  const cardTitle = card.title.length > budget ? card.title.slice(0, budget - 1) + '…' : card.title;
  return `${head}${cardTitle}${tail}`.slice(0, 200);
}

function buildAssertionRationale(args: {
  patternId: string;
  detectorVersion: string;
  endSeq: number;
  sliceLineCount: number;
  sessionId: string;
}): string {
  const sidShort = args.sessionId.slice(0, 8);
  return (
    `After the proposed fix lands, replaying the prefix [seq 0..${args.endSeq}] ` +
    `(${args.sliceLineCount} lines, session ${sidShort}…) through ${args.detectorVersion} ` +
    `must produce zero findings for '${args.patternId}' with the fingerprint at generation time. ` +
    `**Sprint 3 ships eval-case-as-contract; the runner that enforces this lands in a later sprint.**`
  );
}

// ---------------------------------------------------------------------------
// Persister
// ---------------------------------------------------------------------------

export interface WriteEvalCaseOutcome {
  evalCaseId: string;
  jsonPath: string;
  fixturePath: string;
  markdownPath: string;
}

/**
 * Persist an eval-case to disk: fixture file first, byte-fidelity check,
 * then JSON + markdown + `.index.jsonl` append.
 *
 * **Ordering matters.** The fixture is written, renamed, read back, and
 * SHA-checked BEFORE the JSON is persisted. If the post-write SHA does
 * not match `evalCase.replay.sliceSha256`, the fixture is left on disk
 * (under its final name — atomic rename already happened) but the JSON
 * is not written and no index event is appended. The fixture's
 * stale-ness is detectable by listing the directory and finding a
 * `.fixture.jsonl` without a sibling `.json`.
 *
 * @throws EvalGenError {'fixture-mismatch'} post-write SHA disagrees
 */
export function writeEvalCase(
  evalCase: EvalCase,
  sliceBytes: Buffer,
): WriteEvalCaseOutcome {
  // Constraint: schema validates the object shape before any I/O so a bad
  // input never leaves a partial directory behind.
  const validated = EvalCaseSchema.parse(evalCase);

  const dir = getEvalCasesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const jsonPath = getEvalCaseJsonPath(validated.evalCaseId);
  const fixturePath = getEvalCaseFixturePath(validated.evalCaseId);
  const mdPath = getEvalCaseMarkdownPath(validated.evalCaseId);

  // 1. Write fixture FIRST, then verify SHA after the atomic rename. We
  //    don't write JSON until the fixture is durable + checksum-confirmed.
  atomicWriteBinary(fixturePath, sliceBytes);
  const actualSha = sha256Bytes(readFileSync(fixturePath));
  if (actualSha !== validated.replay.sliceSha256) {
    throw new EvalGenError(
      `writeEvalCase: fixture sha256 mismatch after write ` +
        `(expected ${validated.replay.sliceSha256}, got ${actualSha}, path ${fixturePath})`,
      'fixture-mismatch',
    );
  }

  // 2. Write JSON + markdown (atomic) after fixture is durable.
  atomicWriteJson(jsonPath, validated);
  atomicWriteText(mdPath, renderEvalCaseMarkdown(validated));

  // 3. Append the index event — best-effort, matching card-writer convention.
  appendIndex({
    timestamp: new Date().toISOString(),
    event: 'created',
    evalCaseId: validated.evalCaseId,
    cardSlug: validated.cardSlug,
    proposalId: validated.proposalId,
    kind: validated.kind,
  });

  return {
    evalCaseId: validated.evalCaseId,
    jsonPath,
    fixturePath,
    markdownPath: mdPath,
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

export function renderEvalCaseMarkdown(ec: EvalCase): string {
  const out: string[] = [];
  out.push(`# ${ec.evalCaseId} — \`${ec.kind}\` — \`${ec.status}\``);
  out.push('');
  out.push(ec.title);
  out.push('');
  out.push(
    `**Card:** \`${ec.cardSlug}\` · **Proposal:** ${ec.proposalId ? `\`${ec.proposalId}\`` : '_(none)_'} · **Created:** ${ec.createdAt}`,
  );
  out.push('');

  out.push('> **Sprint 3 disclaimer.** This file is a CONTRACT, not an');
  out.push('> executable. No runner consumes it yet. A future sprint will');
  out.push('> replay the fixture through the detector and assert the');
  out.push('> pattern is absent. Until then this artifact captures intent.');
  out.push('');

  out.push('## Replay fixture');
  out.push('');
  out.push(`- **Source session:** \`${ec.replay.sourceSessionId}\``);
  out.push(`- **Source trace:** \`${ec.replay.sourceTracePath}\``);
  out.push(`- **Fixture:** \`${ec.replay.fixturePath}\``);
  out.push(
    `- **Evidence row:** index ${ec.replay.evidenceRowIndex} (seqs ${ec.replay.evidenceEventIndices.join(', ')})`,
  );
  out.push(
    `- **Slice:** lines ${ec.replay.sliceLineRange.startLine}–${ec.replay.sliceLineRange.endLine} (${ec.replay.sliceLineCount} lines)`,
  );
  out.push(`- **SHA-256:** \`${ec.replay.sliceSha256}\``);
  out.push('');

  out.push('## Assertion');
  out.push('');
  out.push(`- **Kind:** \`${ec.assertion.kind}\``);
  out.push(`- **Pattern:** \`${ec.assertion.patternId}\``);
  out.push(`- **Detector:** \`${ec.assertion.detectorVersion}\``);
  out.push('');
  out.push(ec.assertion.rationale);
  out.push('');

  out.push('## Provenance');
  out.push('');
  out.push(`- **Detector at generation:** \`${ec.provenance.detectorAtGeneration}\``);
  out.push(
    `- **Fingerprint at generation:** ${ec.provenance.fingerprintAtGeneration ? `\`${ec.provenance.fingerprintAtGeneration}\`` : '_(none — detector has no fingerprint)_'}`,
  );
  out.push(
    `- **Card occurrence count at generation:** ${ec.provenance.cardOccurrenceCountAtGeneration}`,
  );
  out.push(`- **Card lastSeen at generation:** ${ec.provenance.cardLastSeenAtGeneration}`);
  out.push(`- **Generated by:** \`${ec.provenance.generatedBy}\``);
  out.push('');

  out.push('## Triage notes');
  out.push('');
  if (ec.notes.length === 0) {
    out.push('_(none)_');
  } else {
    for (const n of ec.notes) out.push(`- _${n.at}_ — ${n.text}`);
  }
  out.push('');

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Read-side helpers
// ---------------------------------------------------------------------------

export interface EvalCaseListEntry {
  evalCaseId: string;
  cardSlug: string;
  proposalId: string | null;
  title: string;
  kind: EvalCase['kind'];
  status: EvalCase['status'];
  patternId: EvalCase['assertion']['patternId'];
  createdAt: string;
  sliceSha256: string;
}

export function listEvalCases(): EvalCaseListEntry[] {
  const dir = getEvalCasesDir();
  if (!existsSync(dir)) return [];
  const entries: EvalCaseListEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('.')) continue;
    if (name.endsWith('.fixture.jsonl')) continue; // never matches .json but defensive
    const ec = readEvalCaseIfExists(join(dir, name));
    if (!ec) continue;
    entries.push({
      evalCaseId: ec.evalCaseId,
      cardSlug: ec.cardSlug,
      proposalId: ec.proposalId,
      title: ec.title,
      kind: ec.kind,
      status: ec.status,
      patternId: ec.assertion.patternId,
      createdAt: ec.createdAt,
      sliceSha256: ec.replay.sliceSha256,
    });
  }
  // Newest first by createdAt; stable by id.
  entries.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.evalCaseId < b.evalCaseId ? -1 : 1;
  });
  return entries;
}

export function getEvalCase(evalCaseId: string): EvalCase | undefined {
  return readEvalCaseIfExists(getEvalCaseJsonPath(evalCaseId));
}

export function getEvalCasesForCard(cardSlug: string): EvalCase[] {
  return listEvalCases()
    .filter((e) => e.cardSlug === cardSlug)
    .map((e) => getEvalCase(e.evalCaseId))
    .filter((ec): ec is EvalCase => ec !== undefined);
}

export function getEvalCasesForProposal(proposalId: string): EvalCase[] {
  return listEvalCases()
    .filter((e) => e.proposalId === proposalId)
    .map((e) => getEvalCase(e.evalCaseId))
    .filter((ec): ec is EvalCase => ec !== undefined);
}

function readEvalCaseIfExists(path: string): EvalCase | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = EvalCaseSchema.safeParse(parsed);
    if (!validated.success) return undefined;
    return validated.data;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Index append
// ---------------------------------------------------------------------------

function appendIndex(event: EvalCaseIndexEvent): void {
  const validated = EvalCaseIndexEventSchema.parse(event);
  const path = getEvalCasesIndexPath();
  const dir = getEvalCasesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(validated) + '\n', { flag: 'a' });
  } catch {
    // Best-effort, matching card-writer / proposal writer.
  }
}

// ---------------------------------------------------------------------------
// Atomic write helpers
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

/**
 * Atomic write for a binary payload — keeps the bytes verbatim through the
 * tmp → rename dance. The fixture file is JSONL text in practice, but we
 * write the raw Buffer to preserve byte-fidelity guarantees the slicer
 * provides (no transcoding through string).
 */
function atomicWriteBinary(path: string, bytes: Buffer): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}
