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
import { handleCommandError } from '../errors/index.js';
import { scanWitness, parseDuration } from '../../improve/scan/reader.js';
import { DEFAULT_MIN_REPEATS } from '../../improve/scan/detectors/repeated-tool-use.js';
import { DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES } from '../../improve/scan/detectors/closure-anomaly.js';
import { DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES } from '../../improve/scan/detectors/subagent-block.js';
import {
  DEFAULT_TOOL_FAILURE_MIN_FAILURES,
  DEFAULT_TOOL_FAILURE_MIN_RATE,
} from '../../improve/scan/detectors/tool-failure-density.js';
import {
  knownDetectorNames,
  runAllDetectors,
  disabledByDefaultDetectorNames,
  type DetectorOptions,
} from '../../improve/scan/detectors/index.js';
import { writeCard, listCards, getCard, listRegressedCards } from '../../improve/scan/card-writer.js';
import type { RegressedCardEntry } from '../../improve/scan/card-writer.js';
import { renderMarkdown } from '../../improve/scan/card-writer.js';
import { triageCard, TriageError } from '../../improve/triage.js';
import type { CardStatus } from '../../improve/schemas.js';
import { proposeFromCard } from '../../improve/propose/template-engine.js';
import {
  generateProposalId,
  getProposal,
  listProposals,
  renderProposalMarkdown,
  writeProposal,
} from '../../improve/propose/writer.js';
import { EvalGenError } from '../../improve/eval-gen/replay-fixture.js';
import {
  buildEvalCase,
  generateEvalCaseId,
  getEvalCase,
  getEvalCasesForCard,
  listEvalCases,
  renderEvalCaseMarkdown,
  writeEvalCase,
} from '../../improve/eval-gen/writer.js';
import {
  generateEvalRunId,
  renderEvalRunMarkdown,
  runEvalCase,
  writeEvalRun,
} from '../../improve/eval-run/runner.js';
import { knownContractIds } from '../../improve/eval-run/contracts.js';
import type { EvalCase, EvalCaseStatus, EvalRun, FailurePattern } from '../../improve/schemas.js';

const VALID_STATUSES: readonly CardStatus[] = ['open', 'deferred', 'resolved'];
const VALID_EVAL_STATUSES: readonly EvalCaseStatus[] = [
  'draft',
  'approved',
  'rejected',
  'superseded',
];
const VALID_PATTERNS: readonly FailurePattern[] = [
  'repeated-tool-use',
  'subagent-block',
  'closure-anomaly',
];

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

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

