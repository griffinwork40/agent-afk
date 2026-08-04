import { Command } from 'commander';
import { handleCommandError } from '../../errors/index.js';
import { getCard } from '../../../improve/scan/card-writer.js';
import { getProposal } from '../../../improve/propose/writer.js';
import { EvalGenError } from '../../../improve/eval-gen/replay-fixture.js';
import {
  buildEvalCase,
  generateEvalCaseId,
  getEvalCase,
  getEvalCasesForCard,
  listEvalCases,
  renderEvalCaseMarkdown,
  writeEvalCase,
} from '../../../improve/eval-gen/writer.js';
import type { EvalCaseStatus, FailurePattern } from '../../../improve/schemas.js';
import { VALID_PATTERNS } from './shared.js';

const VALID_EVAL_STATUSES: readonly EvalCaseStatus[] = [
  'draft',
  'approved',
  'rejected',
  'superseded',
];

// ---------------------------------------------------------------------------
// eval-gen (Sprint 3 — replay mode only)
// ---------------------------------------------------------------------------

export function registerEvalGenSubcommand(improve: Command): void {
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
    .option(
      '--force',
      'Write even if this card already has an eval-case (default: refuse)',
      false,
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
          force: boolean;
        },
      ) => {
        try {
          // 1. Load the card.
          const card = getCard(cardSlug);
          if (!card) {
            console.error(`Card not found: ${cardSlug}`);
            process.exit(1);
          }

          // 1b. Same duplicate guard as `propose`: an eval-case slices a
          //     fixture from a specific evidence row, so a second one for the
          //     same card is only meaningful with an explicit --evidence-row
          //     (or --force). Preview mode persists nothing and is never gated.
          if (opts.write !== false && !opts.force && opts.evidenceRow === undefined) {
            const existing = getEvalCasesForCard(cardSlug);
            if (existing.length > 0) {
              const ids = existing.map((e) => e.evalCaseId);
              console.error(
                `Card '${cardSlug}' already has ${existing.length} eval-case(s):\n` +
                  ids.map((id) => `  ${id}`).join('\n') +
                  `\nRe-run with --force, target a different row with ` +
                  `--evidence-row <n>, or --no-write to preview. ` +
                  `Run the existing one: 'afk improve eval-run ${ids[0]}'.`,
              );
              process.exit(1);
            }
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

export function registerEvalCasesSubcommand(improve: Command): void {
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
