/**
 * REPL slash commands for marketplace browsing and install.
 *
 * Two commands registered:
 *   - `/marketplaces` — list installed marketplaces.
 *   - `/marketplace <subcommand>` — `add`, `plugins`, `install`, `remove`,
 *     `update`. Sub-dispatched on the first whitespace-delimited arg, with
 *     a `/help`-style usage hint when called bare.
 *
 * After installing a plugin from a marketplace, the user must run
 * `/reload-plugins` (in plugin-skills.ts) to refresh the active session's
 * slash registry.
 *
 * @module cli/slash/marketplace-browse
 */

import { palette } from '../palette.js';
import {
  installMarketplace,
  type MarketplaceInstallOptions,
} from '../../agent/marketplaces/install.js';
import { removeMarketplace } from '../../agent/marketplaces/remove.js';
import { updateMarketplace } from '../../agent/marketplaces/update.js';
import {
  installFromMarketplace,
  listMarketplacePlugins,
} from '../../agent/marketplaces/resolve.js';
import { readIndex } from '../../agent/plugins/index-store.js';
import { register } from './registry.js';
import type { SlashCommand, SlashContext, SlashResult } from './types.js';

const SUBCOMMANDS = ['add', 'plugins', 'install', 'remove', 'update'] as const;

const marketplacesCmd: SlashCommand = {
  name: '/marketplaces',
  summary: 'List installed plugin marketplaces',
  async handler(ctx) {
    renderList(ctx);
    return 'continue';
  },
};

const marketplaceCmd: SlashCommand = {
  name: '/marketplace',
  summary: 'Manage plugin marketplaces (add | plugins | install | remove | update)',
  usage: '/marketplace <add|plugins|install|remove|update> [args]',
  async handler(ctx, args) {
    const trimmed = args.trim();
    if (!trimmed) {
      printUsage(ctx);
      return 'continue';
    }
    const [sub, ...rest] = trimmed.split(/\s+/);
    if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
      ctx.out.error(`Unknown subcommand "${sub ?? ''}". Try one of: ${SUBCOMMANDS.join(', ')}.`);
      return 'continue';
    }
    switch (sub) {
      case 'add':
        return handleAdd(ctx, rest);
      case 'plugins':
        return handlePlugins(ctx, rest);
      case 'install':
        return handleInstall(ctx, rest);
      case 'remove':
        return handleRemove(ctx, rest);
      case 'update':
        return handleUpdate(ctx, rest);
      default:
        return 'continue';
    }
  },
};

export function registerMarketplaceCommands(): void {
  register(marketplacesCmd);
  register(marketplaceCmd);
}

function renderList(ctx: SlashContext): void {
  const idx = readIndex();
  const entries = Object.entries(idx.marketplaces).sort(([a], [b]) => a.localeCompare(b));
  ctx.out.line();
  if (entries.length === 0) {
    ctx.out.line(palette.dim('  No marketplaces installed.'));
    ctx.out.line(
      palette.dim('  Try: /marketplace add anthropics/claude-plugins-official'),
    );
    ctx.out.line();
    return;
  }
  ctx.out.line(palette.bold('Installed marketplaces:'));
  for (const [name, entry] of entries) {
    const ref = entry.ref ? palette.brand(entry.ref) : palette.dim('(local)');
    ctx.out.line(
      `  ${palette.bold(name.padEnd(28))} ${ref.padEnd(12)}  ${palette.dim(entry.source)}`,
    );
  }
  ctx.out.line();
}

function printUsage(ctx: SlashContext): void {
  ctx.out.line();
  ctx.out.line(palette.bold('/marketplace usage:'));
  ctx.out.line(`  ${palette.brand('/marketplace add')} <git-url|owner/repo|local-path>`);
  ctx.out.line(`  ${palette.brand('/marketplace plugins')} <marketplace>`);
  ctx.out.line(`  ${palette.brand('/marketplace install')} <marketplace> <plugin>`);
  ctx.out.line(`  ${palette.brand('/marketplace remove')} <marketplace>`);
  ctx.out.line(`  ${palette.brand('/marketplace update')} [<marketplace>]`);
  ctx.out.line();
}

async function handleAdd(ctx: SlashContext, rest: string[]): Promise<SlashResult> {
  if (rest.length === 0) {
    ctx.out.error('Usage: /marketplace add <source> [name]');
    return 'continue';
  }
  const [source, name, ...flagsRaw] = rest;
  if (!source) {
    ctx.out.error('Usage: /marketplace add <source> [name]');
    return 'continue';
  }
  const opts = parseFlags(flagsRaw);
  ctx.out.info(`Installing marketplace ${source}…`);
  try {
    const result = await installMarketplace(
      source,
      {
        ...(name && !name.startsWith('-') ? { name } : {}),
        ...(opts.ref ? { ref: opts.ref } : {}),
        ...(opts.force ? { force: true } : {}),
      } as MarketplaceInstallOptions,
    );
    ctx.out.success(
      `Installed marketplace ${result.name} (${result.plugins.length} plugin(s) available).`,
    );
    ctx.out.line(palette.dim(`  Next: /marketplace plugins ${result.name}`));
  } catch (err) {
    ctx.out.error(`Install failed: ${errorMsg(err)}`);
  }
  return 'continue';
}

