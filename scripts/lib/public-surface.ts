/** Stable, side effect free API for the committed public surface.
 * Consumers must import this module, not public-surface-build (live registrars).
 * All root parameters are absolute repository roots, defaulting to this checkout.
 */
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoRoot } from './docs-reference.js';

export const SYMBOL_KINDS = ['command', 'flag', 'slash', 'tool', 'config', 'env', 'hook'] as const;
export type SymbolKind = typeof SYMBOL_KINDS[number];
export interface SurfaceSymbol { kind: SymbolKind; name: string; source?: string }
export interface Surface { version: 1; symbols: SurfaceSymbol[] }
export interface BacklogEntry { kind: SymbolKind; name: string; reason: string; added: string }
export interface Backlog { version: 1; entries: BacklogEntry[] }
export const RATCHET_KINDS: readonly SymbolKind[] = ['command', 'slash', 'tool', 'config', 'hook'];
const generated = new Set(['cli.mdx', 'slash-commands.mdx', 'config-keys.mdx', 'environment-variables.mdx']);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
function symbol(value: unknown): SurfaceSymbol {
  const entry = object(value);
  if (!SYMBOL_KINDS.includes(entry['kind'] as SymbolKind) || typeof entry['name'] !== 'string' || !entry['name'].trim()) {
    throw new Error('Public symbol requires a known kind and nonempty name');
  }
  if (entry['source'] !== undefined && (typeof entry['source'] !== 'string'
    || /^(?:\/|[A-Za-z]:)|\\|(?:^|\/)\.\.(?:\/|$)/.test(entry['source']))) {
    throw new Error('Public symbol source must be a repository-relative POSIX path');
  }
  return { kind: entry['kind'] as SymbolKind, name: entry['name'],
    ...(entry['source'] === undefined ? {} : { source: entry['source'] as string }) };
}

/** Read committed JSON only. Invalid versions/shapes fail closed. */
export async function loadPublicSurface(root = repoRoot): Promise<Surface> {
  const value = object(JSON.parse(await readFile(join(root, 'docs/public-surface.json'), 'utf8')));
  if (value['version'] !== 1 || !Array.isArray(value['symbols'])) throw new Error('Invalid public surface version or symbols');
  const symbols = value['symbols'].map(symbol);
  if (new Set(symbols.map(symbolKey)).size !== symbols.length) throw new Error('Duplicate public surface symbol');
  return { version: 1, symbols };
}

/** Missing reasons/dates remain visible to the ratchet rather than being hidden. */
export async function loadBacklog(root = repoRoot): Promise<Backlog> {
  const value = object(JSON.parse(await readFile(join(root, 'website/docs-backlog.json'), 'utf8')));
  if (value['version'] !== 1 || !Array.isArray(value['entries'])) throw new Error('Invalid docs backlog version or entries');
  return { version: 1, entries: value['entries'].map((item: unknown) => {
    const entry = object(item);
    const identity = symbol(entry);
    return { kind: identity.kind, name: identity.name,
      reason: typeof entry['reason'] === 'string' ? entry['reason'] : '',
      added: typeof entry['added'] === 'string' ? entry['added'] : '' };
  }) };
}

/** Sorted absolute MDX paths, excluding exactly the four generated references. */
export function listHandwrittenPages(root = repoRoot): string[] {
  const base = join(root, 'website/content/docs');
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return walk(file);
    const local = relative(base, file).split('\\').join('/');
    return entry.name.endsWith('.mdx') && !(local.startsWith('reference/') && generated.has(local.slice(10))) ? [file] : [];
  });
  return walk(base).sort();
}

/** Same comment forms as docs-links; spaces preserve diagnostic line offsets. */
export function stripComments(text: string): string {
  return text.replace(/\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, ' '));
}

/** Parsed inline spans exclude fenced examples; shell bodies retain command lines. */
export function namingContexts(text: string): { inline: string[]; shell: string[] } {
  const lines = stripComments(text).split(/\r?\n/);
  const prose: string[] = [];
  const shell: string[] = [];
  let fence: { marker: string; shell: boolean } | undefined;
  for (const line of lines) {
    const opening = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)[^\n]*$/.exec(line);
    if (fence) {
      if (new RegExp(`^\\s{0,3}${fence.marker[0]}{${fence.marker.length},}\\s*$`).test(line)) fence = undefined;
      else if (fence.shell) shell.push(line.trim().replace(/^\$\s+/, ''));
      continue;
    }
    if (opening) {
      fence = { marker: opening[1]!, shell: /^(?:bash|sh|zsh|fish|powershell|text)$/.test(opening[2]!) };
      continue;
    }
    prose.push(line);
  }
  const inline = [...prose.join('\n').matchAll(/(?<!`)(`+)(?!`)([^\n]*?[^`])\1(?!`)/g)].map((match) => match[2]!.trim());
  return { inline, shell };
}

/** Commands are code-span or shell-line prefixes with a whitespace/end boundary.
 * Other kinds require an entire inline-code token (no prose or fenced matches).
 * Slash inline invocations accept arguments after the canonical /token.
 */
export function namesSymbol(symbol: Pick<SurfaceSymbol, 'kind' | 'name'>, text: string): boolean {
  const { inline, shell } = namingContexts(text);
  if (symbol.kind === 'slash') return inline.some((token) => token === symbol.name
    || (symbol.name.startsWith('/') && token.startsWith(symbol.name) && /^\s/.test(token.slice(symbol.name.length))));
  if (symbol.kind !== 'command') return inline.includes(symbol.name);
  return [...inline, ...shell].some((token) => token === symbol.name
    || (token.startsWith(symbol.name) && /^\s/.test(token.slice(symbol.name.length))));
}

/** Stable compound identity shared by coverage/reporting consumers. */
export function symbolKey(symbol: Pick<SurfaceSymbol, 'kind' | 'name'>): string { return `${symbol.kind}:${symbol.name}`; }
