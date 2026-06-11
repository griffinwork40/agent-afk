/**
 * REPL slash commands for marketplace browsing and install.
 *
 * Two commands registered:
 *   - `/marketplaces` — list installed marketplaces.
 *   - `/marketplace <subcommand>` — `install`, `install-plugin`, `plugins`,
 *     `remove`, `update`, `list`. Sub-dispatched on the first
 *     whitespace-delimited arg, with a `/help`-style usage hint when called
 *     bare.
 *
 * Verb alignment with the CLI (`afk marketplace …`):
 *   - `/marketplace install <source> [name]`        → install a marketplace
 *   - `/marketplace install-plugin <mp> <plugin>`   → install a plugin from one
 *   - `/marketplace list`                           → alias for /marketplaces
 *
 * Backward compatibility (deprecated aliases, emit a one-line warning):
 *   - `/marketplace add <source>`                   → routes to install (warns)
 *   - `/marketplace install <mp> <plugin>` (2 args) → routes to install-plugin (warns)
 *   - `/marketplace install <mp>:<plugin>` (colon)  → routes to install-plugin (warns)
 *
 * Disambiguation for `/marketplace install`:
 *   - 1 bare arg (no colon) → new canonical: install a marketplace.
 *   - 2 args OR single arg with colon → legacy: install a plugin (warn → install-plugin).
 *   This is safe because the 2-arg form was previously the only accepted form
 *   and a single arg with no colon was a usage error.
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

const SUBCOMMANDS = ['install', 'install-plugin', 'plugins', 'remove', 'update', 'list', 'add'] as const;

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
  summary: 'Manage plugin marketplaces (install | install-plugin | plugins | remove | update)',
  usage: '/marketplace <install|install-plugin|plugins|remove|update|list> [args]',
  async handler(ctx, args) {
    const trimmed = args.trim();
    if (!trimmed) {
      printUsage(ctx);
      return 'continue';
    }
    const [sub, ...rest] = trimmed.split(/\s+/);
    if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
      ctx.out.error(`Unknown subcommand "${sub ?? ''}". Try one of: install, install-plugin, plugins, remove, update.`);
      return 'continue';
    }
    switch (sub) {
      case 'install':
        return handleInstall(ctx, rest);
      case 'install-plugin':
        return handleInstallPlugin(ctx, rest);
      case 'plugins':
        return handlePlugins(ctx, rest);
      case 'remove':
        return handleRemove(ctx, rest);
      case 'update':
        return handleUpdate(ctx, rest);
      case 'list':
        renderList(ctx);
        return 'continue';
      case 'add':
        return handleAddDeprecated(ctx, rest);
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
      palette.dim('  Try: /marketplace install anthropics/claude-plugins-official'),
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
  ctx.out.line(`  ${palette.brand('/marketplace install')} <git-url|owner/repo|local-path> [name]`);
  ctx.out.line(`  ${palette.brand('/marketplace install-plugin')} <marketplace> <plugin>`);
  ctx.out.line(`  ${palette.brand('/marketplace plugins')} <marketplace>`);
  ctx.out.line(`  ${palette.brand('/marketplace remove')} <marketplace>`);
  ctx.out.line(`  ${palette.brand('/marketplace update')} [<marketplace>]`);
  ctx.out.line(`  ${palette.brand('/marketplace list')}`);
  ctx.out.line();
}

/** Canonical: install a marketplace from a source URL / owner/repo / local path. */
async function handleMarketplaceInstall(ctx: SlashContext, rest: string[]): Promise<SlashResult> {
  if (rest.length === 0) {
    ctx.out.error('Usage: /marketplace install <source> [name]');
    return 'continue';
  }
  const [source, name, ...flagsRaw] = rest;
  if (!source) {
    ctx.out.error('Usage: /marketplace install <source> [name]');
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

/**
 * Dispatch for `/marketplace install`:
 * - 1 bare arg (no colon, or colon that looks like a URL scheme) → canonical marketplace install.
 * - 2 args OR single `<mp>:<plugin>` colon form (not a URL scheme) → legacy plugin install (warn).
 *
 * // Invariant: A colon in a single arg is the legacy plugin-colon form ONLY when
 * // it does not follow a known URL scheme prefix (https, http, git, ssh, file).
 * // This lets `install https://example.com/my-mp` route to marketplace install
 * // while `install my-mp:plugA` still routes to the legacy warn path.
 */
async function handleInstall(ctx: SlashContext, rest: string[]): Promise<SlashResult> {
  // Colon form: `<mp>:<plugin>` — legacy plugin install.
  // Exclude URL-scheme colons (https://, http://, git://, ssh://, file://).
  if (rest.length === 1 && isColonPluginForm(rest[0])) {
    return handleLegacyInstallPlugin(ctx, rest);
  }
  // Two positional args: `<mp> <plugin>` — legacy plugin install.
  if (rest.length >= 2) {
    return handleLegacyInstallPlugin(ctx, rest);
  }
  // Single bare arg (or URL): canonical marketplace install.
  return handleMarketplaceInstall(ctx, rest);
}

/**
 * Returns true when a single arg looks like the legacy `<marketplace>:<plugin>` colon
 * form — i.e. contains a colon that is NOT a URL-scheme separator (https:, http:, etc.).
 */
function isColonPluginForm(arg: string | undefined): arg is string {
  if (!arg || !arg.includes(':')) return false;
  // URL schemes are word-only characters before the colon followed by `//`.
  // If the arg matches a URL scheme pattern, it is a source URL, not mp:plugin.
  return !/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(arg);
}

/**
 * Legacy: `/marketplace install <mp> <plugin>` or `/marketplace install <mp>:<plugin>`.
 * Emits a deprecation warning then routes to the plugin installer.
 */
async function handleLegacyInstallPlugin(ctx: SlashContext, rest: string[]): Promise<SlashResult> {
  ctx.out.warn(
    'Deprecated: use `/marketplace install-plugin <marketplace> <plugin>` instead.',
  );
  return doInstallPlugin(ctx, rest);
}

/** Canonical: `/marketplace install-plugin <marketplace> <plugin>`. */
async function handleInstallPlugin(ctx: SlashContext, rest: string[]): Promise<SlashResult> {
  return doInstallPlugin(ctx, rest);
}

/** Shared implementation for both the canonical and legacy plugin-install paths. */
async function doInstallPlugin(ctx: SlashContext, rest: string[]): Promise<SlashResult> {
  let marketplace: string | undefined;
  let plugin: string | undefined;
  // Accept either `<mp> <plugin>` or `<mp>:<plugin>`.
  if (rest.length === 1 && rest[0]?.includes(':')) {
    const parts = rest[0].split(':');
    if (parts.length === 2) {
      [marketplace, plugin] = parts;
    }
  } else {
    [marketplace, plugin] = rest;
  }
  if (!marketplace || !plugin) {
    ctx.out.error('Usage: /marketplace install-plugin <marketplace> <plugin>');
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

/** Deprecated: `/marketplace add <source>` — routes to canonical marketplace install. */
async function handleAddDeprecated(ctx: SlashContext, rest: string[]): Promise<SlashResult> {
  ctx.out.warn(
    'Deprecated: use `/marketplace install <source>` instead.',
  );
  return handleMarketplaceInstall(ctx, rest);
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
    ctx.out.line(palette.dim(`  Install one: /marketplace install-plugin ${name} <plugin>`));
    ctx.out.line();
  } catch (err) {
    ctx.out.error(`List failed: ${errorMsg(err)}`);
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
