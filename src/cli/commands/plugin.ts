/**
 * `afk plugin …` command tree.
 *
 * User-facing surface for install / update / list / remove / enable / disable.
 * Keeps presentation concerns (ora spinners, chalk colors) here; the module
 * layer under `src/agent/plugins/` stays pure and testable.
 *
 * @module cli/commands/plugin
 */

import type { Command } from 'commander';
import ora from 'ora';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import { installPlugin, type InstallDeps, type InstallOptions } from '../../agent/plugins/install.js';
import {
  updatePlugin,
  updateAll,
  type UpdateDeps,
  type UpdateOutcome,
} from '../../agent/plugins/update.js';
import { removePlugin } from '../../agent/plugins/remove.js';
import {
  readIndex,
  setEnabled,
  type PluginIndex,
} from '../../agent/plugins/index-store.js';
import { parseSource } from '../../agent/plugins/source.js';
import { installFromMarketplace } from '../../agent/marketplaces/resolve.js';
import { getPluginsDir, getPluginsIndexPath } from '../../paths.js';

/**
 * Injection points for tests. Defaults to real implementations calling into
 * `~/.afk/plugins/`.
 */
export interface PluginCommandDeps extends InstallDeps, UpdateDeps {
  logger?: Pick<Console, 'log' | 'error'>;
}

