/**
 * `afk migrate` — import plugins, skills, and MCP servers from other agent
 * CLIs (Claude Code, Codex) into AFK.
 *
 * This is a CONFIG-POPULATION helper, not a file mover. The asset formats are
 * already identical across tools; the only difference is install location. So
 * rather than copy files, `afk migrate` records a per-binary trust grant in
 * afk.config.json's `importFrom` block, and AFK live-reads the trusted binary's
 * dirs on every session. A plugin installed in Claude Code tomorrow shows up in
 * AFK tomorrow — no re-run, no drift.
 *
 * Trust is per-binary and opt-in. MCP import is off by default even for a
 * trusted binary (MCP servers auto-run a command on session start), and is only
 * enabled with `--mcp` after the command discloses each server's command.
 *
 * @module cli/commands/migrate
 */

import type { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { createInterface } from 'readline/promises';
import { palette } from '../palette.js';
import { getJsonConfigPath } from '../../paths.js';
import {
  detectSources,
  KNOWN_IMPORT_BINARIES,
  parseImportFromConfig,
  type DetectedSource,
  type ImportSourceBinary,
} from '../../config/import-sources.js';

interface MigrateOptions {
  from?: string;
  dryRun?: boolean;
  mcp?: boolean;
  yes?: boolean;
}

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate [binary]')
    .description('Import plugins, skills, and MCP servers from Claude Code / Codex into AFK')
    .option('--from <binary>', 'Source binary to import from (claude-code | codex)')
    .option('--dry-run', 'Show what would be imported without writing config')
    .option('--mcp', 'Also import MCP servers (off by default — discloses each command first)')
    .option('-y, --yes', 'Apply without the interactive confirmation (non-interactive / CI)')
    .action(async (binaryArg: string | undefined, opts: MigrateOptions) => {
      const requested = normalizeBinary(binaryArg ?? opts.from);
      if ((binaryArg ?? opts.from) !== undefined && requested === null) {
        console.error(
          palette.error(
            `Unknown source binary "${binaryArg ?? opts.from}". Known: ${KNOWN_IMPORT_BINARIES.join(', ')}`,
          ),
        );
        process.exit(1);
      }

      const detected = detectSources().filter((s) => s.present);
      const targets = requested ? detected.filter((s) => s.binary === requested) : detected;

      if (targets.length === 0) {
        if (requested) {
          console.log(
            palette.dim(
              `${labelFor(requested)} not detected on this machine (looked for its plugins/skills/MCP config).`,
            ),
          );
        } else {
          console.log(
            palette.dim('No supported source tools detected (looked for Claude Code and Codex).'),
          );
        }
        process.exit(0);
      }

      for (const src of targets) printSourceSummary(src, opts.mcp === true);

      const importBlock = buildImportBlock(targets, opts.mcp === true);

      if (opts.dryRun === true) {
        console.log('');
        console.log(palette.bold('Dry run — would write to afk.config.json:'));
        console.log(palette.dim(JSON.stringify({ importFrom: importBlock }, null, 2)));
        console.log('');
        console.log(palette.dim('Re-run without --dry-run to apply.'));
        process.exit(0);
      }

      // Confirmation gate. Interactive TTY → prompt; otherwise require --yes.
      if (opts.yes !== true) {
        if (!process.stdin.isTTY) {
          console.log('');
          console.log(
            palette.warning('Non-interactive shell: re-run with --yes to apply, or --dry-run to preview.'),
          );
          process.exit(0);
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = (
            await rl.question(palette.bold(`\nTrust ${targets.map((t) => t.label).join(' + ')} and live-read these assets? [y/N] `))
          )
            .trim()
            .toLowerCase();
          if (answer !== 'y' && answer !== 'yes') {
            console.log(palette.dim('Aborted — nothing written.'));
            process.exit(0);
          }
        } finally {
          rl.close();
        }
      }

      const configPath = getJsonConfigPath();
      try {
        writeImportFrom(configPath, importBlock);
      } catch (err) {
        console.error(palette.error(`Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      console.log('');
      console.log(palette.success(`✓ Recorded import trust in ${configPath}`));
      console.log(palette.dim('  Your imported plugins and skills are now live on the next `afk` session.'));
      console.log(palette.dim('  Run `afk doctor` to verify, or `afk migrate --dry-run` to review.'));
      if (opts.mcp !== true && targets.some((t) => t.mcpServers.length > 0)) {
        console.log(
          palette.dim('  MCP servers were NOT imported (they auto-run commands). Re-run with --mcp to include them.'),
        );
      }
      process.exit(0);
    });
}

export function normalizeBinary(value: string | undefined): ImportSourceBinary | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  return (KNOWN_IMPORT_BINARIES as readonly string[]).includes(v) ? (v as ImportSourceBinary) : null;
}

function labelFor(binary: ImportSourceBinary): string {
  return binary === 'claude-code' ? 'Claude Code' : 'Codex';
}

function printSourceSummary(src: DetectedSource, includeMcp: boolean): void {
  console.log('');
  console.log(palette.bold(`${src.label}`));
  console.log(`  ${src.plugins.length} plugin(s), ${src.skills.length} skill(s)`);
  if (src.plugins.length > 0) {
    console.log(palette.dim(`    plugins: ${src.plugins.map((p) => p.name).join(', ')}`));
  }
  if (src.skills.length > 0) {
    console.log(palette.dim(`    skills:  ${src.skills.map((s) => s.name).join(', ')}`));
  }
  if (src.mcpServers.length > 0) {
    if (includeMcp) {
      // Disclose each command so the user sees exactly what will auto-run.
      console.log(palette.warning(`  ${src.mcpServers.length} MCP server(s) — these auto-run on session start:`));
      for (const s of src.mcpServers) {
        console.log(palette.dim(`    ${s.name}: ${s.command}`));
      }
      if (src.mcpFormat === 'toml') {
        console.log(
          palette.warning('    (Codex MCP loading is not yet supported — detection only. mcp will be recorded false.)'),
        );
      }
    } else {
      console.log(palette.dim(`  ${src.mcpServers.length} MCP server(s) available (use --mcp to import)`));
    }
  }
}

/**
 * Build the `importFrom` block to record. plugins+skills are imported whenever
 * present; mcp is imported only when `--mcp` is passed AND the binary's MCP
 * config is in a loadable format (JSON — Codex's TOML is detection-only today).
 */
export function buildImportBlock(
  targets: DetectedSource[],
  includeMcp: boolean,
): Record<ImportSourceBinary, { plugins: boolean; skills: boolean; mcp: boolean }> {
  const block = {} as Record<ImportSourceBinary, { plugins: boolean; skills: boolean; mcp: boolean }>;
  for (const src of targets) {
    block[src.binary] = {
      plugins: src.plugins.length > 0,
      skills: src.skills.length > 0,
      mcp: includeMcp && src.mcpFormat === 'json' && src.mcpServers.length > 0,
    };
  }
  return block;
}

/**
 * Merge the `importFrom` block into the user-global afk.config.json, preserving
 * all other fields. Atomic (temp-file + rename), matching the codebase pattern.
 */
export function writeImportFrom(
  configPath: string,
  importBlock: Record<string, { plugins: boolean; skills: boolean; mcp: boolean }>,
): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed existing config — refuse to clobber it silently.
      throw new Error('existing config is not valid JSON; fix it before running migrate');
    }
  }

  // Invariant: re-runs are additive — a prior opt-in is never silently cleared.
  // New values may turn a toggle ON but must never turn a previously-enabled
  // toggle OFF. We normalize the prior entry first (expanding a bare `true`
  // shorthand to {plugins,skills,mcp}) so spread-merging cannot lose implied
  // trues, then OR-merge per toggle for each binary present in importBlock.
  // Binaries not mentioned in importBlock are preserved verbatim (raw).
  const rawPrior =
    existing['importFrom'] !== null &&
    typeof existing['importFrom'] === 'object' &&
    !Array.isArray(existing['importFrom'])
      ? (existing['importFrom'] as Record<string, unknown>)
      : {};
  const normalizedPrior = parseImportFromConfig(rawPrior) ?? {};

  const merged: Record<string, unknown> = { ...rawPrior };
  for (const [binary, newToggles] of Object.entries(importBlock)) {
    const priorToggles = normalizedPrior[binary as ImportSourceBinary] ?? {
      plugins: false,
      skills: false,
      mcp: false,
    };
    merged[binary] = {
      plugins: priorToggles.plugins || newToggles.plugins,
      skills: priorToggles.skills || newToggles.skills,
      mcp: priorToggles.mcp || newToggles.mcp,
    };
  }
  existing['importFrom'] = merged;

  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  renameSync(tmp, configPath);
}
