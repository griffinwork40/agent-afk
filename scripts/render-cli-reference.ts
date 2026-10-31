#!/usr/bin/env tsx
/** Metadata only. Never import src/cli/index.ts or parse/execute a command.
 * Registration order mirrors src/cli/index.ts; renderer preserves that order.
 * Run through lib/isolated-reference.ts before these static imports evaluate.
 */
import { Command } from 'commander';
import { registerChatCommand } from '../src/cli/commands/chat.js';
import { registerInteractiveCommand } from '../src/cli/commands/interactive.js';
import { registerStatusCommand } from '../src/cli/commands/status.js';
import { registerUsageCommand } from '../src/cli/commands/usage.js';
import { registerConfigCommand } from '../src/cli/commands/config-command.js';
import { registerDaemonCommand } from '../src/cli/commands/daemon.js';
import { registerWebCommand } from '../src/cli/commands/web.js';
import { registerQueueCommand } from '../src/cli/commands/queue.js';
import { registerEventsCommand } from '../src/cli/commands/events.js';
import { registerLoginCommand } from '../src/cli/commands/login-command.js';
import { registerPluginCommand } from '../src/cli/commands/plugin.js';
import { registerMarketplaceCommand } from '../src/cli/commands/marketplace.js';
import { registerDoctorCommand } from '../src/cli/commands/doctor.js';
import { registerMigrateCommand } from '../src/cli/commands/migrate.js';
import { registerProviderCommand } from '../src/cli/commands/provider.js';
import { registerCompletionCommand } from '../src/cli/commands/completion.js';
import { registerTelegramCommand } from '../src/cli/commands/telegram.js';
import { registerFarmCommand } from '../src/cli/commands/farm.js';
import { registerWorktreeCommand } from '../src/cli/commands/worktree.js';
import { registerBranchCommand } from '../src/cli/commands/branch.js';
import { registerUpdateCommand } from '../src/cli/commands/update.js';
import { registerScheduleCommand } from '../src/cli/commands/schedule.js';
import { registerBgCommand } from '../src/cli/commands/bg.js';
import { registerTraceCommand } from '../src/cli/commands/trace.js';
import { registerEpisodeCommand } from '../src/cli/commands/episode.js';
import { registerWhatifCommand } from '../src/cli/commands/whatif.js';
import { registerWitnessCommand } from '../src/cli/commands/witness.js';
import { registerServiceCommand } from '../src/cli/commands/service.js';
import { registerRestartCommand } from '../src/cli/commands/restart.js';
import { registerBrowserCommand } from '../src/cli/commands/browser.js';
import { registerImproveCommand } from '../src/cli/commands/improve/index.js';
import { registerShellInitCommand } from '../src/cli/commands/shell-init.js';
import { registerTranscriptCommand } from '../src/cli/commands/transcript.js';
import { registerInsightsCommand } from '../src/cli/commands/insights.js';
import { registerCapturesCommand } from '../src/cli/commands/captures.js';
import { registerDefectsCommand } from '../src/cli/commands/defects.js';
import { registerReceiptCommand } from '../src/cli/commands/receipt.js';
// jscpd:ignore-start — intentional mirror of src/cli/index.ts registrar block;
// the renderer must declare the same import to build metadata-only, never execute.
import { registerAcpCommand } from '../src/cli/commands/acp.js';
// jscpd:ignore-end
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCli } from './render-cli-reference.mdx.js';
import { isMain, repoRoot, writeReference } from './lib/docs-reference.js';

/**
 * Extract ordered `registerXxxCommand` call sites from source text.
 * @internal
 */
export function registrations(text: string): string[] {
  return [...text.matchAll(/^\s*(register\w+Command)\(program\);/gm)].map((m) => m[1]!);
}

/**
 * Returns true when the generator mirrors the entry point exactly; logs diff on mismatch.
 *
 * When called with no arguments, reads `src/cli/index.ts` for `entryText` and
 * reads **this file** (`scripts/render-cli-reference.ts`) for `generatorText`.
 *
 * @internal
 */
