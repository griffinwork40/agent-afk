import { Command } from 'commander';
import { handleCommandError } from '../../errors/index.js';
import { getEvalCase, getEvalCasesForCard } from '../../../improve/eval-gen/writer.js';
import {
  generateEvalRunId,
  renderEvalRunMarkdown,
  runEvalCase,
  writeEvalRun,
} from '../../../improve/eval-run/runner.js';
import { knownContractIds } from '../../../improve/eval-run/contracts.js';
import type { EvalCase, EvalRun } from '../../../improve/schemas.js';

// ---------------------------------------------------------------------------
// eval-run (deterministic guardrail validation)
// ---------------------------------------------------------------------------

export function registerEvalRunSubcommand(improve: Command): void {
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
 * Contract: map eval-run status onto a distinct process exit code so the
 * command is usable as a CI / scripting gate (`afk improve eval-run X && …`).
 *
 *   pass        → 0  the recorded failure was re-driven and is neutralised
 *   fail|error  → 1  a regression, or the runner itself broke
 *   unsupported → 3  NOTHING WAS CHECKED — the eval-case's pattern has no
 *                    registered contract (`contracts.ts` resolveContract →
 *                    undefined), so the run asserted nothing at all
 *
 * `unsupported` previously exited 0, which made it indistinguishable from a
 * real `pass`: wiring this command into CI would have silently green-lit any
 * pattern lacking a contract (today: `subagent-read-denial`). It gets its own
 * code rather than 1 so a gate can still choose to tolerate "no contract yet"
 * without also tolerating a genuine regression. 2 is reserved for CLI argument
 * errors (see `parsePositiveInt` / `parseRate`).
 *
 * Uses `process.exitCode` rather than `process.exit()` so buffered stdout flushes.
 */
export function applyEvalRunExit(status: EvalRun['status']): void {
  if (status === 'fail' || status === 'error') {
    process.exitCode = 1;
  } else if (status === 'unsupported') {
    process.exitCode = 3;
  }
}
