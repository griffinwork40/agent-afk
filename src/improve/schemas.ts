/**
 * Zod schemas for the Phase 1A self-improvement pipeline.
 *
 * Three contracts:
 *
 *   1. {@link FailureEvidenceSchema} — a single observation of the pattern,
 *      with enough context (sessionId, tracePath, seq indices, excerpt) to
 *      let a human re-derive the finding from the witness layer.
 *
 *   2. {@link FailureCardSchema} — the durable, slug-keyed artifact written
 *      to `failure-cards/<slug>.json`. Merged on each scan; never destructive
 *      (notes survive re-detection).
 *
 *   3. {@link DetectorResultSchema} — the in-process structure detectors
 *      return to the card writer. Stable shape across all detector kinds.
 *
 * Schema versions are explicit literals so future migrations are detectable
 * at read time without parsing the whole document.
 *
 * @module improve/schemas
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const FailurePatternSchema = z.enum([
  'repeated-tool-use',
  // Sprint 1 (this commit) adds:
  'subagent-block',     // hook_decision { hookEvent: 'SubagentStart', decision: 'block' }
  'closure-anomaly',    // closure { reason: <anything other than 'model_end_turn'> }
  // Sprint 2 adds:
  'tool-failure-density', // tool_call completed { isError: true } above threshold rate AND count
  // Future phases will add: 'schema-error-burst', 'abort-cascade',
  // 'cost-spike', 'regression'.
]);
export type FailurePattern = z.infer<typeof FailurePatternSchema>;

export const SeveritySchema = z.enum(['low', 'medium', 'high']);
export type Severity = z.infer<typeof SeveritySchema>;

export const CardStatusSchema = z.enum(['open', 'deferred', 'resolved']);
export type CardStatus = z.infer<typeof CardStatusSchema>;

// ---------------------------------------------------------------------------
// FailureEvidence — one observation of the pattern
// ---------------------------------------------------------------------------

/**
 * A single concrete sighting of the pattern. Every field except `annotation`
 * is required so a reviewer can navigate to the source line in `trace.jsonl`
 * without guessing.
 *
 * - `tracePath` is stored RELATIVE to `$AFK_HOME` so the card is portable
 *   across machines that share the same AFK home layout (and so secrets
 *   like absolute home paths aren't baked in).
 * - `eventIndices` are `seq` values from the trace, not line numbers — `seq`
 *   is the writer-owned monotonic counter and is stable under file edits.
 * - `excerpt` is a trimmed verbatim JSON line(s) from `trace.jsonl`, capped
 *   at 2 KB to keep cards human-readable.
 */
export const FailureEvidenceSchema = z.object({
  sessionId: z.string().min(1),
  tracePath: z.string().min(1),
  eventIndices: z.array(z.number().int().nonnegative()).min(1),
  excerpt: z.string().max(2000),
  annotation: z.string().optional(),
});

export type FailureEvidence = z.infer<typeof FailureEvidenceSchema>;

// ---------------------------------------------------------------------------
// FailureCard — durable artifact
// ---------------------------------------------------------------------------

/** Human note left during triage. Append-only — never overwritten by scans. */
export const TriageNoteSchema = z.object({
  at: z.string().datetime(),
  text: z.string(),
});

export type TriageNote = z.infer<typeof TriageNoteSchema>;

/**
 * The card schema. Slug-keyed; merged on re-detection by `card-writer.ts`.
 *
 * Merge rules (enforced by writer, asserted in tests):
 *   - `firstSeen` is the MIN of all observations.
 *   - `lastSeen` is the MAX of all observations.
 *   - `occurrenceCount` is the count of evidence entries (post-dedup).
 *   - `evidence` is deduped by `(sessionId, eventIndices[0])`.
 *   - `notes` from disk are PRESERVED — scans never touch them.
 *   - `status` is preserved if already set by triage; defaults to `'open'`
 *     on first creation.
 */
export const FailureCardSchema = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric with hyphens'),
  title: z.string().min(1).max(200),
  pattern: FailurePatternSchema,
  severity: SeveritySchema,
  status: CardStatusSchema,
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  occurrenceCount: z.number().int().nonnegative(),
  evidence: z.array(FailureEvidenceSchema).min(1),
  /** Detector-specific blob. Shape varies by `pattern`; consumers should
   *  guard on `pattern` before reading fields. */
  detail: z.record(z.string(), z.unknown()),
  notes: z.array(TriageNoteSchema).default([]),
});