export function checkMirror(
  entryText?: string,
  generatorText?: string,
): boolean {
  const entry = entryText ?? readFileSync(join(repoRoot, 'src/cli/index.ts'), 'utf8');
  const generator = generatorText ?? readFileSync(join(repoRoot, 'scripts/render-cli-reference.ts'), 'utf8');
  const entryRegs = registrations(entry);
  const genRegs = registrations(generator);
  if (JSON.stringify(entryRegs) === JSON.stringify(genRegs)) return true;
  const missing = entryRegs.filter((r) => !genRegs.includes(r));
  const extra = genRegs.filter((r) => !entryRegs.includes(r));
  if (missing.length) console.error(`scan:cli:check: registrars in src/cli/index.ts missing from render-cli-reference.ts: ${missing.join(', ')}`);
  if (extra.length) console.error(`scan:cli:check: registrars in render-cli-reference.ts not in src/cli/index.ts: ${extra.join(', ')}`);
  // Only emit the order-mismatch message when the sets are equal but the
  // sequence differs — missing/extra cases are already reported above.
  if (!missing.length && !extra.length) {
    // Pure order mismatch — set is identical, sequence differs.
    console.error(`scan:cli:check: registration order mismatch.\n  expected: ${entryRegs.join(', ')}\n  actual:   ${genRegs.join(', ')}\n  Run pnpm scan:cli to regenerate.`);
  }
  return false;
}

export function buildCli(): Command {
  // The version option is documented, but the release number is intentionally
  // not embedded: a package version bump alone must not churn this reference.
  const program = new Command('afk')
    .description('AI agent CLI. Starts interactive REPL by default; use `afk chat` for one-shot.')
    .version('unversioned', '-V, --version')
    .option('--no-update-check', 'Skip update version check');
  // Registration order mirrors the public entry point.
  registerChatCommand(program);
  registerConfigCommand(program);
  registerDaemonCommand(program);
  registerWebCommand(program);
  registerQueueCommand(program);
  registerEventsCommand(program);
  registerInteractiveCommand(program);
  registerLoginCommand(program);
  registerPluginCommand(program);
  registerMarketplaceCommand(program);
  registerStatusCommand(program);
  registerUsageCommand(program);
  registerDoctorCommand(program);
  registerMigrateCommand(program);
  registerProviderCommand(program);
  registerCompletionCommand(program);
  registerTelegramCommand(program);
  registerFarmCommand(program);
  registerWorktreeCommand(program);
  registerBranchCommand(program);
  registerUpdateCommand(program);
  registerScheduleCommand(program);
  registerBgCommand(program);
  registerTraceCommand(program);
  registerEpisodeCommand(program);
  registerWhatifCommand(program);
  registerWitnessCommand(program);
  registerServiceCommand(program);
  registerRestartCommand(program);
  registerBrowserCommand(program);
  registerImproveCommand(program);
  registerShellInitCommand(program);
  registerTranscriptCommand(program);
  registerInsightsCommand(program);
  registerCapturesCommand(program);
  registerDefectsCommand(program);
  registerReceiptCommand(program);
  // jscpd:ignore-start — intentional mirror of src/cli/index.ts registrar block;
  // the renderer must call the same registrar to expose metadata, never execute.
  registerAcpCommand(program);
  // jscpd:ignore-end

  program.commands.find((c) => c.name() === 'chat')?.alias('c');
  program.commands.find((c) => c.name() === 'interactive')?.alias('i');
  program.commands.find((c) => c.name() === 'status')?.alias('s');

  return program;
}

if (isMain(import.meta.url)) {
  const check = process.argv.includes('--check');
  const program = buildCli();
  const count = (cmd: Command): number => cmd.commands.reduce((n, c) => n + 1 + count(c), 0);
  console.log(`${program.commands.length} top level commands; ${count(program) - program.commands.length} subcommands`);
  const mirrorOk = check ? checkMirror() : true;
  const refOk = writeReference('cli', renderCli(program), check, undefined, 'scan:cli');
  process.exitCode = mirrorOk && refOk ? 0 : 1;
}
