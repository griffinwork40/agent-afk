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