export type FailureCard = z.infer<typeof FailureCardSchema>;

// ---------------------------------------------------------------------------
// DetectorResult — what every detector returns
// ---------------------------------------------------------------------------

/**
 * What a detector produces per finding. The card writer is responsible for
 * merging these into FailureCards on disk; detectors are pure and emit no
 * I/O.
 */
export const DetectorResultSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1).max(200),
  pattern: FailurePatternSchema,
  severity: SeveritySchema,
  /** ISO-8601. Detectors set both to the same value for a single sighting;
   *  the writer expands the window when merging with existing cards. */
  observedAt: z.string().datetime(),
  evidence: z.array(FailureEvidenceSchema).min(1),
  detail: z.record(z.string(), z.unknown()),
});

export type DetectorResult = z.infer<typeof DetectorResultSchema>;

// ---------------------------------------------------------------------------
// Index event — one line per write to .index.jsonl
// ---------------------------------------------------------------------------

/**
 * Append-only event log entry. The index is the source of truth for "what
 * happened in the cards directory", separate from the per-slug snapshot
 * files. A `created` event marks first sight of a slug; `updated` marks a
 * merge that added evidence; `merged-noop` marks a scan that found the
 * pattern again but added no new evidence (useful for staleness checks).
 */
export const CardIndexEventSchema = z.object({
  timestamp: z.string().datetime(),
  event: z.enum(['created', 'updated', 'merged-noop']),
  slug: z.string(),
  pattern: FailurePatternSchema,
  occurrenceCount: z.number().int().nonnegative(),
  /** How many evidence entries were added by this write. 0 for merged-noop. */
  evidenceAdded: z.number().int().nonnegative(),
});

export type CardIndexEvent = z.infer<typeof CardIndexEventSchema>;

// ---------------------------------------------------------------------------
// ImprovementProposal (Sprint 2 — template mode)
// ---------------------------------------------------------------------------

/**
 * Coarse classification of the suspected root cause. Used by the template
 * engine to pick a fix-sketch template; used by reviewers to filter
 * proposals.
 *
 * `unknown` is the safe default for patterns the template engine cannot
 * confidently classify; reviewers must refine it manually before any patch.
 */
export const RootCauseClassSchema = z.enum([
  'prompt-defect',
  'schema-too-strict',
  'schema-too-loose',
  'tool-output-shape',
  'hook-overreach',
  'retry-policy',
  'timeout-too-low',
  'cost-control',
  'dispatcher-bug',
  'detector-needs-tuning',
  'unknown',
]);

export type RootCauseClass = z.infer<typeof RootCauseClassSchema>;

/**
 * Per-file risk tier. `forbidden` is reserved for paths we will never let
 * a patch touch automatically (auth / billing / secrets / lockfiles); see
 * the canonical glob list in {@link DEFAULT_FORBIDDEN_PATH_GLOBS}.
 */
export const RiskTierSchema = z.enum(['safe', 'moderate', 'high', 'forbidden']);
export type RiskTier = z.infer<typeof RiskTierSchema>;

export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/**
 * A back-reference from a proposal to evidence on a failure card. The
 * `cardSlug` is denormalized so a proposal can survive a card rename
 * (slugs are stable by design, but the back-reference is explicit).
 */
export const ProposalEvidenceRefSchema = z.object({
  cardSlug: z.string(),
  /** `seq` values on the trace events backing this evidence row. */
  eventIndices: z.array(z.number().int().nonnegative()).min(1),
  annotation: z.string().optional(),
});

export type ProposalEvidenceRef = z.infer<typeof ProposalEvidenceRefSchema>;

/**
 * One file the proposal believes a fix is likely to touch.
 *
 * Template-mode proposals populate this from a static pattern→files map.
 * LLM-mode proposals (deferred — not in this sprint) will additionally
 * ground each path against `git ls-files` before write.
 */
export const LikelyFileSchema = z.object({
  /** Repo-relative path. May include glob patterns when the template can
   *  only narrow to a directory. */
  path: z.string().min(1),
  rationale: z.string(),
  riskTier: RiskTierSchema,
  confidence: ConfidenceSchema,
});

