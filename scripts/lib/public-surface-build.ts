/** Live registry discovery. Run only through isolated-reference.ts surface.
 * Ordinary consumers use public-surface.ts, which never imports registrars.
 */
import { Command, type Option } from 'commander';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildCli } from '../render-cli-reference.js';
import { collectSlash } from '../render-slash-commands.js';
import { collectCoverageNames, schemaNames } from '../check-docs-coverage.js';
import { CONFIG_KEY_SPECS } from '../../src/config/settable-keys.js';
import { ENV_REGISTRY } from '../../src/config/env.js';
import { repoRoot } from './docs-reference.js';
import { symbolKey, type Surface, type SurfaceSymbol } from './public-surface.js';

function posixRelative(root: string, file: string): string { return relative(root, file).split('\\').join('/'); }

/** Capture the real registration callsite, including options added by helpers.
 * External constraint: registration is synchronous and metadata-only; restore
 * prototypes in finally before returning or propagating any registration error.
 * No command action, parser, or asynchronous work runs while hooks are installed.
 */
function registeredCli(root: string): { program: Command; commands: WeakMap<Command, string>; options: WeakMap<Option, string> } {
  const commands = new WeakMap<Command, string>();
  const options = new WeakMap<Option, string>();
  const originalCommand = Command.prototype.command;
  const originalOption = Command.prototype.addOption;
  function callsite(): string | undefined {
    for (const line of new Error().stack?.split('\n') ?? []) {
      const match = /(?:\(|\s)((?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^()]+?):\d+:\d+\)?$/.exec(line);
      if (!match) continue;
      const file = match[1]!.startsWith('file:') ? fileURLToPath(match[1]!) : match[1]!;
      const local = posixRelative(root, file);
      if (local.startsWith('src/')) return local;
    }
    return undefined;
  }
  // Commander overloads include a returning-parent executable form. Our override
  // preserves the complete overload type and the exact arguments/result.
  Command.prototype.command = function (this: Command, ...args: unknown[]) {
    const command = Reflect.apply(originalCommand, this, args) as Command;
    const source = callsite();
    if (source) commands.set(command, source);
    return command;
  } as typeof originalCommand;
  Command.prototype.addOption = function (this: Command, option: Option) {
    const source = callsite();
    if (source) options.set(option, source);
    return originalOption.call(this, option);
  };
  try { return { program: buildCli(), commands, options }; }
  finally { Command.prototype.command = originalCommand; Command.prototype.addOption = originalOption; }
}

/** Public Commander traversal, with global options emitted only under afk. */
export function cliSymbols(program: Command, sourceOf: (cmd: Command, option?: Option) => string | undefined = () => undefined): SurfaceSymbol[] {
  const symbols: SurfaceSymbol[] = [];
  function visit(cmd: Command, ancestors: string[]): void {
    const name = [...ancestors, cmd.name()].join(' ');
    const source = sourceOf(cmd);
    symbols.push({ kind: 'command', name, ...(source ? { source } : {}) });
    for (const option of cmd.createHelp().visibleOptions(cmd)) {
      if (!option.long) continue;
      const declaration = sourceOf(cmd, option) ?? source;
      symbols.push({ kind: 'flag', name: `${name} ${option.long}`, ...(declaration ? { source: declaration } : {}) });
    }
    for (const child of cmd.createHelp().visibleCommands(cmd).filter((child) => cmd.commands.includes(child))) {
      visit(child, [...ancestors, cmd.name()]);
    }
  }
  visit(program, []);
  return symbols;
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith('__') ? [] : files(file);
    return entry.name.endsWith('.ts') && !/\.(?:test|d)\.ts$/.test(entry.name) ? [file] : [];
  }).sort();
}

/** Literal name properties locate declarations, never aliases or prose. */
function nameSources(root: string, paths: readonly string[]): Map<string, string> {
  const matches = new Map<string, Set<string>>();
  for (const file of paths) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
        && node.name.text === 'name' && ts.isStringLiteralLike(node.initializer)) {
        const name = node.initializer.text;
        const entries = matches.get(name) ?? new Set<string>();
        entries.add(posixRelative(root, file));
        matches.set(name, entries);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return new Map([...matches].filter(([, entries]) => entries.size === 1).map(([name, entries]) => [name, [...entries][0]!]));
}

/** Deterministic kind/name order; source paths always use repository separators. */
export function sortSurface(symbols: readonly SurfaceSymbol[]): Surface {
  const unique = new Map<string, SurfaceSymbol>();
  for (const symbol of symbols) {
    const key = symbolKey(symbol);
    if (unique.has(key)) throw new Error(`Duplicate discovered symbol ${key}`);
    unique.set(key, symbol);
  }
  return { version: 1, symbols: [...unique.values()].sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
}

export function buildPublicSurface(root = repoRoot): Surface {
  const cli = registeredCli(root);
  const symbols = cliSymbols(cli.program, (cmd, option) => option
    ? cli.options.get(option) ?? (cmd === cli.program ? 'src/cli/index.ts' : cli.commands.get(cmd))
    : cmd === cli.program ? 'src/cli/index.ts' : cli.commands.get(cmd));
  const slash = collectSlash();
  const sources = nameSources(root, [...files(join(root, 'src/cli/slash')), ...files(join(root, 'src/skills'))]);
  const envSources = nameSources(root, files(join(root, 'src/config')).filter((file) => /[/\\]env(?:\.[^/\\]+)?\.ts$/.test(file)));
  for (const cmd of [...slash.core, ...slash.skills]) {
    const source = sources.get(cmd.name) ?? sources.get(cmd.name.slice(1));
    symbols.push({ kind: 'slash', name: cmd.name, ...(source ? { source } : {}) });
  }
  const coverage = collectCoverageNames(root);
  const toolSources = new Map<string, string>();
  for (const source of coverage.sources) {
    for (const name of schemaNames(readFileSync(join(root, source), 'utf8'), source)) {
      if (!toolSources.has(name)) toolSources.set(name, source.split('\\').join('/'));
    }
  }
  symbols.push(...coverage.tools.map((name): SurfaceSymbol => ({ kind: 'tool', name, source: toolSources.get(name)! })),
    ...coverage.hooks.map((name): SurfaceSymbol => ({ kind: 'hook', name, source: 'src/agent/hooks.ts' })),
    ...CONFIG_KEY_SPECS.map((key): SurfaceSymbol => ({ kind: 'config', name: key.path, source: 'src/config/settable-keys.ts' })),
    // Match render-env-registry.ts: it publishes all ENV_REGISTRY categories.
    ...ENV_REGISTRY.map((entry): SurfaceSymbol => ({ kind: 'env', name: entry.name, source: envSources.get(entry.name) ?? 'src/config/env.ts' })));
  return sortSurface(symbols);
}
