/**
 * CLI command: `afk whatif`
 *
 * Registers `afk whatif [change...]` and delegates to `runWhatif` in
 * `src/whatif/run.ts`. Argument parsing is via `parseWhatifArgs` so the
 * grammar stays identical to the REPL `/whatif` surface.
 *
 * Usage examples:
 *   afk whatif "turn off auto-routing"
 *   afk whatif --append "Always ask before tools" --verify
 *   afk whatif --spec ./my-change.json --judge claude
 *
 * @module cli/commands/whatif
 */

import { Command } from 'commander';
import { createInterface } from 'node:readline';
import ora from 'ora';
import { loadConfig } from '../config.js';
import { handleCommandError } from '../errors/index.js';
import { getAfkHome, getSkillsDir, getPluginsDir } from '../../paths.js';
import { palette } from '../palette.js';
import { REPL_SPINNER_OPTIONS } from './interactive/shared.js';
import { renderTerminal } from '../../whatif/report.js';
import { describeChange } from '../../whatif/operators/index.js';
import {
  parseWhatifArgs,
} from '../../whatif/args.js';
import {
  resolveSpec,
  buildWhatifDeps,
  readDirNames,
} from '../../whatif/surface.js';
import type { WhatifReport } from '../../whatif/types.js';

// ---------------------------------------------------------------------------
// Budget error — imported from run.ts once the sibling agent writes it.
// We import lazily via dynamic import to tolerate the file not existing yet
// during tsc; the static import below is what callers see at runtime.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import type { WhatifBudgetError as WhatifBudgetErrorType } from '../../whatif/run.js';

function isBudgetError(err: unknown): err is WhatifBudgetErrorType {
  return (
    err instanceof Error &&
    'estimateUsd' in err &&
    'maxUsd' in err
  );
}

// ---------------------------------------------------------------------------
// TTY confirmation helper
// ---------------------------------------------------------------------------