function registerScanSubcommand(improve: Command): void {
  improve
    .command('scan')
    .description(
      'Run registered detectors against witness traces. Dry-run by default.\n' +
      `  Some detectors are disabled by default (pass --include-disabled to enable): ${disabledByDefaultDetectorNames().join(', ')}.`,
    )
    .option('--since <duration>', 'Only scan sessions newer than this (e.g. 7d, 24h, all)', '7d')
    .option('--write', 'Persist failure cards to disk. Without this flag, scan is dry-run.', false)
    .option(
      '--min-repeats <n>',
      `repeated-tool-use threshold (default ${DEFAULT_MIN_REPEATS})`,
      String(DEFAULT_MIN_REPEATS),
    )
    .option(
      '--closure-min-occurrences <n>',
      `closure-anomaly threshold (default ${DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES})`,
      String(DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES),
    )
    .option(
      '--block-min-occurrences <n>',
      `subagent-block threshold (default ${DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES})`,
      String(DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES),
    )
    .option(
      '--tool-failure-min-failures <n>',
      `tool-failure-density absolute count threshold (default ${DEFAULT_TOOL_FAILURE_MIN_FAILURES})`,
      String(DEFAULT_TOOL_FAILURE_MIN_FAILURES),
    )
    .option(
      '--tool-failure-min-rate <rate>',
      `tool-failure-density rate threshold, 0–1 (default ${DEFAULT_TOOL_FAILURE_MIN_RATE})`,
      String(DEFAULT_TOOL_FAILURE_MIN_RATE),
    )
    .option(
      '--only <names>',
      `Comma-separated detector names to run (any of: ${knownDetectorNames().join(', ')})`,
    )
    .option(
      '--include-disabled',
      `Run detectors marked disabled-by-default (currently: ${disabledByDefaultDetectorNames().join(', ')})`,
      false,
    )
    .action(
      (opts: {
        since: string;
        write: boolean;
        minRepeats: string;
        closureMinOccurrences: string;
        blockMinOccurrences: string;
        toolFailureMinFailures: string;
        toolFailureMinRate: string;
        only?: string;
        includeDisabled: boolean;
      }) => {
        try {
          const minRepeats = parsePositiveInt(opts.minRepeats, 'min-repeats', 2);
          const closureMin = parsePositiveInt(
            opts.closureMinOccurrences,
            'closure-min-occurrences',
            1,
          );
          const blockMin = parsePositiveInt(opts.blockMinOccurrences, 'block-min-occurrences', 1);
          const tfMinFailures = parsePositiveInt(
            opts.toolFailureMinFailures,
            'tool-failure-min-failures',
            1,
          );
          const tfMinRate = parseRate(opts.toolFailureMinRate, 'tool-failure-min-rate');

          let enabled: Set<string> | undefined;
          if (opts.only) {
            const requested = opts.only.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            const known = new Set(knownDetectorNames());
            const unknown = requested.filter((n) => !known.has(n));
            if (unknown.length > 0) {
              console.error(
                `Unknown detector(s): ${unknown.join(', ')}. Known: ${knownDetectorNames().join(', ')}`,
              );
              process.exit(2);
            }
            enabled = new Set(requested);
          }

          let sinceMs: number | undefined;
          if (opts.since && opts.since !== 'all') {
            const ms = parseDuration(opts.since);
            if (ms === undefined) {
              console.error(
                `Invalid --since: '${opts.since}'. Use forms like '7d', '24h', '30m', '3600s', or 'all'.`,
              );
              process.exit(2);
            }
            sinceMs = Date.now() - ms;
          }

          const scan = scanWitness({ sinceMs });
          const detectorOptions: DetectorOptions = {
            minRepeats,
            closureAnomalyMinOccurrences: closureMin,
            subagentBlockMinOccurrences: blockMin,
            toolFailureMinFailures: tfMinFailures,
            toolFailureMinRate: tfMinRate,
          };
          const detections = runAllDetectors(
            scan.sessions,
            detectorOptions,
            enabled,
            opts.includeDisabled,
          );

          console.log(`Scanned ${scan.sessionsScanned} sessions`);
          if (scan.sessionsSkippedOld > 0) {
            console.log(`  ↳ skipped ${scan.sessionsSkippedOld} older than --since`);
          }
          if (scan.sessionsSkippedEmpty > 0) {
            console.log(`  ↳ skipped ${scan.sessionsSkippedEmpty} with missing/unreadable trace.jsonl`);
          }
          if (scan.invalidLineCount > 0) {
            console.log(`  ⚠ ${scan.invalidLineCount} invalid JSONL lines skipped`);
          }

          // Surface a note when disabled-by-default detectors were silently skipped.
          const disabled = disabledByDefaultDetectorNames();
          if (!opts.only && !opts.includeDisabled && disabled.length > 0) {
            console.log(
              `Skipped ${disabled.length} detectors (disabled by default — pass --only or --include-disabled): ${disabled.join(', ')}`,
            );
          }

          // Per-pattern summary.
          const byPattern = new Map<string, number>();
          for (const d of detections) {
            byPattern.set(d.pattern, (byPattern.get(d.pattern) ?? 0) + 1);
          }
          console.log(`Detections: ${detections.length}`);
          for (const [pattern, count] of byPattern.entries()) {
            console.log(`  ↳ ${pattern}: ${count}`);
          }

          if (detections.length === 0) {
            if (opts.write) console.log('No cards written.');
            return;
          }

          for (const d of detections) {
            console.log(`  • ${d.slug}  [${d.severity}]  ${d.pattern}  evidence=${d.evidence.length}`);
          }

          if (!opts.write) {
            console.log('');
            console.log('(dry-run — pass --write to persist cards)');
            return;
          }

          let created = 0;
          let updated = 0;
          let noop = 0;
          for (const d of detections) {
            const outcome = writeCard(d);
            if (outcome.event === 'created') created += 1;
            else if (outcome.event === 'updated') updated += 1;
            else noop += 1;
          }
          console.log('');
          console.log(`Wrote cards: ${created} created, ${updated} updated, ${noop} no-op merges.`);
        } catch (err) {
          handleCommandError(err);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// cards (group)
// ---------------------------------------------------------------------------

/**
 * Render the `cards list --regressed` view: resolved/deferred cards that kept
 * firing after their latest triage note. Read-only — surfaces an observability
 * signal, never changes status. Composes with --pattern/--severity/--status.
 */
function renderRegressedList(opts: {
  pattern?: string;
  severity?: string;
  status?: string;
  json: boolean;
}): void {
  let rows: RegressedCardEntry[] = listRegressedCards();
  if (opts.pattern) rows = rows.filter((e) => e.pattern === opts.pattern);
  if (opts.severity) rows = rows.filter((e) => e.severity === opts.severity);
  if (opts.status) rows = rows.filter((e) => e.status === opts.status);

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(
      'No regressed cards found (no resolved/deferred card has fired since its latest triage note).',
    );
    return;
  }

  const header =
    'SLUG                                              | PATTERN              | SEV    | STATUS    | N    | LAST SEEN                | LATEST NOTE';
  const sep = '-'.repeat(header.length);
  console.log(`${rows.length} regressed card(s): triaged, then fired again afterwards.`);
  console.log(header);
  console.log(sep);
  for (const e of rows) {
    console.log(
      [
        e.slug.padEnd(50).slice(0, 50),
        e.pattern.padEnd(20),
        e.severity.padEnd(6),
        e.status.padEnd(9),
        String(e.occurrenceCount).padEnd(4),
        e.lastSeen.padEnd(24),
        e.latestNoteAt,
      ].join(' | '),
    );
  }
}

function registerCardsSubcommand(improve: Command): void {
  const cards = improve
    .command('cards')
    .description('Inspect and triage failure cards written by `afk improve scan`');

  cards
    .command('list')
    .description('List all failure cards, newest first')
    .option('--pattern <name>', 'Filter by pattern name')
    .option('--severity <level>', 'Filter by severity: low | medium | high')
    .option('--status <state>', 'Filter by status: open | deferred | resolved')
    .option(
      '--regressed',
      'Only show resolved/deferred cards that fired again after their latest triage note',
      false,
    )
    .option('--json', 'Emit JSON instead of a table', false)
    .action(
      (opts: {
        pattern?: string;
        severity?: string;
        status?: string;
        regressed: boolean;
        json: boolean;
      }) => {
        try {
          if (opts.regressed) {
            renderRegressedList(opts);
            return;
          }

          let entries = listCards();
          if (opts.pattern) entries = entries.filter((e) => e.pattern === opts.pattern);
          if (opts.severity) entries = entries.filter((e) => e.severity === opts.severity);
          if (opts.status) entries = entries.filter((e) => e.status === opts.status);

          if (opts.json) {
            console.log(JSON.stringify(entries, null, 2));
            return;
          }

          if (entries.length === 0) {
            console.log('No failure cards found.');
            return;
          }

          const header =
            'SLUG                                              | PATTERN              | SEV    | STATUS    | N    | LAST SEEN';
          const sep = '-'.repeat(header.length);
          console.log(header);
          console.log(sep);
          for (const e of entries) {
            console.log(
              [
                e.slug.padEnd(50).slice(0, 50),
                e.pattern.padEnd(20),
                e.severity.padEnd(6),
                e.status.padEnd(9),
                String(e.occurrenceCount).padEnd(4),
                e.lastSeen,
              ].join(' | '),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      },
    );

  cards
    .command('show <slug>')
    .description('Print a failure card by slug')
    .option('--json', 'Emit raw JSON instead of rendered markdown', false)
    .action((slug: string, opts: { json: boolean }) => {
      try {
        const card = getCard(slug);
        if (!card) {
          console.error(`Card not found: ${slug}`);
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify(card, null, 2));
          return;
        }
        console.log(renderMarkdown(card));
      } catch (err) {
        handleCommandError(err);
      }
    });

  cards
    .command('triage <slug>')
    .description('Append a human note and/or change status on a failure card')
    .option('--note <text>', 'Note text to append (non-empty)')
    .option('--status <state>', `New status (one of: ${VALID_STATUSES.join(', ')})`)
    .option('--json', 'Emit the resulting card as JSON', false)
    .action(
      (slug: string, opts: { note?: string; status?: string; json: boolean }) => {
        try {
          let status: CardStatus | undefined;
          if (opts.status !== undefined) {
            if (!VALID_STATUSES.includes(opts.status as CardStatus)) {
              console.error(
                `Invalid --status: '${opts.status}'. Must be one of: ${VALID_STATUSES.join(', ')}`,
              );
              process.exit(2);
            }
            status = opts.status as CardStatus;
          }

          const outcome = triageCard(slug, {
            ...(opts.note !== undefined ? { note: opts.note } : {}),
            ...(status !== undefined ? { status } : {}),
          });

          if (opts.json) {
            console.log(JSON.stringify(outcome.card, null, 2));
            return;
          }

          const parts: string[] = [];
          if (outcome.noteAdded) parts.push('note appended');
          if (outcome.statusChanged) {
            parts.push(
              `status: ${outcome.statusChanged.from} → ${outcome.statusChanged.to}`,
            );
          }
          console.log(`Triaged ${slug}: ${parts.join(' · ')}`);
          console.log(`  json: ${outcome.jsonPath}`);
          console.log(`  md:   ${outcome.markdownPath}`);
        } catch (err) {
          if (err instanceof TriageError) {
            console.error(`triage failed [${err.code}]: ${err.message}`);
            process.exit(err.code === 'card-not-found' ? 1 : 2);
          }
          handleCommandError(err);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// propose (template mode only)
// ---------------------------------------------------------------------------

function registerProposeSubcommand(improve: Command): void {
  improve
    .command('propose <slug>')
    .description(
      'Generate a template-mode improvement proposal for a failure card. No LLM calls.',
    )
    .option('--id <override>', 'Override the auto-generated proposal id')
    .option('--json', 'Emit the proposal JSON to stdout (still writes to disk)', false)
    .option(
      '--no-write',
      'Render the proposal without persisting to disk (preview mode)',
    )
    .action(
      (
        slug: string,
        opts: { id?: string; json: boolean; write: boolean },
      ) => {
        try {
          const card = getCard(slug);
          if (!card) {
            console.error(`Card not found: ${slug}`);
            process.exit(1);
          }

          const proposalId = opts.id ?? generateProposalId(slug);
          const proposal = proposeFromCard(card, { proposalId });

          // The --no-write flag means commander sets opts.write = false.
          if (opts.write === false) {
            if (opts.json) {
              console.log(JSON.stringify(proposal, null, 2));
            } else {
              console.log('(preview — not persisted; remove --no-write to save)');
              console.log('');
              console.log(renderProposalMarkdown(proposal));
            }
            return;
          }

          const outcome = writeProposal(proposal);

          if (opts.json) {
            console.log(JSON.stringify({ ...proposal, _paths: outcome }, null, 2));
            return;
          }

          console.log(`Wrote proposal: ${outcome.proposalId}`);
          console.log(`  json: ${outcome.jsonPath}`);
          console.log(`  md:   ${outcome.markdownPath}`);
          console.log(
            `  risk: ${proposal.riskLevel} · root cause: ${proposal.rootCauseClass} · approval required: ${proposal.scopeFreeze.requiresExplicitApproval ? 'yes' : 'no'}`,
          );
        } catch (err) {
          handleCommandError(err);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// proposals (group, read-only inspection)
// ---------------------------------------------------------------------------

function registerProposalsSubcommand(improve: Command): void {
  const proposals = improve
    .command('proposals')
    .description('Inspect improvement proposals on disk');

  proposals
    .command('list')
    .description('List all proposals, newest first')
    .option('--card <slug>', 'Filter by card slug')
    .option('--risk <level>', 'Filter by risk: low | medium | high')
    .option('--json', 'Emit JSON instead of a table', false)
    .action((opts: { card?: string; risk?: string; json: boolean }) => {
      try {
        let entries = listProposals();
        if (opts.card) entries = entries.filter((e) => e.cardSlug === opts.card);
        if (opts.risk) entries = entries.filter((e) => e.riskLevel === opts.risk);

        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        if (entries.length === 0) {
          console.log('No proposals found.');
          return;
        }

        const header =
          'PROPOSAL ID                                                     | CARD                                       | RISK   | STATUS    | CREATED';
        const sep = '-'.repeat(header.length);
        console.log(header);
        console.log(sep);
        for (const e of entries) {
          console.log(
            [
              e.proposalId.padEnd(64).slice(0, 64),
              e.cardSlug.padEnd(44).slice(0, 44),
              e.riskLevel.padEnd(6),
              e.status.padEnd(9),
              e.createdAt,
            ].join(' | '),
          );
        }
      } catch (err) {
        handleCommandError(err);
      }
    });

  proposals
    .command('show <id>')
    .description('Print a proposal by id')
    .option('--json', 'Emit raw JSON instead of rendered markdown', false)
    .action((id: string, opts: { json: boolean }) => {
      try {
        const p = getProposal(id);
        if (!p) {
          console.error(`Proposal not found: ${id}`);
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify(p, null, 2));
          return;
        }
        console.log(renderProposalMarkdown(p));
      } catch (err) {
        handleCommandError(err);
      }
    });
}

// ---------------------------------------------------------------------------
// eval-gen (Sprint 3 — replay mode only)
// ---------------------------------------------------------------------------

function registerEvalGenSubcommand(improve: Command): void {
  improve
    .command('eval-gen <cardSlug>')
    .description(
      'Generate a replay-mode eval-case from a failure card. Slices a byte-identical fixture from the source witness trace.',
    )
    .option(
      '--proposal <id>',
      'Back-reference to a proposal (validated to exist). Sprint 3 does NOT mutate the proposal artifact.',
    )
    .option(
      '--evidence-row <index>',
      '0-based index into the card\'s evidence array. Default: the most recent row (length - 1).',
    )
    .option('--id <override>', 'Override the auto-generated eval-case id')
    .option('--json', 'Emit the eval-case JSON to stdout (still writes to disk)', false)
    .option(
      '--no-write',
      'Render the eval-case without persisting to disk (preview mode). Still reads the source trace.',
    )
    .action(
      (
        cardSlug: string,
        opts: {
          proposal?: string;
          evidenceRow?: string;
          id?: string;
          json: boolean;
          write: boolean;
        },
      ) => {
        try {
          // 1. Load the card.
          const card = getCard(cardSlug);
          if (!card) {
            console.error(`Card not found: ${cardSlug}`);
            process.exit(1);
          }

          // 2. Validate --proposal existence if provided. The eval-case writer
          //    does not mutate the proposal; we only verify the back-reference
          //    points at a real artifact so the link is meaningful.
          if (opts.proposal !== undefined) {
            const proposal = getProposal(opts.proposal);
            if (!proposal) {
              console.error(`Proposal not found: ${opts.proposal}`);
              process.exit(1);
            }
            if (proposal.cardSlug !== cardSlug) {
              console.error(
                `Proposal ${opts.proposal} targets card '${proposal.cardSlug}', not '${cardSlug}'.`,
              );
              process.exit(2);
            }
          }

          // 3. Resolve the evidence-row index.
          //    Default: most recent row = last element of card.evidence.
          //    The merge order in card-writer preserves existing entries first
          //    then appends new ones, so the last row is the freshest sighting.
          let evidenceRowIndex = card.evidence.length - 1;
          if (opts.evidenceRow !== undefined) {
            const parsed = Number.parseInt(opts.evidenceRow, 10);
            if (!Number.isFinite(parsed) || parsed < 0) {
              console.error(
                `Invalid --evidence-row: '${opts.evidenceRow}' (must be non-negative integer)`,
              );
              process.exit(2);
            }
            evidenceRowIndex = parsed;
          }

          // 4. Generate or override the id.
          const evalCaseId = opts.id ?? generateEvalCaseId(cardSlug);

          // 5. Build the eval-case + slice bytes.
          const { evalCase, sliceBytes } = buildEvalCase(card, {
            evalCaseId,
            evidenceRowIndex,
            proposalId: opts.proposal ?? null,
          });

          // 6. Preview branch: render without persisting.
          if (opts.write === false) {
            if (opts.json) {
              console.log(JSON.stringify(evalCase, null, 2));
            } else {
              console.log('(preview — not persisted; remove --no-write to save)');
              console.log('');
              console.log(renderEvalCaseMarkdown(evalCase));
              console.log('');
              console.log(`Fixture would be ${sliceBytes.length} bytes, ${evalCase.replay.sliceLineCount} lines.`);
            }
            return;
          }

          // 7. Persist.
          const outcome = writeEvalCase(evalCase, sliceBytes);

          if (opts.json) {
            console.log(JSON.stringify({ ...evalCase, _paths: outcome }, null, 2));
            return;
          }

          console.log(`Wrote eval-case: ${outcome.evalCaseId}`);
          console.log(`  json:    ${outcome.jsonPath}`);
          console.log(`  fixture: ${outcome.fixturePath}`);
          console.log(`  md:      ${outcome.markdownPath}`);
          console.log(
            `  pattern: ${evalCase.assertion.patternId} · slice: lines ${evalCase.replay.sliceLineRange.startLine}–${evalCase.replay.sliceLineRange.endLine} (${evalCase.replay.sliceLineCount} lines) · sha256 ${evalCase.replay.sliceSha256.slice(0, 12)}…`,
          );
          if (evalCase.proposalId) {
            console.log(
              `  proposal: ${evalCase.proposalId}  (back-reference only — Sprint 3 does not back-fill validationPlan.evalCases)`,
            );
          }
        } catch (err) {
          if (err instanceof EvalGenError) {
            console.error(`eval-gen failed [${err.code}]: ${err.message}`);
            // Map error codes to exit codes:
            //   user-input errors → 2 (commander convention)
            //   data / system errors → 1
            const exitCode =
              err.code === 'evidence-row-out-of-range' || err.code === 'unsupported-window'
                ? 2
                : 1;
            process.exit(exitCode);
          }
          handleCommandError(err);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// eval-cases (group, read-only inspection)
// ---------------------------------------------------------------------------

function registerEvalCasesSubcommand(improve: Command): void {
  const evalCases = improve
    .command('eval-cases')
    .description('Inspect replay-mode eval-cases on disk');

  evalCases
    .command('list')
    .description('List all eval-cases, newest first')
    .option('--card <slug>', 'Filter by card slug')
    .option('--pattern <name>', `Filter by pattern (one of: ${VALID_PATTERNS.join(', ')})`)
    .option('--status <state>', `Filter by status (one of: ${VALID_EVAL_STATUSES.join(', ')})`)
    .option('--json', 'Emit JSON instead of a table', false)
    .action(
      (opts: { card?: string; pattern?: string; status?: string; json: boolean }) => {
        try {
          if (opts.pattern && !VALID_PATTERNS.includes(opts.pattern as FailurePattern)) {
            console.error(
              `Invalid --pattern: '${opts.pattern}'. Must be one of: ${VALID_PATTERNS.join(', ')}`,
            );
            process.exit(2);
          }
          if (opts.status && !VALID_EVAL_STATUSES.includes(opts.status as EvalCaseStatus)) {
            console.error(
              `Invalid --status: '${opts.status}'. Must be one of: ${VALID_EVAL_STATUSES.join(', ')}`,
            );
            process.exit(2);
          }

          let entries = listEvalCases();
          if (opts.card) entries = entries.filter((e) => e.cardSlug === opts.card);
          if (opts.pattern) entries = entries.filter((e) => e.patternId === opts.pattern);
          if (opts.status) entries = entries.filter((e) => e.status === opts.status);

          if (opts.json) {
            console.log(JSON.stringify(entries, null, 2));
            return;
          }

          if (entries.length === 0) {
            console.log('No eval-cases found.');
            return;
          }

          const header =
            'EVAL CASE ID                                                          | CARD                                       | PATTERN              | STATUS    | CREATED';
          const sep = '-'.repeat(header.length);
          console.log(header);
          console.log(sep);
          for (const e of entries) {
            console.log(
              [
                e.evalCaseId.padEnd(70).slice(0, 70),
                e.cardSlug.padEnd(44).slice(0, 44),
                e.patternId.padEnd(20),
                e.status.padEnd(9),
                e.createdAt,
              ].join(' | '),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      },
    );

  evalCases
    .command('show <id>')
    .description('Print an eval-case by id')
    .option('--json', 'Emit raw JSON instead of rendered markdown', false)
    .action((id: string, opts: { json: boolean }) => {
      try {
        const ec = getEvalCase(id);
        if (!ec) {
          console.error(`Eval-case not found: ${id}`);
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify(ec, null, 2));
          return;
        }
        console.log(renderEvalCaseMarkdown(ec));
      } catch (err) {
        handleCommandError(err);
      }
    });
}

// ---------------------------------------------------------------------------
// eval-run (deterministic guardrail validation)
// ---------------------------------------------------------------------------

function registerEvalRunSubcommand(improve: Command): void {
  improve
    .command('eval-run <evalCaseIdOrCardSlug>')
    .description(
      'Run the smallest deterministic validation contract for an eval-case\'s pattern.\n' +
        `  Validates guardrails (no LLM, no patch/apply). Known contracts: ${knownContractIds().join(', ')}.`,
    )
    .option('--id <override>', 'Override the auto-generated eval-run id')
    .option('--json', 'Emit the eval-run JSON to stdout (still writes to disk)', false)
    .option('--no-write', 'Run and render without persisting to disk (preview mode)')
    .action(
      async (
        arg: string,
        opts: { id?: string; json: boolean; write: boolean },
      ) => {
        try {
          // 1. Resolve the eval-case: try an exact eval-case id first, then
          //    fall back to treating the arg as a card slug (most recent
          //    eval-case for that card wins — listEvalCases sorts newest first).
          let evalCase: EvalCase | undefined = getEvalCase(arg);
          if (!evalCase) {
            const forCard = getEvalCasesForCard(arg);
            evalCase = forCard[0];
          }
          if (!evalCase) {
            console.error(
              `No eval-case found for '${arg}'. Pass an eval-case id ` +
                `(see 'afk improve eval-cases list') or a card slug with at least ` +
                `one generated eval-case ('afk improve eval-gen <slug>').`,
            );
            process.exit(1);
          }

          // 2. Run the contract.
          const evalRunId = opts.id ?? generateEvalRunId(evalCase.cardSlug);
          const evalRun = await runEvalCase(evalCase, { evalRunId });

          // 3. Preview branch: render without persisting.
          if (opts.write === false) {
            if (opts.json) {
              console.log(JSON.stringify(evalRun, null, 2));
            } else {
              console.log('(preview — not persisted; remove --no-write to save)');
              console.log('');
              console.log(renderEvalRunMarkdown(evalRun));
            }
            applyEvalRunExit(evalRun.status);
            return;
          }

          // 4. Persist.
          const outcome = writeEvalRun(evalRun);

          if (opts.json) {
            console.log(JSON.stringify({ ...evalRun, _paths: outcome }, null, 2));
            applyEvalRunExit(evalRun.status);
            return;
          }

          printEvalRunSummary(evalRun, outcome.jsonPath, outcome.markdownPath);
          applyEvalRunExit(evalRun.status);
        } catch (err) {
          handleCommandError(err);
        }
      },
    );
}

function printEvalRunSummary(evalRun: EvalRun, jsonPath: string, markdownPath: string): void {
  const passed = evalRun.checks.filter((c) => c.status === 'pass').length;
  const failed = evalRun.checks.filter((c) => c.status === 'fail').length;
  const skipped = evalRun.checks.filter((c) => c.status === 'skipped').length;

  console.log(`Ran eval-run: ${evalRun.evalRunId}  [${evalRun.status.toUpperCase()}]`);
  console.log(`  json: ${jsonPath}`);
  console.log(`  md:   ${markdownPath}`);
  console.log(
    `  eval-case: ${evalRun.evalCaseId} · card: ${evalRun.cardSlug} · ` +
      `pattern: ${evalRun.patternId} · contract: ${evalRun.contract ?? '(none)'}`,
  );
  console.log(
    `  checks: ${passed} passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''} (${evalRun.checks.length} total)`,
  );
  for (const c of evalRun.checks) {
    const glyph = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '–';
    console.log(`    ${glyph} ${c.name}`);
  }
  for (const n of evalRun.notes) {
    console.log(`  note: ${n.text}`);
  }
}

/**
 * Set a non-zero exit code when the run found a regression, so the command is
 * usable as a CI / scripting gate (`afk improve eval-run X && …`). `pass` and
 * `unsupported` exit 0 (no regression detected); `fail`/`error` exit 1. Uses
 * `process.exitCode` rather than `process.exit()` so buffered stdout flushes.
 */
function applyEvalRunExit(status: EvalRun['status']): void {
  if (status === 'fail' || status === 'error') {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parsePositiveInt(input: string, name: string, min: number): number {
  const n = Number.parseInt(input, 10);
  if (!Number.isFinite(n) || n < min) {
    console.error(`Invalid --${name}: '${input}' (must be integer >= ${min})`);
    process.exit(2);
  }
  return n;
}

function parseRate(input: string, name: string): number {
  const n = Number.parseFloat(input);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    console.error(`Invalid --${name}: '${input}' (must be number in (0, 1])`);
    process.exit(2);
  }
  return n;
}