function handlePlugins(ctx: SlashContext, rest: string[]): SlashResult {
  const name = rest[0];
  if (!name) {
    ctx.out.error('Usage: /marketplace plugins <marketplace>');
    return 'continue';
  }
  try {
    const plugins = listMarketplacePlugins(name);
    ctx.out.line();
    if (plugins.length === 0) {
      ctx.out.line(palette.dim(`  Marketplace "${name}" lists no plugins.`));
      ctx.out.line();
      return 'continue';
    }
    ctx.out.line(palette.bold(`Plugins in ${name}:`));
    plugins.forEach((p, i) => {
      const marker = p.installed ? palette.brand('[✓]') : palette.dim('[ ]');
      const desc = p.description ? palette.dim(` — ${p.description}`) : '';
      ctx.out.line(
        `  ${marker} ${palette.bold(String(i + 1).padStart(2))}. ${palette.bold(p.name)}${desc}`,
      );
    });
    ctx.out.line();
    ctx.out.line(palette.dim(`  Install one: /marketplace install ${name} <plugin>`));
    ctx.out.line();
  } catch (err) {
    ctx.out.error(`List failed: ${errorMsg(err)}`);
  }
  return 'continue';
}

async function handleInstall(ctx: SlashContext, rest: string[]): Promise<SlashResult> {
  let marketplace: string | undefined;
  let plugin: string | undefined;
  // Accept either `<mp> <plugin>` or `<mp>:<plugin>` for parity with the CLI.
  if (rest.length === 1 && rest[0]?.includes(':')) {
    const parts = rest[0].split(':');
    if (parts.length === 2) {
      [marketplace, plugin] = parts;
    }
  } else {
    [marketplace, plugin] = rest;
  }
  if (!marketplace || !plugin) {
    ctx.out.error('Usage: /marketplace install <marketplace> <plugin>');
    return 'continue';
  }
  ctx.out.info(`Installing ${marketplace}:${plugin}…`);
  try {
    const result = await installFromMarketplace(marketplace, plugin);
    ctx.out.success(`Installed ${result.key}.`);
    ctx.out.line(
      palette.dim('  Run /reload-plugins to refresh this session\'s slash commands.'),
    );
  } catch (err) {
    ctx.out.error(`Install failed: ${errorMsg(err)}`);
  }
  return 'continue';
}

function handleRemove(ctx: SlashContext, rest: string[]): SlashResult {
  const name = rest[0];
  if (!name) {
    ctx.out.error('Usage: /marketplace remove <marketplace>');
    return 'continue';
  }
  const result = removeMarketplace(name);
  if (
    !result.removedDir &&
    !result.removedIndexEntry &&
    result.removedPluginEntries.length === 0
  ) {
    ctx.out.line(palette.dim(`  No marketplace named "${name}" to remove.`));
    return 'continue';
  }
  const cascaded =
    result.removedPluginEntries.length > 0
      ? ` + ${result.removedPluginEntries.length} plugin(s)`
      : '';
  ctx.out.success(`Removed marketplace ${name}${cascaded}.`);
  return 'continue';
}

async function handleUpdate(ctx: SlashContext, rest: string[]): Promise<SlashResult> {
  const name = rest[0];
  if (!name) {
    ctx.out.error('Usage: /marketplace update <marketplace>');
    return 'continue';
  }
  ctx.out.info(`Updating ${name}…`);
  try {
    const outcome = await updateMarketplace(name);
    switch (outcome.status) {
      case 'updated': {
        const added =
          outcome.addedPlugins.length > 0
            ? ` +${outcome.addedPlugins.join(', ')}`
            : '';
        const removed =
          outcome.removedPlugins.length > 0
            ? ` -${outcome.removedPlugins.join(', ')}`
            : '';
        ctx.out.success(
          `Updated ${name}: ${outcome.fromRef ?? '(none)'} → ${outcome.toRef}${added}${removed}`,
        );
        break;
      }
      case 'up-to-date':
        ctx.out.info(`${name} is up-to-date (${outcome.ref}).`);
        break;
      case 'skipped-local':
        ctx.out.info(`${name} skipped (local source).`);
        break;
      case 'missing-dir':
        ctx.out.warn(`${name}: marketplace dir missing (${outcome.dir}).`);
        break;
    }
  } catch (err) {
    ctx.out.error(`Update failed: ${errorMsg(err)}`);
  }
  return 'continue';
}

function parseFlags(args: string[]): { ref?: string; force?: boolean } {
  const out: { ref?: string; force?: boolean } = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-f' || arg === '--force') {
      out.force = true;
    } else if ((arg === '-r' || arg === '--ref') && args[i + 1]) {
      out.ref = args[i + 1];
      i += 1;
    }
  }
  return out;
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
