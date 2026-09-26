/**
 * /whatif — predict the behavioural impact of a proposed change.
 *
 * Usage:
 *   /whatif [change text...]  [flags]
 *
 * See `src/whatif/args.ts` WHATIF_USAGE for the full flag grammar. All flags
 * available in `afk whatif` are also available here.
 *
 * Confirmation: when a plain-English spec is compiled and `--yes` is not
 * passed, the command prints the compiled spec and asks the user to re-run
 * with `--yes` (REPL context has no TTY readline elicitation mechanism).
 *
 * Progress: staged `ctx.out.info()` lines. Stage changes and every ~10th
 * episode completion are emitted; between those the spinner stays silent to
 * avoid flooding the REPL.
 *
 * Cancellation: an AbortController is registered via `ctx.setSoftStopHandler`
 * (ESC key) when available.
 *
 * @module cli/slash/commands/whatif
 */

import { loadConfig } from '../../config.js';
import { getAfkHome, getSkillsDir, getPluginsDir } from '../../../paths.js';
import { palette } from '../../palette.js';
import { describeChange } from '../../../whatif/operators/index.js';
import {
  parseWhatifArgs,
  tokenizeSlashArgs,
  WHATIF_USAGE,
} from '../../../whatif/args.js';
import {
  resolveSpec,
  buildWhatifDeps,
  readDirNames,
} from '../../../whatif/surface.js';
import type { SlashCommand, SlashContext } from '../types.js';
import type { WhatifReport } from '../../../whatif/types.js';

// ---------------------------------------------------------------------------
// Budget error guard
// ---------------------------------------------------------------------------
import type { WhatifBudgetError as WhatifBudgetErrorType } from '../../../whatif/run.js';

function isBudgetError(err: unknown): err is WhatifBudgetErrorType {
  return (
    err instanceof Error &&
    'estimateUsd' in err &&
    'maxUsd' in err
  );
}

// ---------------------------------------------------------------------------
// Progress throttling
// ---------------------------------------------------------------------------

