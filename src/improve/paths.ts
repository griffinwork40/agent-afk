/**
 * Path helpers for the `afk improve` self-improvement pipeline.
 *
 * All state lives under `$AFK_HOME/agent-framework/improve/`, alongside the
 * existing forge-telemetry and briefs trees. Layout:
 *
 *   $AFK_HOME/agent-framework/improve/
 *     failure-cards/                  [Phase 1A]
 *       .index.jsonl                  append-only event log
 *       <slug>.json                   machine source-of-truth
 *       <slug>.md                     human-friendly rendered view
 *     proposals/                      [Sprint 2]
 *       .index.jsonl                  append-only event log
 *       <proposal-id>.json            ImprovementProposal artifact
 *       <proposal-id>.md              human-friendly rendered view
 *     eval-cases/                     [Sprint 3 — this commit]
 *       .index.jsonl                  append-only event log
 *       <eval-case-id>.json           EvalCase artifact (the contract)
 *       <eval-case-id>.fixture.jsonl  byte-identical slice of the source trace
 *       <eval-case-id>.md             human-friendly rendered view
 *
 * Future phases will add improve-runs/, reports/, and improve-telemetry.jsonl
 * under the same root. Those are intentionally absent — this module only
 * resolves what is read or written by `scan`, `cards`, `propose`, and
 * `eval-gen`.
 *
 * The trace source is read-only from `$AFK_HOME/state/witness/<id>/trace.jsonl`
 * (see {@link getTraceDir} in src/paths.ts). The improve pipeline never
 * writes there.
 *
 * @module improve/paths
 */

import { join } from 'path';
import { getAgentFrameworkDir, getAfkStateDir } from '../paths.js';

/** Root for all improve-pipeline artifacts. */
export function getImproveRoot(): string {
  return join(getAgentFrameworkDir(), 'improve');
}

/** Directory holding `<slug>.json` + `<slug>.md` failure cards. */
export function getFailureCardsDir(): string {
  return join(getImproveRoot(), 'failure-cards');
}

/** Path to the failure-cards index JSONL (append-only event log). */
export function getFailureCardsIndexPath(): string {
  return join(getFailureCardsDir(), '.index.jsonl');
}

/** Resolve `<slug>.json` for a given card slug. No I/O performed. */
export function getFailureCardJsonPath(slug: string): string {
  return join(getFailureCardsDir(), `${slug}.json`);
}

/** Resolve `<slug>.md` for a given card slug. No I/O performed. */
export function getFailureCardMarkdownPath(slug: string): string {
  return join(getFailureCardsDir(), `${slug}.md`);
}

/** Witness-layer root: `$AFK_HOME/state/witness/`. Phase 1A reads from here. */
export function getWitnessRoot(): string {
  return join(getAfkStateDir(), 'witness');
}

// ---------------------------------------------------------------------------
// Proposals (Sprint 2)
// ---------------------------------------------------------------------------

/** Directory holding `<proposal-id>.json` + `<proposal-id>.md` proposals. */
export function getProposalsDir(): string {
  return join(getImproveRoot(), 'proposals');
}

/** Append-only event log for the proposals directory. */
export function getProposalsIndexPath(): string {
  return join(getProposalsDir(), '.index.jsonl');
}

/** Resolve `<proposal-id>.json`. No I/O. */
export function getProposalJsonPath(proposalId: string): string {
  return join(getProposalsDir(), `${proposalId}.json`);
}

/** Resolve `<proposal-id>.md`. No I/O. */
export function getProposalMarkdownPath(proposalId: string): string {
  return join(getProposalsDir(), `${proposalId}.md`);
}

// ---------------------------------------------------------------------------
// Eval cases (Sprint 3)
// ---------------------------------------------------------------------------

/**
 * Directory holding `<eval-case-id>.json`, `<eval-case-id>.fixture.jsonl`,
 * and `<eval-case-id>.md` triples.
 */
export function getEvalCasesDir(): string {
  return join(getImproveRoot(), 'eval-cases');
}

/** Append-only event log for the eval-cases directory. */
export function getEvalCasesIndexPath(): string {
  return join(getEvalCasesDir(), '.index.jsonl');
}

/** Resolve `<eval-case-id>.json`. No I/O. */
export function getEvalCaseJsonPath(evalCaseId: string): string {
  return join(getEvalCasesDir(), `${evalCaseId}.json`);
}

/**
 * Resolve `<eval-case-id>.fixture.jsonl`. No I/O.
 *
 * The fixture is the byte-identical slice of the source witness trace
 * committed at eval-gen time. After write, it is the durable contract —
 * the source trace may rotate away without invalidating the eval-case.
 */
export function getEvalCaseFixturePath(evalCaseId: string): string {
  return join(getEvalCasesDir(), `${evalCaseId}.fixture.jsonl`);
}

/** Resolve `<eval-case-id>.md`. No I/O. */
export function getEvalCaseMarkdownPath(evalCaseId: string): string {
  return join(getEvalCasesDir(), `${evalCaseId}.md`);
}
