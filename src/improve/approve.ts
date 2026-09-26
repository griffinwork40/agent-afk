/**
 * Approval operations for improvement proposals and eval-cases.
 *
 * `afk improve approve <slug>` marks a proposal or eval-case as `approved`,
 * recording who approved and when. The slug may be either a proposal id
 * (contains `-<yyyymmdd>-<6hex>` suffix) or an eval-case id (contains
 * `-eval-<yyyymmdd>-<6hex>` suffix).
 *
 * ## Schema contract
 *
 * Both {@link ImprovementProposalSchema} and {@link EvalCaseSchema} already
 * carry a `status` field whose union includes `'approved'`. This module
 * transitions that field from `'draft'` to `'approved'` (other `draft`
 * transitions are also permitted for correction flows). The approval is
 * recorded as a {@link TriageNote} so it appears inline in the human-readable
 * `.md` view and is preserved by future scans.
 *
 * ## Atomic write semantics
 *
 * Read-modify-write via {@link atomicWriteFile} (write-tmp → rename), matching
 * the pattern established in `triage.ts`, `propose/writer.ts`, and
 * `eval-gen/writer.ts`. The `.index.jsonl` event log is appended with a
 * `'triaged'` event for the relevant artifact type.
 *
 * @module improve/approve
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  EvalCaseSchema,
  ImprovementProposalSchema,
  ProposalIndexEventSchema,
  EvalCaseIndexEventSchema,
  type EvalCase,
  type EvalCaseStatus,
  type ImprovementProposal,
  type ProposalStatus,
  type TriageNote,
} from './schemas.js';
import {
  getEvalCaseJsonPath,
  getEvalCaseMarkdownPath,
  getEvalCasesDir,
  getEvalCasesIndexPath,
  getProposalJsonPath,
  getProposalMarkdownPath,
  getProposalsDir,
  getProposalsIndexPath,
} from './paths.js';
import { getProposal } from './propose/writer.js';
import { renderProposalMarkdown } from './propose/writer.js';
import { getEvalCase, renderEvalCaseMarkdown } from './eval-gen/writer.js';
import { atomicWriteFile } from '../utils/envFile.js';
import { appendJsonlIndex } from './_lib/writer-utils.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ApproveError extends Error {
  constructor(
    public readonly code:
      | 'not-found'
      | 'ambiguous-slug'
      | 'already-approved'
      | 'terminal-status'
      | 'invalid-transition',
    message: string,
  ) {
    super(message);
    this.name = 'ApproveError';
  }
}

// ---------------------------------------------------------------------------
// Artifact kind discriminator
// ---------------------------------------------------------------------------

/** Which artifact type a slug resolved to. */
export type ArtifactKind = 'proposal' | 'eval-case';

// ---------------------------------------------------------------------------
// Outcome shape
// ---------------------------------------------------------------------------