/** Emit a progress line at most once every ~10 episodes within the same stage. */
function makeProgressThrottle(ctx: SlashContext): (stage: string, message: string, done?: number) => void {
  let lastStage = '';
  let episodeCount = 0;

  return (stage: string, message: string, done?: number): void => {
    if (stage !== lastStage) {
      lastStage = stage;
      episodeCount = 0;
      ctx.out.info(`[whatif] ${stage}: ${message}`);
      return;
    }
    if (stage === 'episodes' || stage === 'run') {
      episodeCount++;
      if (done !== undefined && episodeCount % 10 === 0) {
        ctx.out.info(`[whatif] ${stage}: ${message}`);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleWhatif(ctx: SlashContext, args: string): Promise<void> {
  const tokens = tokenizeSlashArgs(args);
  const parsed = parseWhatifArgs(tokens);

  if (typeof parsed === 'string') {
    ctx.out.error(parsed);
    return;
  }

  // Load credentials.
  const config = loadConfig();
  const token = config.apiKey;
  if (!token) {
    ctx.out.error(
      'whatif requires an Anthropic API key. Set ANTHROPIC_API_KEY or run: afk login',
    );
    return;
  }

  const realHome = getAfkHome();
  const realCwd = process.cwd();
  const analystModel = parsed.options.analystModel ?? 'claude-sonnet-4-5';
  const agentModel =
    parsed.options.agentModel ??
    (ctx.stats.model as string | undefined) ??
    (config.model as string) ??
    'claude-sonnet-4-5';

  const skills = readDirNames(getSkillsDir());
  const plugins = readDirNames(getPluginsDir());

  // Set up AbortController for ESC soft-stop.
  const ac = new AbortController();
  ctx.setSoftStopHandler?.(() => ac.abort());

  const progressThrottle = makeProgressThrottle(ctx);

  const deps = buildWhatifDeps({
    token,
    analystModel,
    signal: ac.signal,
    onProgress: (p) => {
      progressThrottle(p.stage, p.message, p.done);
    },
  });

  // Resolve the ChangeSpec.
  let spec;
  try {
    spec = await resolveSpec(parsed, {
      complete: deps.complete,
      analystModel,
      realHome,
      skills,
      plugins,
    });
  } catch (err) {
    ctx.out.error(err instanceof Error ? err.message : String(err));
    return;
  } finally {
    ctx.setSoftStopHandler?.(null);
  }

  // Confirmation: print the spec and ask the user to re-run with --yes.
  if (!parsed.yes && parsed.text && !parsed.specFile) {
    ctx.out.info('Compiled change spec:');
    for (const ch of spec.changes) {
      ctx.out.line(`  • ${describeChange(ch)}`);
    }
    ctx.out.line('');
    ctx.out.info(
      'Re-run with --yes to proceed: /whatif ' +
        args.trim() +
        ' --yes',
    );
    ctx.setSoftStopHandler?.(null);
    return;
  }

  // Register stop handler for the run phase.
  ctx.setSoftStopHandler?.(() => ac.abort());

  let report: WhatifReport;
  try {
    const { runWhatif } = await import('../../../whatif/run.js');
    report = await runWhatif(
      {
        spec,
        realHome,
        realCwd,
        agentModel,
        analystModel,
        verify: parsed.options.verify,
        turns: parsed.options.turns,
        samples: parsed.options.samples,
        maxUsd: parsed.options.maxUsd,
        judge: parsed.options.judge,
        concurrency: parsed.options.concurrency,
        maxTurns: parsed.options.maxTurns,
        episodeTimeoutMs: parsed.options.episodeTimeoutMs,
        keepSandboxes: parsed.options.keepSandboxes,
      },
      deps,
    );
  } catch (err) {
    ctx.setSoftStopHandler?.(null);

    if (isBudgetError(err)) {
      const be = err as WhatifBudgetErrorType;
      ctx.out.error(
        `whatif: budget exceeded — estimated $${be.estimateUsd.toFixed(2)}, ` +
          `limit $${be.maxUsd.toFixed(2)}. ` +
          `Raise the cap with --max-usd ${Math.ceil(be.estimateUsd * 1.5)}.`,
      );
      return;
    }

    ctx.out.error(err instanceof Error ? err.message : String(err));
    return;
  }

  ctx.setSoftStopHandler?.(null);

  if (parsed.json) {
    ctx.out.raw(JSON.stringify(report, null, 2));
    return;
  }

  // Terminal output.
  const { renderTerminal } = await import('../../../whatif/report.js');
  const lines = renderTerminal(report, palette);
  for (const line of lines) ctx.out.line(line);
  ctx.out.line('');
  ctx.out.info(`Full report: ${report.runDir}/report.md`);
}

// ---------------------------------------------------------------------------
// SlashCommand export
// ---------------------------------------------------------------------------

export const whatifCmd: SlashCommand = {
  name: '/whatif',
  summary: 'Predict behavioural impact of a proposed change to your AFK environment',
  usage: '/whatif [change text | flags]',
  hint:
    'Use when you want to safely preview what would happen if you changed your ' +
    'AFK.md, a memory fact, a model, or any other setting — before committing to it.',
  flags: [
    '--append',
    '--append-project',
    '--file',
    '--hot',
    '--memory-add',
    '--memory-category',
    '--memory-remove',
    '--disable-skill',
    '--disable-plugin',
    '--model',
    '--effort',
    '--env',
    '--spec',
    '--agent-model',
    '--analyst-model',
    '--verify',
    '--quick',
    '--turns',
    '--samples',
    '--max-usd',
    '--judge',
    '--concurrency',
    '--max-turns',
    '--timeout',
    '--keep-sandboxes',
    '--yes',
    '--json',
  ],
  async handler(ctx: SlashContext, args: string): Promise<'continue'> {
    if (args.trim() === '' || args.trim() === '--help') {
      ctx.out.line(WHATIF_USAGE);
      return 'continue';
    }
    await handleWhatif(ctx, args);
    return 'continue';
  },
};
