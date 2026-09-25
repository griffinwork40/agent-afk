/**
 * `afk improve approve <slug>` — mark a proposal or eval-case as `approved`.
 *
 * The slug may be either a proposal id or an eval-case id. The command
 * resolves proposals first (by looking up `proposals/<slug>.json`), then
 * eval-cases (`eval-cases/<slug>.json`), so pass the exact id displayed by
 * `afk improve proposals list` or `afk improve eval-cases list`.
 *
 * On success the artifact's `status` field transitions to `'approved'` and
 * an approval note is appended recording who approved and when. Both the
 * JSON and human-readable `.md` are updated atomically, and a `'triaged'`
 * event is appended to the relevant `.index.jsonl`.
 *
 * Options:
 *   --by <name>   Override the approver identity (defaults to $USER).
 *   --force       Allow re-approving an already-approved artifact (adds a
 *                 second approval note — useful for auditing handoff).
 *   --json        Emit a JSON summary of the outcome instead of human text.
 */

import { Command } from 'commander';
import { handleCommandError } from '../../errors/index.js';
import { approveArtifact, ApproveError } from '../../../improve/approve.js';

export function registerApproveSubcommand(improve: Command): void {
  improve
    .command('approve <slug>')
    .description(
      'Mark a proposal or eval-case as approved. ' +
        'Pass the proposal id (from `proposals list`) or eval-case id (from `eval-cases list`).',
    )
    .option(
      '--by <name>',
      'Approver identity (defaults to $USER env var, then "unknown")',
    )
    .option('--force', 'Allow re-approving an already-approved artifact', false)
    .option('--json', 'Emit outcome as JSON instead of human-readable text', false)
    .action((slug: string, opts: { by?: string; force: boolean; json: boolean }) => {
      try {
        const outcome = approveArtifact(slug, {
          approvedBy: opts.by,
          force: opts.force,
        });

        if (opts.json) {
          console.log(JSON.stringify(outcome, null, 2));
          return;
        }

        const kindLabel = outcome.kind === 'proposal' ? 'Proposal' : 'Eval-case';
        console.log(
          `${kindLabel} '${outcome.slug}' approved by ${outcome.approvedBy} at ${outcome.approvedAt}`,
        );
        if (outcome.previousStatus !== 'approved') {
          console.log(`  status: ${outcome.previousStatus} → ${outcome.newStatus}`);
        } else {
          console.log(`  status: approved (re-approved with --force)`);
        }
        console.log(`  json: ${outcome.jsonPath}`);
        console.log(`  md:   ${outcome.markdownPath}`);
      } catch (err) {
        if (err instanceof ApproveError) {
          console.error(`approve failed [${err.code}]: ${err.message}`);
          process.exit(err.code === 'not-found' ? 1 : 2);
        }
        handleCommandError(err);
      }
    });
}
