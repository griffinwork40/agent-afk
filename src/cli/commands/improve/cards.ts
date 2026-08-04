import { Command } from 'commander';
import { handleCommandError } from '../../errors/index.js';
import { listCards, getCard, listRegressedCards, renderMarkdown } from '../../../improve/scan/card-writer.js';
import type { RegressedCardEntry } from '../../../improve/scan/card-writer.js';
import { triageCard, TriageError } from '../../../improve/triage.js';
import type { CardStatus } from '../../../improve/schemas.js';

const VALID_STATUSES: readonly CardStatus[] = ['open', 'deferred', 'resolved'];

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

export function registerCardsSubcommand(improve: Command): void {
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