async function confirmSpec(lines: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write('\n');
    for (const l of lines) process.stderr.write(`  ${l}\n`);
    process.stderr.write('\nProceed with this change? [y/N] ');
    rl.once('line', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
    rl.once('close', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWhatifCommand(program: Command): void {
  program
    .command('whatif [change...]')
    .description(
      'Predict how a proposed change to your AFK environment will affect the\n' +
        'agent\'s behaviour. Optionally run episodes to verify empirically.\n\n' +
        'Pass a plain-English description, explicit flags, or a --spec file.',
    )
    .option('--append <text>', 'Append text to your AFK.md (user scope)')
    .option('--append-project <text>', 'Append text to project AFK.md')
    .option('--file <path=localfile>', 'Set a file (path: home:<rel> or project:<rel>)')
    .option('--hot <localfile>', 'Replace HOT.md with a local file')
    .option('--memory-add <text>', 'Add a memory fact')
    .option('--memory-category <cat>', 'Category for next --memory-add (default: preference)')
    .option('--memory-remove <id>', 'Remove a memory fact by numeric id')
    .option('--disable-skill <name>', 'Disable a skill by name')
    .option('--disable-plugin <name>', 'Disable a plugin by name')
    .option('--model <id>', 'Test a candidate model change')
    .option('--effort <level>', 'Test a candidate effort level')
    .option('--env <KEY=VALUE>', 'Set an env var in the candidate sandbox')
    .option('--spec <file>', 'Load a ChangeSpec from a JSON file')
    .option('--agent-model <id>', 'Model the agent under test uses')
    .option('--analyst-model <id>', 'Model for compile/predict/judge (default: sonnet)')
    .option('--verify', 'Run episodes and verify predictions empirically')
    .option('--quick', 'Single-turn episodes (sets --max-turns 1)')
    .option('--turns <n>', 'Real turns to replay (default: 12)')
    .option('--samples <n>', 'Samples per episode per environment (default: 3)')
    .option('--max-usd <n>', 'Budget cap in USD (default: 5)')
    .option('--judge <auto|jev|claude>', 'Judge to use (default: auto)')
    .option('--concurrency <n>', 'Parallel episodes (default: 4)')
    .option('--max-turns <n>', 'Max turns per episode (default: 3)')
    .option('--timeout <sec>', 'Episode timeout in seconds (default: 180)')
    .option('--keep-sandboxes', 'Keep sandbox directories after run')
    .option('--yes', 'Skip confirmation of compiled spec')
    .option('--json', 'Print results as JSON to stdout')
    .action(async (changeParts: string[], opts: Record<string, unknown>) => {
      try {
        await runWhatifCommand(changeParts, opts);
      } catch (err) {
        handleCommandError(err);
      }
    });
}

// ---------------------------------------------------------------------------
// Action implementation (extracted for testability)
// ---------------------------------------------------------------------------

async function runWhatifCommand(
  changeParts: string[],
  opts: Record<string, unknown>,
): Promise<void> {
  // Build argv from Commander's parsed values so parseWhatifArgs handles logic.
  const argv = buildArgvFromOpts(changeParts, opts);
  const parsed = parseWhatifArgs(argv);

  if (typeof parsed === 'string') {
    process.stderr.write(parsed + '\n');
    process.exit(1);
  }

  // Load CLI config and validate credentials.
  const config = loadConfig();
  const token = config.apiKey;
  if (!token) {
    process.stderr.write(
      `${palette.error('afk whatif')} requires an Anthropic API key.\n` +
        'Set ANTHROPIC_API_KEY or run: afk login\n',
    );
    process.exit(1);
  }

  const realHome = getAfkHome();
  const realCwd = process.cwd();
  const analystModel = parsed.options.analystModel ?? 'claude-sonnet-4-5';
  const agentModel = parsed.options.agentModel ?? (config.model as string) ?? 'claude-sonnet-4-5';

  const deps = buildWhatifDeps({
    token,
    analystModel,
    signal: undefined,
    onProgress: (p) => {
      if (process.stdout.isTTY) return; // spinner handles it
      process.stderr.write(`[whatif] ${p.stage}: ${p.message}\n`);
    },
  });

  const skills = readDirNames(getSkillsDir());
  const plugins = readDirNames(getPluginsDir());

  // Resolve the ChangeSpec.
  const spec = await resolveSpec(parsed, {
    complete: deps.complete,
    analystModel,
    realHome,
    skills,
    plugins,
  });

  // Confirmation gate for plain-English specs when stdin is a TTY.
  if (!parsed.yes && parsed.text && !parsed.specFile) {
    const lines = spec.changes.map((c) => describeChange(c));
    if (process.stdin.isTTY) {
      const ok = await confirmSpec(lines);
      if (!ok) {
        process.stderr.write('Aborted.\n');
        process.exit(0);
      }
    } else {
      process.stderr.write(
        'Non-interactive mode: pass --yes to run without confirmation.\n',
      );
      process.exit(1);
    }
  }

  // Run with ora progress spinner (TTY) or plain stderr lines (non-TTY).
  const spinner = process.stdout.isTTY
    ? ora({ ...REPL_SPINNER_OPTIONS, text: 'whatif: analysing…' }).start()
    : null;

  let report: WhatifReport;

  try {
    // Dynamic import tolerates run.ts not existing during type-check if this
    // file is compiled before the sibling agent writes it.
    const { runWhatif } = await import('../../whatif/run.js');

    const depsWithProgress: typeof deps = {
      ...deps,
      onProgress: (p) => {
        const msg = `${p.stage}: ${p.message}`;
        if (spinner) {
          spinner.text = msg;
        } else {
          process.stderr.write(`[whatif] ${msg}\n`);
        }
      },
    };

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
      depsWithProgress,
    );
  } catch (err) {
    spinner?.stop();

    if (isBudgetError(err)) {
      const be = err as WhatifBudgetErrorType;
      process.stderr.write(
        `${palette.error('whatif: budget exceeded')} — ` +
          `estimated $${be.estimateUsd.toFixed(2)}, limit $${be.maxUsd.toFixed(2)}.\n` +
          `Raise the cap with: --max-usd ${Math.ceil(be.estimateUsd * 1.5)}\n`,
      );
      process.exit(2);
    }

    throw err;
  }

  spinner?.stop();

  if (parsed.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  // Terminal output.
  const termLines = renderTerminal(report, palette);
  for (const line of termLines) process.stdout.write(line + '\n');
  process.stdout.write(`\nFull report: ${report.runDir}/report.md\n`);
}

// ---------------------------------------------------------------------------
// Argv builder
// ---------------------------------------------------------------------------

/**
 * Reconstruct a raw argv from Commander's parsed opts + positionals.
 * This keeps parseWhatifArgs as the single source of truth for flag logic.
 */
function buildArgvFromOpts(
  changeParts: string[],
  opts: Record<string, unknown>,
): string[] {
  const argv: string[] = [...changeParts];

  function push(flag: string, val: unknown): void {
    if (val === undefined || val === null || val === false) return;
    if (val === true) { argv.push(flag); return; }
    argv.push(flag, String(val));
  }

  push('--append', opts['append']);
  push('--append-project', opts['appendProject']);
  push('--file', opts['file']);
  push('--hot', opts['hot']);
  push('--memory-add', opts['memoryAdd']);
  push('--memory-category', opts['memoryCategory']);
  push('--memory-remove', opts['memoryRemove']);
  push('--disable-skill', opts['disableSkill']);
  push('--disable-plugin', opts['disablePlugin']);
  push('--model', opts['model']);
  push('--effort', opts['effort']);
  push('--env', opts['env']);
  push('--spec', opts['spec']);
  push('--agent-model', opts['agentModel']);
  push('--analyst-model', opts['analystModel']);
  push('--verify', opts['verify']);
  push('--quick', opts['quick']);
  push('--turns', opts['turns']);
  push('--samples', opts['samples']);
  push('--max-usd', opts['maxUsd']);
  push('--judge', opts['judge']);
  push('--concurrency', opts['concurrency']);
  push('--max-turns', opts['maxTurns']);
  push('--timeout', opts['timeout']);
  push('--keep-sandboxes', opts['keepSandboxes']);
  push('--yes', opts['yes']);
  push('--json', opts['json']);

  return argv;
}
