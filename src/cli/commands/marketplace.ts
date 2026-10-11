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
import ora from 'ora';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import {
  installMarketplace,
  type MarketplaceInstallDeps,
  type MarketplaceInstallOptions,
} from '../../agent/marketplaces/install.js';
import {
  listMarketplacePlugins,
  type InstallFromMarketplaceDeps,
} from '../../agent/marketplaces/resolve.js';
import {
  type UpdateMarketplaceDeps,
} from '../../agent/marketplaces/update.js';
import { readIndex } from '../../agent/plugins/index-store.js';
import { getMarketplaceCacheDir, getPluginsIndexPath } from '../../paths.js';
import {
  registerMarketplaceInstallPlugin,
  registerMarketplaceRemove,
  registerMarketplaceUpdate,
} from './marketplace.subcommands.js';

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
            palette.success(`Installed marketplace ${palette.bold(result.name)}`) +
              palette.meta(`${refTag} at ${result.dir}`),
          );
          logger.log(
            palette.meta(`  ${result.plugins.length} plugin(s) available — run \`afk marketplace plugins ${result.name}\` to list.`),
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
        logger.log(palette.meta('No marketplaces installed.'));
        logger.log(
          palette.meta('  Try: afk marketplace install <org>/<marketplace>'),
        );
        return;
      }
      logger.log(palette.heading('\nInstalled marketplaces:'));
      for (const [name, entry] of marketplaces.sort()) {
        const ref = entry.ref ? palette.info(entry.ref) : palette.meta('(local)');
        const src = palette.meta(entry.source);
        logger.log(`  ${palette.bold(name.padEnd(30))} ${ref.padEnd(12)}  ${src}`);
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
          logger.log(palette.meta(`Marketplace "${name}" lists no plugins.`));
          return;
        }
        logger.log(palette.heading(`\nPlugins in ${name}:`));
        plugins.forEach((p, i) => {
          const marker = p.installed ? palette.success('[✓]') : palette.meta('[ ]');
          const desc = p.description ? palette.meta(` — ${p.description}`) : '';
          logger.log(`  ${marker} ${palette.bold((i + 1).toString().padStart(2))}. ${palette.bold(p.name)}${desc}`);
        });
        logger.log(
          palette.meta(
            `\n  Install one: afk plugin install ${name}:<plugin>`,
          ),
        );
      } catch (err) {
        handleCommandError(err);
      }
    });

  registerMarketplaceInstallPlugin(market, moduleDeps);
  registerMarketplaceRemove(market, moduleDeps, logger);
  registerMarketplaceUpdate(market, moduleDeps, logger);
}
