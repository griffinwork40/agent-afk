/**
 * `afk marketplace …` command tree.
 *
 * User-facing surface for clone / list / inspect / install-plugin / remove /
 * update operations on plugin marketplaces. Presentation concerns (ora
 * spinners, chalk colors) live here; the module layer under
 * `src/agent/marketplaces/` stays pure and testable.
 *
 * @module cli/commands/marketplace
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { handleCommandError } from '../errors/index.js';
import {
  installMarketplace,
  type MarketplaceInstallDeps,
  type MarketplaceInstallOptions,
} from '../../agent/marketplaces/install.js';
import {
  installFromMarketplace,
  listMarketplacePlugins,
  type InstallFromMarketplaceDeps,
} from '../../agent/marketplaces/resolve.js';
import { removeMarketplace } from '../../agent/marketplaces/remove.js';
import {
  updateMarketplace,
  updateAllMarketplaces,
  type UpdateMarketplaceDeps,
  type UpdateMarketplaceOutcome,
} from '../../agent/marketplaces/update.js';
import { readIndex } from '../../agent/plugins/index-store.js';
import { getMarketplaceCacheDir, getPluginsIndexPath } from '../../paths.js';

export interface MarketplaceCommandDeps
  extends MarketplaceInstallDeps,
    InstallFromMarketplaceDeps,
    UpdateMarketplaceDeps {
  logger?: Pick<Console, 'log' | 'error'>;
}

export function registerMarketplaceCommand(
  program: Command,
  deps: MarketplaceCommandDeps = {},
): void {
  const logger = deps.logger ?? console;
  const cacheDir = deps.cacheDir ?? getMarketplaceCacheDir();
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const moduleDeps = { ...deps, cacheDir, indexPath };

  const market = program
    .command('marketplace')
    .description('Manage AFK plugin marketplaces (install / list / plugins / install-plugin / remove / update)');

  market
    .command('install <source> [name]')
    .description('Clone or symlink a marketplace into the local plugin cache')
    .option('-r, --ref <ref>', 'Install a specific tag, branch, or SHA')
    .option('-f, --force', 'Replace an existing marketplace with the same name')
    .action(
      async (
        source: string,
        name: string | undefined,
        cmdOpts: { ref?: string; force?: boolean },
      ) => {
        // Note: `marketplace install` currently does not print the same 3 s
        // install warning as `plugin install` — only the plugins listed inside
        // the marketplace gain execution rights, and each plugin install path
        // surfaces its own warning. We accept this asymmetry: cloning a
        // marketplace catalog is structurally distinct from installing a
        // plugin from it.
        const spinner = ora(`Installing marketplace ${source}…`).start();
        try {
          const opts: MarketplaceInstallOptions = {
            ...(name ? { name } : {}),
            ...(cmdOpts.ref ? { ref: cmdOpts.ref } : {}),
            ...(cmdOpts.force ? { force: true } : {}),
          };
          const result = await installMarketplace(source, opts, moduleDeps);
          const refTag = result.entry.ref ? ` (ref: ${result.entry.ref})` : '';
          spinner.succeed(
            chalk.green(`Installed marketplace ${chalk.bold(result.name)}`) +
              chalk.gray(`${refTag} at ${result.dir}`),
          );
          logger.log(
            chalk.gray(`  ${result.plugins.length} plugin(s) available — run \`afk marketplace plugins ${result.name}\` to list.`),
          );
        } catch (err) {
          spinner.fail('Failed');
          handleCommandError(err);
        }
      },
    );

  market
    .command('list')
    .description('List installed marketplaces with their source and ref')
    .option('-f, --format <format>', 'Output format (text|json)', 'text')
    .action((options: { format: string }) => {
      const idx = readIndex(indexPath);
      const marketplaces = Object.entries(idx.marketplaces);
      if (options.format === 'json') {
        logger.log(
          JSON.stringify(
            {
              marketplaces: marketplaces.map(([n, e]) => ({
                name: n,
                source: e.source,
                sourceType: e.sourceType,
                ...(e.ref ? { ref: e.ref } : {}),
              })),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (marketplaces.length === 0) {
        logger.log(chalk.gray('No marketplaces installed.'));
        logger.log(
          chalk.gray('  Try: afk marketplace install <org>/<marketplace>'),
        );
        return;
      }
      logger.log(chalk.cyan.bold('\nInstalled marketplaces:'));
      for (const [name, entry] of marketplaces.sort()) {
        const ref = entry.ref ? chalk.blue(entry.ref) : chalk.gray('(local)');
        const src = chalk.gray(entry.source);
        logger.log(`  ${chalk.bold(name.padEnd(30))} ${ref.padEnd(12)}  ${src}`);
      }
      logger.log('');
    });

  market
    .command('plugins <name>')
    .description('List plugins inside a marketplace, with [installed] / [available] markers')
    .option('-f, --format <format>', 'Output format (text|json)', 'text')
    .action((name: string, options: { format: string }) => {
      try {
        const plugins = listMarketplacePlugins(name, moduleDeps);
        if (options.format === 'json') {
          logger.log(JSON.stringify({ marketplace: name, plugins }, null, 2));
          return;
        }
        if (plugins.length === 0) {
          logger.log(chalk.gray(`Marketplace "${name}" lists no plugins.`));
          return;
        }
        logger.log(chalk.cyan.bold(`\nPlugins in ${name}:`));
        plugins.forEach((p, i) => {
          const marker = p.installed ? chalk.green('[✓]') : chalk.gray('[ ]');
          const desc = p.description ? chalk.gray(` — ${p.description}`) : '';
          logger.log(`  ${marker} ${chalk.bold((i + 1).toString().padStart(2))}. ${chalk.bold(p.name)}${desc}`);
        });
        logger.log(
          chalk.gray(
            `\n  Install one: afk plugin install ${name}:<plugin>`,
          ),
        );
      } catch (err) {
        handleCommandError(err);
      }
    });

  market
    .command('install-plugin <marketplace> <plugin>')
    .description('Install a single plugin from a marketplace')
    .option('-r, --ref <ref>', 'For git-sourced plugins, pin to a specific tag/branch/SHA')
    .option('-f, --force', 'Replace an existing plugin with the same key')
    .option('-y, --yes', 'Skip the install warning and countdown (non-interactive / CI)')
    .action(
      async (
        marketplace: string,
        plugin: string,
        cmdOpts: { ref?: string; force?: boolean; yes?: boolean },
      ) => {
        // Gate on stderr.isTTY for the same reason as `afk plugin install`:
        // the warning is rendered to stderr, so its visibility is what
        // determines whether the 3 s countdown is meaningful.
        const isInteractive = process.stderr.isTTY === true && !cmdOpts.yes;
        const spinner = ora(`Installing ${marketplace}:${plugin}…`).start();
        try {
          const result = await installFromMarketplace(
            marketplace,
            plugin,
            {
              ...(cmdOpts.ref ? { ref: cmdOpts.ref } : {}),
              ...(cmdOpts.force ? { force: true } : {}),
            },
            { ...moduleDeps, confirm: isInteractive },
          );
          spinner.succeed(
            chalk.green(`Installed ${chalk.bold(result.key)}`) +
              chalk.gray(` at ${result.dir}`),
          );
        } catch (err) {
          spinner.fail('Failed');
          handleCommandError(err);
        }
      },
    );

  market
    .command('remove <name>')
    .description('Remove a marketplace and cascade-delete its installed plugins')
    .action((name: string) => {
      const result = removeMarketplace(name, { cacheDir, indexPath });
      if (
        !result.removedDir &&
        !result.removedIndexEntry &&
        result.removedPluginEntries.length === 0
      ) {
        logger.log(chalk.gray(`No marketplace named "${name}" to remove.`));
        return;
      }
      const bits = [
        result.removedDir ? 'directory' : null,
        result.removedIndexEntry ? 'index entry' : null,
        result.removedPluginEntries.length > 0
          ? `${result.removedPluginEntries.length} plugin entry`
          : null,
      ].filter(Boolean);
      logger.log(chalk.green(`Removed ${name}: ${bits.join(' + ')}`));
      if (result.removedPluginEntries.length > 0) {
        for (const key of result.removedPluginEntries) {
          logger.log(chalk.gray(`  - ${key}`));
        }
      }
    });

  market
    .command('update [name]')
    .description('Update one marketplace, or all if no name is given')
    .option('-r, --ref <ref>', 'Pin to a specific ref instead of the latest tag')
    .action(async (name: string | undefined, cmdOpts: { ref?: string }) => {
      try {
        if (name) {
          const spinner = ora(`Updating ${name}…`).start();
          const outcome = await updateMarketplace(
            name,
            cmdOpts.ref ? { ref: cmdOpts.ref } : {},
            moduleDeps,
          );
          printOutcome(outcome, spinner);
        } else {
          logger.log(chalk.cyan('Updating all marketplaces…'));
          const outcomes = await updateAllMarketplaces(moduleDeps);
          if (outcomes.length === 0) {
            logger.log(chalk.gray('  (no marketplaces installed)'));
            return;
          }
          for (const o of outcomes) {
            logger.log('  ' + formatOutcome(o));
          }
        }
      } catch (err) {
        handleCommandError(err);
      }
    });
}

function formatOutcome(o: UpdateMarketplaceOutcome): string {
  switch (o.status) {
    case 'updated': {
      const added = o.addedPlugins.length > 0 ? ` +${o.addedPlugins.join(', ')}` : '';
      const removed = o.removedPlugins.length > 0 ? ` -${o.removedPlugins.join(', ')}` : '';
      // Branch-tracked installs report fromRef === toRef (e.g. "main") because
      // the ref name didn't move even though the commit did — show the short
      // SHA so the advance is visible. Tag/SHA updates keep the "from → to" form.
      const refPart =
        o.fromRef === o.toRef
          ? `${o.toRef} @ ${o.commit.slice(0, 7)}`
          : `${o.fromRef ?? '(none)'} → ${o.toRef}`;
      const versions = o.pluginVersions
        .filter((p): p is { name: string; version: string } => p.version !== null)
        .map((p) => `${p.name} ${p.version}`)
        .join(', ');
      const vPart = versions ? chalk.gray(`  [${versions}]`) : '';
      return `${chalk.green('✓')} ${chalk.bold(o.name)}: ${refPart}${chalk.gray(added + removed)}${vPart}`;
    }
    case 'up-to-date':
      return `${chalk.gray('·')} ${chalk.bold(o.name)}: up-to-date (${o.ref})`;
    case 'skipped-local':
      return `${chalk.gray('·')} ${chalk.bold(o.name)}: skipped (local source)`;
    case 'missing-dir':
      return `${chalk.yellow('!')} ${chalk.bold(o.name)}: marketplace dir missing (${o.dir})`;
  }
}

function printOutcome(
  o: UpdateMarketplaceOutcome,
  spinner: ReturnType<typeof ora>,
): void {
  const line = formatOutcome(o);
  if (o.status === 'updated') spinner.succeed(line);
  else if (o.status === 'up-to-date') spinner.info(line);
  else if (o.status === 'skipped-local') spinner.info(line);
  else spinner.warn(line);
}
