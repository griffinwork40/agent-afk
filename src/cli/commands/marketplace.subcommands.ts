/**
 * Late-stage subcommand registrations for `afk marketplace`.
 *
 * Extracted from {@link registerMarketplaceCommand} to keep that function
 * within the 200-line function ceiling. All behaviour is unchanged.
 *
 * @module cli/commands/marketplace.subcommands
 */

import type { Command } from 'commander';
import ora from 'ora';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import {
  installFromMarketplace,
  type InstallFromMarketplaceDeps,
} from '../../agent/marketplaces/resolve.js';
import { removeMarketplace } from '../../agent/marketplaces/remove.js';
import {
  updateMarketplace,
  updateAllMarketplaces,
  type UpdateMarketplaceDeps,
  type UpdateMarketplaceOutcome,
} from '../../agent/marketplaces/update.js';

/** Shared deps shape threaded through from the parent command. */
export interface MarketplaceSubDeps extends InstallFromMarketplaceDeps, UpdateMarketplaceDeps {
  logger?: Pick<Console, 'log' | 'error'>;
  cacheDir: string;
  indexPath: string;
}

/**
 * Register the `marketplace install-plugin` subcommand.
 */
export function registerMarketplaceInstallPlugin(
  market: Command,
  moduleDeps: MarketplaceSubDeps,
): void {
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
            palette.success(`Installed ${palette.bold(result.key)}`) +
              palette.meta(` at ${result.dir}`),
          );
        } catch (err) {
          spinner.fail('Failed');
          handleCommandError(err);
        }
      },
    );
}

/**
 * Register the `marketplace remove` subcommand.
 */
export function registerMarketplaceRemove(
  market: Command,
  moduleDeps: MarketplaceSubDeps,
  logger: Pick<Console, 'log' | 'error'>,
): void {
  market
    .command('remove <name>')
    .description('Remove a marketplace and cascade-delete its installed plugins')
    .action((name: string) => {
      const result = removeMarketplace(name, { cacheDir: moduleDeps.cacheDir, indexPath: moduleDeps.indexPath });
      if (
        !result.removedDir &&
        !result.removedIndexEntry &&
        result.removedPluginEntries.length === 0
      ) {
        logger.log(palette.meta(`No marketplace named "${name}" to remove.`));
        return;
      }
      const bits = [
        result.removedDir ? 'directory' : null,
        result.removedIndexEntry ? 'index entry' : null,
        result.removedPluginEntries.length > 0
          ? `${result.removedPluginEntries.length} plugin entry`
          : null,
      ].filter(Boolean);
      logger.log(palette.success(`Removed ${name}: ${bits.join(' + ')}`));
      if (result.removedPluginEntries.length > 0) {
        for (const key of result.removedPluginEntries) {
          logger.log(palette.meta(`  - ${key}`));
        }
      }
    });
}

/**
 * Format a single marketplace update outcome as a human-readable line.
 */
export function formatOutcome(o: UpdateMarketplaceOutcome): string {
  switch (o.status) {
    case 'updated': {
      const added = o.addedPlugins.length > 0 ? ` +${o.addedPlugins.join(', ')}` : '';
      const removed = o.removedPlugins.length > 0 ? ` -${o.removedPlugins.join(', ')}` : '';
      const refPart =
        o.fromRef === o.toRef
          ? `${o.toRef} @ ${o.commit.slice(0, 7)}`
          : `${o.fromRef ?? '(none)'} → ${o.toRef}`;
      const versions = o.pluginVersions
        .filter((p): p is { name: string; version: string } => p.version !== null)
        .map((p) => `${p.name} ${p.version}`)
        .join(', ');
      const vPart = versions ? palette.meta(`  [${versions}]`) : '';
      return `${palette.success('✓')} ${palette.bold(o.name)}: ${refPart}${palette.meta(added + removed)}${vPart}`;
    }
    case 'up-to-date':
      return `${palette.meta('·')} ${palette.bold(o.name)}: up-to-date (${o.ref})`;
    case 'skipped-local':
      return `${palette.meta('·')} ${palette.bold(o.name)}: skipped (local source)`;
    case 'missing-dir':
      return `${palette.warning('!')} ${palette.bold(o.name)}: marketplace dir missing (${o.dir})`;
  }
}

/**
 * Print a single update outcome via an ora spinner.
 */
export function printOutcome(
  o: UpdateMarketplaceOutcome,
  spinner: ReturnType<typeof ora>,
): void {
  const line = formatOutcome(o);
  if (o.status === 'updated') spinner.succeed(line);
  else if (o.status === 'up-to-date') spinner.info(line);
  else if (o.status === 'skipped-local') spinner.info(line);
  else spinner.warn(line);
}

/**
 * Register the `marketplace update` subcommand.
 */
export function registerMarketplaceUpdate(
  market: Command,
  moduleDeps: MarketplaceSubDeps,
  logger: Pick<Console, 'log' | 'error'>,
): void {
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
          logger.log(palette.info('Updating all marketplaces…'));
          const outcomes = await updateAllMarketplaces(moduleDeps);
          if (outcomes.length === 0) {
            logger.log(palette.meta('  (no marketplaces installed)'));
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
