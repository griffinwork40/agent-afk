/** Known-symbol index for check-docs-refs. Built from committed data only:
 * docs/public-surface.json (via public-surface.ts), the generated reference
 * pages (aliases and short flags the snapshot does not carry), and static
 * text/AST reads of a few source files. No src/ registrar is imported.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { loadPublicSurface, type Surface } from './public-surface.js';

export type OptionArity = 'required' | 'optional';
/** `args` holds value-taking options only, derived from the generated CLI reference. */
export interface CommandInfo { path: string; flags: Set<string>; children: Set<string>; args: Map<string, OptionArity> }
export interface CliRefEntry { aliases: string[]; flags: string[]; args: Record<string, OptionArity> }
export interface KnownRefs {
  env: Set<string>;
  /** Canonical command path keyed by every spelling (aliases included). */
  commands: Map<string, CommandInfo>;
  slash: Set<string>;
  tools: Set<string>;
  hooks: Set<string>;
  /** Config dotted paths; `*` children mark map-like keys. */
  config: Set<string>;
  configRoots: Set<string>;
}

/** Tools injected at fork time, invisible to the static coverage scan.
 * Each entry names the source file that must still declare it (tested). */
export const DYNAMIC_TOOLS: Readonly<Record<string, string>> = {
  emit_progress: 'src/agent/tools/subagent/emit-progress.ts',
};
/** Third-party commands the docs legitimately name (Telegram's BotFather). */
export const EXTERNAL_SLASH: readonly string[] = ['/newbot', '/setprivacy'];

/** Aliases, short flags, and option arity (`<v>` required, `[v]` optional)
 * from the generated CLI reference, keyed by path. */
export function parseCliReference(text: string): Map<string, CliRefEntry> {
  const out = new Map<string, CliRefEntry>();
  let current: CliRefEntry | undefined;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^## `(afk(?: [^`]+)?)`$/.exec(line);
    if (heading) { current = { aliases: [], flags: [], args: {} }; out.set(heading[1]!, current); continue; }
    if (!current) continue;
    const alias = /^Aliases: (.*)$/.exec(line);
    if (alias) current.aliases.push(...[...alias[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
    const flag = /^\| `(-[^`]+)` \|/.exec(line);
    if (!flag) continue;
    const names = [...flag[1]!.matchAll(/(?:^|[ ,])(--?[A-Za-z0-9][\w-]*)/g)].map((m) => m[1]!);
    current.flags.push(...names);
    const value = /\s([<[])/.exec(flag[1]!.replace(/&lt;/g, '<'));
    if (value) for (const name of names) current.args[name] = value[1] === '<' ? 'required' : 'optional';
  }
  return out;
}

/** Slash aliases from the generated slash reference. */
export function parseSlashAliases(text: string): string[] {
  return [...text.matchAll(/^Aliases: (.*)$/gm)].flatMap((m) => [...m[1]!.matchAll(/`(\/[^`]+)`/g)].map((a) => a[1]!));
}