export type LikelyFile = z.infer<typeof LikelyFileSchema>;

/**
 * The validation plan a proposal commits to. Tests / smoke checks named
 * here are advisory — the (future) `validate` command will run them and
 * record results. Listed here so reviewers can sanity-check coverage
 * before any code change.
 */
export const ValidationPlanSchema = z.object({
  unitTests: z.array(z.string()),
  /** Eval-case slugs. Empty until Sprint 3's `eval-gen` lands. */
  evalCases: z.array(z.string()),
  /** Commands like `pnpm lint`, `pnpm test`, `afk doctor`. */
  smokeChecks: z.array(z.string()),
  /** Human verification steps the runner cannot automate. */
  manualChecks: z.array(z.string()),
});

export type ValidationPlan = z.infer<typeof ValidationPlanSchema>;

/**
 * Hard guardrails on which paths a future `apply` command may touch.
 * Even template-mode proposals carry these so the boundary is auditable
 * before any patching code exists.
 */
export const ScopeFreezeSchema = z.object({
  forbiddenPaths: z.array(z.string()),
  requiresExplicitApproval: z.boolean(),
});

export type ScopeFreeze = z.infer<typeof ScopeFreezeSchema>;

export const ProposalStatusSchema = z.enum([
  'draft',
  'approved',
  'rejected',
  'superseded',
]);

export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/**
 * The proposal artifact. Slug-prefixed, time-prefixed, randomly-suffixed
 * so multiple proposal attempts against the same card don't clobber one
 * another.
 *
 * Merge rules: proposals are NEVER merged. A second `propose` call against
 * the same card writes a new file with a new `proposalId`. The first
 * proposal can be marked `superseded` via `cards triage`-style flow in
 * a future sprint; this sprint never auto-supersedes.
 *
 * `generatedBy: 'template'` is the only value this sprint produces; LLM
 * mode is reserved for a later sprint and gated behind an explicit flag.
 */
export const ImprovementProposalSchema = z.object({
  schemaVersion: z.literal(1),
  proposalId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  cardSlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1).max(200),
  /** 1–3 sentences naming what the proposal believes is wrong. */
  hypothesis: z.string().min(1),
  rootCauseClass: RootCauseClassSchema,
  evidenceRefs: z.array(ProposalEvidenceRefSchema).min(1),
  /** Markdown — the prose fix sketch. Template mode emits a starter; humans
   *  refine before any patch. */
  fixSketch: z.string().min(1),
  likelyFiles: z.array(LikelyFileSchema),
  riskLevel: SeveritySchema, // reuse low|medium|high ladder
  validationPlan: ValidationPlanSchema,
  scopeFreeze: ScopeFreezeSchema,
  generatedBy: z.enum(['template', 'llm']),
  createdAt: z.string().datetime(),
  status: ProposalStatusSchema,
  notes: z.array(TriageNoteSchema).default([]),
});

export type ImprovementProposal = z.infer<typeof ImprovementProposalSchema>;

/**
 * Append-only event log for the proposals directory.
 *
 * `created` — first write of a proposalId.
 * `triaged` — a note added or status changed via `cards triage`-style flow.
 * `superseded` — explicit human marker that a later proposal replaces this.
 */
export const ProposalIndexEventSchema = z.object({
  timestamp: z.string().datetime(),
  event: z.enum(['created', 'triaged', 'superseded']),
  proposalId: z.string(),
  cardSlug: z.string(),
  generatedBy: z.enum(['template', 'llm']),
  riskLevel: SeveritySchema,
});

export type ProposalIndexEvent = z.infer<typeof ProposalIndexEventSchema>;

// ---------------------------------------------------------------------------
// EvalCase (Sprint 3 — replay-mode only)
// ---------------------------------------------------------------------------