export interface ApproveOutcome {
  slug: string;
  kind: ArtifactKind;
  previousStatus: ProposalStatus | EvalCaseStatus;
  newStatus: 'approved';
  approvedAt: string;
  approvedBy: string;
  jsonPath: string;
  markdownPath: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ApproveOptions {
  /**
   * Free-form identity of the approver. Defaults to the OS user (via
   * `env.USER` / `env.USERNAME`) or `'unknown'` when the env var is absent.
   */
  approvedBy?: string;
  /**
   * Override the "now" timestamp. Tests inject for determinism; production
   * always passes `undefined` → `new Date().toISOString()`.
   */
  now?: () => Date;
  /**
   * Force approval even when the artifact is already `approved`.
   * By default a re-approve call throws `ApproveError('already-approved')`.
   */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Approve a proposal or eval-case identified by `slug`.
 *
 * Resolution order:
 *   1. Try the slug as a proposal id (looks up `proposals/<slug>.json`).
 *   2. If not found, try as an eval-case id (looks up `eval-cases/<slug>.json`).
 *   3. If neither resolves, throw `ApproveError('not-found')`.
 *
 * Only artifacts in `draft`, `rejected`, or `superseded` status may be
 * approved. A `terminal-status` error is thrown for artifacts that are
 * already in a non-upgradeable state (currently none — all statuses are
 * reversible at human discretion for correction flows, but `already-approved`
 * is surfaced without `--force` so the operator notices the no-op).
 */
export function approveArtifact(slug: string, options: ApproveOptions = {}): ApproveOutcome {
  const approvedBy =
    options.approvedBy ?? env.USER ?? env.USERNAME ?? 'unknown';
  const approvedAt = (options.now ?? (() => new Date()))().toISOString();

  // Try proposal first, then eval-case.
  const proposal = getProposal(slug);
  if (proposal !== undefined) {
    return approveProposal(proposal, { approvedBy, approvedAt, force: options.force });
  }

  const evalCase = getEvalCase(slug);
  if (evalCase !== undefined) {
    return approveEvalCase(evalCase, { approvedBy, approvedAt, force: options.force });
  }

  throw new ApproveError(
    'not-found',
    `No proposal or eval-case found with id '${slug}'. ` +
      `Run 'afk improve proposals list' or 'afk improve eval-cases list' to enumerate artifacts.`,
  );
}

// ---------------------------------------------------------------------------
// Proposal approval
// ---------------------------------------------------------------------------

function approveProposal(
  proposal: ImprovementProposal,
  ctx: { approvedBy: string; approvedAt: string; force?: boolean },
): ApproveOutcome {
  if (proposal.status === 'approved' && !ctx.force) {
    throw new ApproveError(
      'already-approved',
      `Proposal '${proposal.proposalId}' is already approved (approved). ` +
        `Pass --force to re-approve (e.g. to update the approvedBy note).`,
    );
  }

  const approvalNote: TriageNote = {
    at: ctx.approvedAt,
    text: `Approved by ${ctx.approvedBy}.`,
  };

  const next: ImprovementProposal = {
    ...proposal,
    status: 'approved',
    notes: [...proposal.notes, approvalNote],
  };

  const validated = ImprovementProposalSchema.parse(next);

  const jsonPath = getProposalJsonPath(validated.proposalId);
  const mdPath = getProposalMarkdownPath(validated.proposalId);

  ensureDir(jsonPath);
  atomicWriteFile(jsonPath, JSON.stringify(validated, null, 2), 0o666);
  atomicWriteFile(mdPath, renderProposalMarkdown(validated), 0o666);

  // Append a 'triaged' event to the proposals index.
  appendJsonlIndex(
    ProposalIndexEventSchema,
    getProposalsDir(),
    getProposalsIndexPath(),
    {
      timestamp: ctx.approvedAt,
      event: 'triaged',
      proposalId: validated.proposalId,
      cardSlug: validated.cardSlug,
      generatedBy: validated.generatedBy,
      riskLevel: validated.riskLevel,
    },
  );

  return {
    slug: validated.proposalId,
    kind: 'proposal',
    previousStatus: proposal.status,
    newStatus: 'approved',
    approvedAt: ctx.approvedAt,
    approvedBy: ctx.approvedBy,
    jsonPath,
    markdownPath: mdPath,
  };
}

// ---------------------------------------------------------------------------
// Eval-case approval
// ---------------------------------------------------------------------------

function approveEvalCase(
  evalCase: EvalCase,
  ctx: { approvedBy: string; approvedAt: string; force?: boolean },
): ApproveOutcome {
  if (evalCase.status === 'approved' && !ctx.force) {
    throw new ApproveError(
      'already-approved',
      `Eval-case '${evalCase.evalCaseId}' is already approved. ` +
        `Pass --force to re-approve (e.g. to update the approvedBy note).`,
    );
  }

  const approvalNote: TriageNote = {
    at: ctx.approvedAt,
    text: `Approved by ${ctx.approvedBy}.`,
  };

  const next: EvalCase = {
    ...evalCase,
    status: 'approved',
    notes: [...evalCase.notes, approvalNote],
  };

  const validated = EvalCaseSchema.parse(next);

  const jsonPath = getEvalCaseJsonPath(validated.evalCaseId);
  const mdPath = getEvalCaseMarkdownPath(validated.evalCaseId);

  ensureDir(jsonPath);
  atomicWriteFile(jsonPath, JSON.stringify(validated, null, 2), 0o666);
  atomicWriteFile(mdPath, renderEvalCaseMarkdown(validated), 0o666);

  // Append a 'triaged' event to the eval-cases index.
  appendJsonlIndex(
    EvalCaseIndexEventSchema,
    getEvalCasesDir(),
    getEvalCasesIndexPath(),
    {
      timestamp: ctx.approvedAt,
      event: 'triaged',
      evalCaseId: validated.evalCaseId,
      cardSlug: validated.cardSlug,
      proposalId: validated.proposalId,
      kind: validated.kind,
    },
  );

  return {
    slug: validated.evalCaseId,
    kind: 'eval-case',
    previousStatus: evalCase.status,
    newStatus: 'approved',
    approvedAt: ctx.approvedAt,
    approvedBy: ctx.approvedBy,
    jsonPath,
    markdownPath: mdPath,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