/** Commands registered on the Telegram bot (`bot.command('x')` / arrays). */
export function telegramCommands(root: string): string[] {
  const dir = join(root, 'src/telegram');
  return readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).flatMap((file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    return [...text.matchAll(/bot\.command\(\s*(\[[^\]]*\]|'[^']+'|"[^"]+")/g)]
      .flatMap((m) => [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((n) => `/${n[1]}`));
  });
}

/** Skills shipped by bundled plugins (invoked as /name in the REPL). */
export function bundledSkills(root: string): string[] {
  const base = join(root, 'src/bundled-plugins');
  return readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((plugin) => {
    const skills = join(base, plugin.name, 'skills');
    return existsSync(skills) ? readdirSync(skills).map((name) => `/${name}`) : [];
  });
}

/** Dotted paths of the on-disk config schema (ConfigFileSchema), including
 * file-only keys CONFIG_KEY_SPECS does not make settable. Object literal types
 * recurse; primitives/literals/arrays are leaves; anything else (Record,
 * interfaces, unions with objects) is a map-like key and gets a `*` child. */
export function configSchemaPaths(source: string): string[] {
  const file = ts.createSourceFile('types.ts', source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const leaf = (type: ts.TypeNode): boolean => {
    if (ts.isUnionTypeNode(type)) return type.types.every(leaf);
    if (ts.isArrayTypeNode(type) || ts.isLiteralTypeNode(type)) return true;
    return [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword].includes(type.kind);
  };
  const walk = (members: ts.NodeArray<ts.TypeElement>, prefix: string): void => {
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.type || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) continue;
      const path = prefix + member.name.text;
      out.push(path);
      if (ts.isTypeLiteralNode(member.type)) walk(member.type.members, `${path}.`);
      else if (!leaf(member.type)) out.push(`${path}.*`);
    }
  };
  file.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'ConfigFileSchema') walk(node.members, '');
  });
  return out;
}

export function buildKnown(surface: Surface, root: string): KnownRefs {
  const names = (kind: string): string[] => surface.symbols.filter((s) => s.kind === kind).map((s) => s.name);
  const cliRef = parseCliReference(readFileSync(join(root, 'website/content/docs/reference/cli.mdx'), 'utf8'));
  const commands = new Map<string, CommandInfo>();
  const info = new Map<string, CommandInfo>();
  for (const path of names('command')) info.set(path, { path, flags: new Set(cliRef.get(path)?.flags ?? []), children: new Set(), args: new Map(Object.entries(cliRef.get(path)?.args ?? {})) });
  for (const flag of names('flag')) {
    const at = flag.lastIndexOf(' ');
    info.get(flag.slice(0, at))?.flags.add(flag.slice(at + 1));
  }
  // Spellings: every alias of every ancestor segment resolves to the canonical path.
  const spellings = (path: string): string[] => {
    const words = path.split(' ');
    let prefixes = ['afk'];
    for (let i = 1; i < words.length; i++) {
      const canonical = words.slice(0, i + 1).join(' ');
      const forms = [words[i]!, ...(cliRef.get(canonical)?.aliases ?? [])];
      prefixes = prefixes.flatMap((p) => forms.map((f) => `${p} ${f}`));
    }
    return prefixes;
  };
  for (const [path, entry] of info) {
    for (const spelling of spellings(path)) commands.set(spelling, entry);
    const parent = info.get(path.slice(0, path.lastIndexOf(' ')));
    if (path !== 'afk' && parent) {
      parent.children.add(path.split(' ').at(-1)!);
      for (const alias of cliRef.get(path)?.aliases ?? []) parent.children.add(alias);
    }
  }
  const slashRef = readFileSync(join(root, 'website/content/docs/reference/slash-commands.mdx'), 'utf8');
  const config = new Set([...names('config'), ...configSchemaPaths(readFileSync(join(root, 'src/cli/config/types.ts'), 'utf8'))]);
  for (const spec of surface.symbols.filter((s) => s.kind === 'config')) {
    // Model-slot and object-typed keys accept map-style children.
    if (/^models\./.test(spec.name) || ['disabledPluginHooks', 'pluginHookEnv'].includes(spec.name)) config.add(`${spec.name}.*`);
  }
  return {
    env: new Set(names('env')),
    commands,
    slash: new Set([...names('slash'), ...parseSlashAliases(slashRef), ...telegramCommands(root), ...bundledSkills(root), ...EXTERNAL_SLASH]),
    tools: new Set([...names('tool'), ...Object.keys(DYNAMIC_TOOLS)]),
    hooks: new Set(names('hook')),
    config,
    configRoots: new Set([...config].filter((p) => p.includes('.')).map((p) => p.split('.')[0]!)),
  };
}

export async function loadKnown(root: string): Promise<KnownRefs> {
  return buildKnown(await loadPublicSurface(root), root);
}