/**
 * **An eval-case is a CONTRACT, not an executable.**
 *
 * Sprint 3 ships `afk improve eval-gen`, which writes one of these per
 * `(failure-card, evidence-row)` pair, along with a byte-identical slice of
 * the source trace committed alongside as `<id>.fixture.jsonl`. The fixture
 * is the durable artifact — once written, it is the source of truth even
 * if the original witness trace rotates away.
 *
 * **No runner exists yet.** A future sprint adds `afk improve eval-run`,
 * which will replay the fixture through the detector and assert
 * {@link EvalAssertionSchema} holds. Today the assertion is a documented
 * promise about what a future runner should check — the schema validation
 * the writer performs is purely structural.
 *
 * Eval-cases are CARD-COUPLED. `cardSlug` is required; `proposalId` is
 * optional (`null` when the eval-case was generated without naming a
 * specific fix attempt). Re-running `propose` on the same card does not
 * invalidate the eval-case — the fixture depends on the card's evidence,
 * not the proposal's `fixSketch`.
 *
 * **Sprint 3 does not mutate proposal artifacts** even when `proposalId`
 * is set. The forward link from `ImprovementProposal.validationPlan.evalCases`
 * back to the eval-case is the operator's call; a later sprint adds
 * `afk improve link eval` to do it atomically.
 */

/**
 * The replay-fixture descriptor. Exactly one source session per eval-case.
 *
 *   - `sourceSessionId` + `sourceTracePath` identify the witness trace the
 *     fixture was sliced from. `sourceTracePath` is relative to `$AFK_HOME`,
 *     matching {@link FailureEvidenceSchema.tracePath}.
 *   - `evidenceRowIndex` records WHICH evidence row on the card was chosen
 *     (cards with multiple evidence rows produce one eval-case per row, each
 *     with its own fixture).
 *   - `evidenceEventIndices` is a verbatim copy of the chosen evidence row's
 *     `eventIndices`. Provenance only — the slice is driven by `sliceLineRange`.
 *   - `sliceLineRange` is the load-bearing field: 1-based, inclusive line
 *     numbers in the SOURCE trace. The fixture file contains exactly those
 *     lines, byte-for-byte. Sprint 3's default is
 *     `{ startLine: 1, endLine: <line containing max(evidenceEventIndices)> }`
 *     — the full session prefix culminating in the pattern firing. A future
 *     windowed mode is reserved; the schema allows narrower ranges.
 *   - `sliceSha256` is a checksum of the fixture file's bytes. The writer
 *     verifies it after write; a future eval-runner re-verifies at read.
 *
 * `fixturePath` is the AFK-relative path to the committed fixture file.
 * Convention: `agent-framework/improve/eval-cases/<evalCaseId>.fixture.jsonl`.
 */
export const EvalReplaySchema = z.object({
  sourceSessionId: z.string().min(1),
  sourceTracePath: z.string().min(1),
  fixturePath: z.string().min(1),
  evidenceRowIndex: z.number().int().nonnegative(),
  evidenceEventIndices: z.array(z.number().int().nonnegative()).min(1),
  sliceLineRange: z.object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
  sliceLineCount: z.number().int().positive(),
  sliceSha256: z.string().regex(/^[0-9a-f]{64}$/, 'sliceSha256 must be 64 lowercase hex chars'),
});

export type EvalReplay = z.infer<typeof EvalReplaySchema>;

/**
 * The assertion the future runner is supposed to check. Sprint 3 emits
 * `'pattern-absent'` exclusively: replaying the fixture through the named
 * detector after the fix lands must produce zero findings for `patternId`.
 *
 * Reserved kinds (not emitted this sprint):
 *   - `'pattern-present'`   — known-good regression check.
 *   - `'detector-fires-with-fingerprint'` — exact-match assertion.
 *
 * `detectorVersion` snapshots the detector identity at generation time
 * (e.g. `'repeated-tool-use@v1'`). The runner uses it to pick the right
 * detector when replaying; a version bump on the detector invalidates the
 * eval-case (which the runner detects and reports rather than silently
 * passing).
 *
 * `rationale` is human-readable and intentionally includes the
 * "no runner yet" disclaimer in artifacts written this sprint — readers
 * see the caveat in the JSON without having to grep docstrings.
 */
export const EvalAssertionSchema = z.object({
  kind: z.literal('pattern-absent'),
  patternId: FailurePatternSchema,
  detectorVersion: z.string().min(1),
  rationale: z.string().min(1),
});

export type EvalAssertion = z.infer<typeof EvalAssertionSchema>;

