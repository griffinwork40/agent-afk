import { Command } from 'commander';
import { handleCommandError } from '../../errors/index.js';
import { getCard } from '../../../improve/scan/card-writer.js';
import { proposeFromCard } from '../../../improve/propose/template-engine.js';
import {
  generateProposalId,
  getProposal,
  getProposalsForCard,
  listProposals,
  renderProposalMarkdown,
  writeProposal,
} from '../../../improve/propose/writer.js';
import { formatAgeDays } from './triage-helpers.js';
import type { ProposalStatus } from '../../../improve/schemas.js';

const VALID_PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'draft',
  'approved',
  'rejected',
  'superseded',
];

// ---------------------------------------------------------------------------
// propose (template mode only)
// ---------------------------------------------------------------------------

export function registerProposeSubcommand(improve: Command): void {
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
    .option(
      '--force',
      'Write even if this card already has a proposal (default: refuse)',
      false,
    )
    .action(
      (
        slug: string,
        opts: { id?: string; json: boolean; write: boolean; force: boolean },
      ) => {
        try {
          const card = getCard(slug);
          if (!card) {
            console.error(`Card not found: ${slug}`);
            process.exit(1);
          }

          // Refuse to silently stack a near-identical proposal on a card that
          // already has one. Re-running `propose` on an unchanged card was the
          // default path to 4x duplicates (tool-failure-compose, browser-open).
          // Preview mode (--no-write) persists nothing, so it is never gated.
          if (opts.write !== false && !opts.force) {
            const existing = getProposalsForCard(slug);
            if (existing.length > 0) {
              const ids = existing.map((p) => p.proposalId);
              console.error(
                `Card '${slug}' already has ${existing.length} proposal(s):\n` +
                  ids.map((id) => `  ${id}`).join('\n') +
                  `\nRe-run with --force to add another, --no-write to preview, ` +
                  `or inspect with 'afk improve proposals show ${ids[0]}'.`,
              );
              process.exit(1);
            }
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

export function registerProposalsSubcommand(improve: Command): void {
  const proposals = improve
    .command('proposals')
    .description('Inspect improvement proposals on disk');

  proposals
    .command('list')
    .description('List all proposals, newest first')
    .option('--card <slug>', 'Filter by card slug')
    .option('--risk <level>', 'Filter by risk: low | medium | high')
    .option('--status <state>', 'Filter by status: draft | approved | rejected | superseded')
    .option(
      '--triage',
      'Show only draft proposals, sorted oldest-first by age (highest-priority first for human review)',
      false,
    )
    .option('--json', 'Emit JSON instead of a table', false)
    .action((opts: { card?: string; risk?: string; status?: string; triage: boolean; json: boolean }) => {
      try {
        if (opts.status && !VALID_PROPOSAL_STATUSES.includes(opts.status as ProposalStatus)) {
          console.error(
            `Invalid --status: '${opts.status}'. Must be one of: ${VALID_PROPOSAL_STATUSES.join(', ')}`,
          );
          process.exit(2);
        }
        if (opts.triage && opts.status) {
          console.warn(`Warning: --status is ignored when --triage is set (--triage always filters to 'draft').`);
        }
        let entries = listProposals();
        if (opts.card) entries = entries.filter((e) => e.cardSlug === opts.card);
        if (opts.risk) entries = entries.filter((e) => e.riskLevel === opts.risk);
        if (opts.triage) {
          // --triage: narrow to drafts, sort oldest-first so the longest-waiting
          // proposals surface at the top.
          entries = entries.filter((e) => e.status === 'draft');
          entries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        } else if (opts.status) {
          entries = entries.filter((e) => e.status === opts.status);
        }

        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        if (entries.length === 0) {
          if (opts.triage) {
            console.log('No draft proposals need review. All proposals are approved, rejected, or superseded.');
          } else {
            console.log('No proposals found.');
          }
          return;
        }

        if (opts.triage) {
          const draftCount = entries.length;
          console.log(
            `${draftCount} draft proposal(s) awaiting review (oldest first). ` +
              `Approve with: afk improve approve <proposal-id>`,
          );
          console.log('');
        }

        const showAge = opts.triage;
        const header = showAge
          ? 'AGE   | PROPOSAL ID                                                     | CARD                                       | RISK   | CREATED'
          : 'PROPOSAL ID                                                     | CARD                                       | RISK   | STATUS    | CREATED';
        const sep = '-'.repeat(header.length);
        console.log(header);
        console.log(sep);
        for (const e of entries) {
          if (showAge) {
            console.log(
              [
                formatAgeDays(e.createdAt).padEnd(5),
                e.proposalId.padEnd(64).slice(0, 64),
                e.cardSlug.padEnd(44).slice(0, 44),
                e.riskLevel.padEnd(6),
                e.createdAt,
              ].join(' | '),
            );
          } else {
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
