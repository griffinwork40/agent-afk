/**
 * CLI surface for the `afk improve` self-improvement pipeline.
 *
 * Subcommands:
 *
 *   afk improve scan [--since 7d] [--write] [--min-repeats N]
 *                    [--closure-min-occurrences N] [--block-min-occurrences N]
 *                    [--only <name,name>]
 *       Scan witness traces, run every registered detector, print a
 *       summary. Default is DRY-RUN; pass `--write` to persist cards.
 *
 *   afk improve cards list [--pattern] [--severity] [--status] [--regressed] [--json]
 *       Tabular listing of all cards on disk. `--regressed` narrows to
 *       resolved/deferred cards that fired again after their latest triage
 *       note (a read-side observability view; never changes status).
 *
 *   afk improve cards show <slug> [--json]
 *       Print one card.
 *
 *   afk improve cards triage <slug> --note "..." [--status open|deferred|resolved]
 *       Append a human note and/or change status. Preserves evidence,
 *       severity, detail, and all prior notes.
 *
 *   afk improve propose <slug> [--id <override>] [--json]
 *       Generate a template-mode improvement proposal for the card and
 *       persist it under `proposals/<id>.{json,md}`. NO LLM calls; the
 *       template engine deterministically maps the card's pattern to a
 *       starter proposal a human refines before any patch.
 *
 *   afk improve proposals list [--card <slug>] [--risk <l|m|h>] [--json]
 *       Tabular listing of proposals.
 *
 *   afk improve proposals show <id> [--json]
 *       Print one proposal.
 *
 *   afk improve eval-gen <cardSlug> [--proposal <id>] [--evidence-row <i>]
 *                                   [--id <override>] [--json] [--no-write]
 *       Generate a replay-mode eval-case for a failure card. Slices a
 *       byte-identical fixture from the source witness trace, writes the
 *       eval-case contract (JSON + .md), and commits the fixture alongside.
 *       NO LLM calls; NO mutation of Sprint 2 proposal artifacts even when
 *       `--proposal` is set. NO runner — the eval-case is a contract;
 *       a later sprint adds `eval-run`.
 *
 *   afk improve eval-cases list [--card <slug>] [--pattern <name>]
 *                               [--status <state>] [--json]
 *       Tabular listing of eval-cases.
 *
 *   afk improve eval-cases show <id> [--json]
 *       Print one eval-case (markdown view by default).
 *
 *   afk improve eval-run <evalCaseIdOrCardSlug> [--id <override>] [--json]
 *                                               [--no-write]
 *       Run the smallest deterministic validation contract for an eval-case's
 *       pattern against the live codebase, and persist an EvalRun result under
 *       `eval-runs/<id>.{json,md}`. Re-verifies the eval-case's committed
 *       fixture checksum. NO LLM calls; NO patch/apply; NO fixture replay
 *       through the detector (that broader runner is reserved for a later
 *       sprint — see EvalRunSchema). The arg may be an eval-case id OR a card
 *       slug (the most recent eval-case for that card is run).
 *
 * Scope explicitly EXCLUDES: LLM-mode proposals, plan, apply, patch, fixture
 * replay through the detector, eval-link (the proposal back-fill), branch
 * creation, git operations, and PR publishing. Those are reserved for later
 * sprints behind explicit flags with hard-coded forbidden-path guardrails.
 *
 * @module cli/commands/improve
 */

import { Command } from 'commander';
import { registerScanSubcommand } from './scan.js';
import { registerCardsSubcommand } from './cards.js';
import { registerProposeSubcommand, registerProposalsSubcommand } from './propose.js';
import { registerEvalGenSubcommand, registerEvalCasesSubcommand } from './eval-gen.js';
import { registerEvalRunSubcommand } from './eval-run.js';

export { VALID_PATTERNS } from './shared.js';
export { applyEvalRunExit } from './eval-run.js';

export function registerImproveCommand(program: Command): void {
  const improve = program
    .command('improve')
    .description('Self-improvement pipeline: scan traces, triage cards, draft proposals, generate replay eval-cases.');

  registerScanSubcommand(improve);
  registerCardsSubcommand(improve);
  registerProposeSubcommand(improve);
  registerProposalsSubcommand(improve);
  registerEvalGenSubcommand(improve);
  registerEvalCasesSubcommand(improve);
  registerEvalRunSubcommand(improve);
}