/** Provenance snapshot — what the card looked like at generation time. */
export const EvalProvenanceSchema = z.object({
  detectorAtGeneration: z.string().min(1),
  /** Detector-specific fingerprint if available (repeated-tool-use,
   *  subagent-block); `null` for detectors that have no fingerprint
   *  (closure-anomaly). */
  fingerprintAtGeneration: z.string().nullable(),
  cardOccurrenceCountAtGeneration: z.number().int().nonnegative(),
  cardLastSeenAtGeneration: z.string().datetime(),
  /** Sprint 3 emits `'replay-fixture'` exclusively. Synthetic mode is reserved. */
  generatedBy: z.literal('replay-fixture'),
});

export type EvalProvenance = z.infer<typeof EvalProvenanceSchema>;

/** Status lifecycle, mirroring {@link ProposalStatusSchema}. */
export const EvalCaseStatusSchema = z.enum([
  'draft',
  'approved',
  'rejected',
  'superseded',
]);

export type EvalCaseStatus = z.infer<typeof EvalCaseStatusSchema>;

/**
 * The eval-case artifact. Persisted at
 * `agent-framework/improve/eval-cases/<evalCaseId>.json` with a sibling
 * `<evalCaseId>.fixture.jsonl` (the byte-identical trace slice) and a
 * regenerated `<evalCaseId>.md` view.
 *
 * **Never merged.** Each `eval-gen` call writes a new artifact. Re-running
 * against the same card + evidence row produces a fresh `evalCaseId` (a
 * different `<yyyymmdd>-<6hex>` suffix); the previous artifact is left in
 * place for review / `superseded` triage.
 *
 * `kind: 'replay'` is the discriminator — reserved literally so a future
 * synthetic-mode eval-case can sit alongside under the same schema root
 * without a breaking version bump.
 *
 * **`proposalId` is informational.** Sprint 3's writer records the link
 * here but does NOT modify the proposal's
 * `validationPlan.evalCases` array. That back-fill is a deliberate
 * deferral — a future sprint adds it as an atomic, auditable operation.
 */
export const EvalCaseSchema = z.object({
  schemaVersion: z.literal(1),
  evalCaseId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'evalCaseId must be lowercase alphanumeric with hyphens'),
  cardSlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Optional back-reference to a proposal. `null` when the eval-case was
   *  generated card-only. Sprint 3 never mutates the proposal JSON. */
  proposalId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).nullable(),
  title: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  kind: z.literal('replay'),
  replay: EvalReplaySchema,
  assertion: EvalAssertionSchema,
  provenance: EvalProvenanceSchema,
  status: EvalCaseStatusSchema,
  notes: z.array(TriageNoteSchema).default([]),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;

/**
 * Append-only event log for the eval-cases directory.
 *
 * `created`    — first write of an `evalCaseId`.
 * `triaged`    — note added or status changed (future triage flow).
 * `superseded` — explicit human marker that a later eval-case replaces this.
 */
export const EvalCaseIndexEventSchema = z.object({
  timestamp: z.string().datetime(),
  event: z.enum(['created', 'triaged', 'superseded']),
  evalCaseId: z.string(),
  cardSlug: z.string(),
  /** `null` when the eval-case is card-only. */
  proposalId: z.string().nullable(),
  kind: z.literal('replay'),
});

export type EvalCaseIndexEvent = z.infer<typeof EvalCaseIndexEventSchema>;

// ---------------------------------------------------------------------------
// Canonical forbidden-path globs (Sprint 2)
// ---------------------------------------------------------------------------

/**
 * Default forbidden glob list. Template-mode proposals populate
 * `scopeFreeze.forbiddenPaths` from this. The list is intentionally
 * conservative — adding paths is cheap, removing them later requires a
 * deliberate audit. No proposal this sprint exposes a way to shrink the
 * list at the CLI surface; that's a v0.2 concern with explicit approval.
 */
export const DEFAULT_FORBIDDEN_PATH_GLOBS: readonly string[] = Object.freeze([
  // Authentication, billing, secrets — never auto-edit.
  '**/auth/**',
  '**/billing/**',
  '**/secrets/**',
  '**/credentials*',
  '.env',
  '.env.*',
  // Lockfiles + dependency manifests — touching these has out-of-band effects.
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  // Build / deploy artifacts and CI plumbing.
  '.github/workflows/**',
  'dist/**',
  'build/**',
  'node_modules/**',
  // Repo / SCM internals.
  '.git/**',
  // User-scope AFK config and any cached credentials.
  '**/.afk/config/**',
  '**/.afk/state/**',
]);