export function registerPluginCommand(program: Command, deps: PluginCommandDeps = {}): void {
  const logger = deps.logger ?? console;
  const pluginsDir = deps.pluginsDir ?? getPluginsDir();
  const indexPath = deps.indexPath ?? getPluginsIndexPath();
  const moduleDeps = { ...deps, pluginsDir, indexPath };

  const plugin = program
    .command('plugin')
    .description('Manage AFK plugins (install / update / list / remove / enable / disable)');

  plugin
    .command('install <source> [name]')
    .description('Install a plugin from a git URL, owner/repo shorthand, local path, or <marketplace>:<plugin>')
    .option('-r, --ref <ref>', 'Install a specific tag, branch, or SHA')
    .option('-f, --force', 'Replace an existing plugin with the same name')
    .option('-y, --yes', 'Skip the install warning and countdown (non-interactive / CI)')
    .action(async (source: string, name: string | undefined, cmdOpts: { ref?: string; force?: boolean; yes?: boolean }) => {
      // Route `<mp>:<plugin>` shorthand to the marketplace resolver before
      // hitting installPlugin, which doesn't know about marketplaces.
      let parsed;
      try {
        parsed = parseSource(source);
      } catch (err) {
        const spinner = ora(`Installing ${source}…`).start();
        spinner.fail('Failed');
        handleCommandError(err);
      }
      // Gate the install warning on STDERR's TTY status, not stdin's. The
      // warning is written to stderr; if stderr is being read by a human in a
      // visible terminal, the countdown serves its purpose (audit + Ctrl-C).
      // Stdin status is the wrong signal — `echo y | afk plugin install …`
      // pipes stdin but still emits the warning to a visible stderr.
      const isInteractive = process.stderr.isTTY === true && !cmdOpts.yes;

      if (parsed.type === 'marketplace-ref') {
        const spinner = ora(`Installing ${parsed.marketplace}:${parsed.plugin}…`).start();
        try {
          // Thread `confirm` through the marketplace fanout. Without this,
          // git-sourced plugins resolved via a marketplace still trip the
          // default `confirm: true` and block for 3 s even when stderr is not
          // a TTY (CI) or the user passed --yes.
          const result = await installFromMarketplace(
            parsed.marketplace,
            parsed.plugin,
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
        return;
      }

      const spinner = ora(`Installing ${source}…`).start();
      try {
        const opts: InstallOptions = {
          ...(name ? { name } : {}),
          ...(cmdOpts.ref ? { ref: cmdOpts.ref } : {}),
          ...(cmdOpts.force ? { force: true } : {}),
        };
        const result = await installPlugin(source, opts, {
          ...moduleDeps,
          confirm: isInteractive,
        });
        spinner.succeed(
          palette.success(`Installed ${palette.bold(result.name)}`) +
            palette.meta(
              ` at ${result.dir}${result.entry.ref ? ` (ref: ${result.entry.ref})` : ''}`,
            ),
        );
      } catch (err) {
        spinner.fail('Failed');
        handleCommandError(err);
      }
    });

  plugin
    .command('update [name]')
    .description('Update one plugin, or all if no name is given')
    .option('-r, --ref <ref>', 'Pin to a specific ref instead of the latest tag')
    .action(async (name: string | undefined, cmdOpts: { ref?: string }) => {
      try {
        if (name) {
          const spinner = ora(`Updating ${name}…`).start();
          const outcome = await updatePlugin(
            name,
            cmdOpts.ref ? { ref: cmdOpts.ref } : {},
            moduleDeps,
          );
          printOutcome(outcome, spinner);
        } else {
          logger.log(palette.info('Updating all plugins…'));
          const outcomes = await updateAll(moduleDeps);
          if (outcomes.length === 0) {
            logger.log(palette.meta('  (nothing installed)'));
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

  plugin
    .command('list')
    .description('List installed plugins with their source, version, and enabled state')
    .option('-f, --format <format>', 'Output format (text|json)', 'text')
    .action((options: { format: string }) => {
      const idx = readIndex(indexPath);
      if (options.format === 'json') {
        const plugins = Object.entries(idx.plugins).map(([name, entry]) => ({
          name,
          enabled: entry.enabled,
          ...(entry.ref ? { ref: entry.ref } : {}),
          source: entry.source,
        }));
        logger.log(JSON.stringify({ plugins }, null, 2));
      } else {
        renderList(idx, logger);
      }
    });

  plugin
    .command('remove <name>')
    .description('Remove a plugin (directory + index entry)')
    .action((name: string) => {
      const result = removePlugin(name, { pluginsDir, indexPath });
      if (!result.removedDir && !result.removedIndexEntry) {
        logger.log(palette.meta(`No plugin named "${name}" to remove.`));
        return;
      }
      const bits = [
        result.removedDir ? 'directory' : null,
        result.removedIndexEntry ? 'index entry' : null,
      ].filter(Boolean);
      logger.log(palette.success(`Removed ${name}: ${bits.join(' + ')}`));
    });

  plugin
    .command('enable <name>')
    .description('Re-enable a previously disabled plugin')
    .action((name: string) => {
      try {
        setEnabled(name, true, indexPath);
        logger.log(palette.success(`Enabled ${name}`));
      } catch (err) {
        handleCommandError(err);
      }
    });

  plugin
    .command('disable <name>')
    .description('Keep the plugin on disk but skip it from SDK init')
    .action((name: string) => {
      try {
        setEnabled(name, false, indexPath);
        logger.log(palette.warning(`Disabled ${name} (dir preserved at ${pluginsDir}/${name})`));
      } catch (err) {
        handleCommandError(err);
      }
    });
}

function renderList(index: PluginIndex, logger: Pick<Console, 'log'>): void {
  const names = Object.keys(index.plugins).sort();
  if (names.length === 0) {
    logger.log(palette.meta('No plugins installed.'));
    logger.log(palette.meta('  Try: afk plugin install anthropics/claude-plugins-official'));
    return;
  }
  logger.log(palette.heading('\nInstalled plugins:'));
  for (const name of names) {
    const e = index.plugins[name];
    if (!e) continue;
    const state = e.enabled ? palette.success('enabled ') : palette.warning('disabled');
    const version = e.ref ? palette.info(e.ref) : palette.meta('(local)');
    const source = palette.meta(e.source);
    logger.log(`  ${palette.bold(name.padEnd(30))} ${state}  ${version.padEnd(12)}  ${source}`);
  }
  logger.log('');
}

function formatOutcome(o: UpdateOutcome): string {
  switch (o.status) {
    case 'updated': {
      // Branch-tracked installs report fromRef === toRef (e.g. "main"); the
      // commit moved even though the ref name didn't, so show the short SHA.
      const refPart =
        o.fromRef === o.toRef
          ? `${o.toRef} @ ${o.commit.slice(0, 7)}`
          : `${o.fromRef ?? '(none)'} → ${o.toRef}`;
      const vPart = o.version ? palette.meta(`  [v${o.version.replace(/^v/i, '')}]`) : '';
      return `${palette.success('✓')} ${palette.bold(o.name)}: ${refPart}${vPart}`;
    }
    case 'up-to-date': {
      const vPart = o.version ? palette.meta(` [v${o.version.replace(/^v/i, '')}]`) : '';
      return `${palette.meta('·')} ${palette.bold(o.name)}: up-to-date (${o.ref})${vPart}`;
    }
    case 'skipped-local':
      return `${palette.meta('·')} ${palette.bold(o.name)}: skipped (local source)`;
    case 'missing-dir':
      return `${palette.warning('!')} ${palette.bold(o.name)}: plugin dir missing (${o.dir})`;
  }
}

function printOutcome(o: UpdateOutcome, spinner: ReturnType<typeof ora>): void {
  const line = formatOutcome(o);
  if (o.status === 'updated') spinner.succeed(line);
  else if (o.status === 'up-to-date') spinner.info(line);
  else if (o.status === 'skipped-local') spinner.info(line);
  else spinner.warn(line);
}
