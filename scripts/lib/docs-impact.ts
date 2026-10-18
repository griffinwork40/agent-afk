import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listHandwrittenPages, namesSymbol, symbolKey, type Surface, type SurfaceSymbol } from './public-surface.js';

export interface Page { path: string; text: string }
export type GitRead = (args: string[]) => string;

export function gitReader(root: string): GitRead {
  return (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function handwrittenPages(root: string): Page[] {
  return listHandwrittenPages(root).map((path) => ({ path: relative(root, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }));
}

/** A missing/unrelated base must not turn an advisory report into a failing check. */
export function changedFiles(base: string, git: GitRead): { files: string[]; note?: string } {
  const committed = committedFiles(base, git);
  // Local runs: include uncommitted edits so the report matches the working-tree snapshot.
  // CI checkouts are clean, so this adds nothing there.
  let uncommitted: string[] = [];
  try { uncommitted = lines(git(['diff', '--name-only', 'HEAD'])); } catch { /* advisory: ignore */ }
  const files = [...new Set([...committed.files, ...uncommitted])].sort();
  return committed.note ? { files, note: committed.note } : { files };
}

function lines(output: string): string[] {
  return output.trim().split('\n').filter(Boolean);
}

function committedFiles(base: string, git: GitRead): { files: string[]; note?: string } {
  try { return { files: lines(git(['diff', '--name-only', `${base}...HEAD`])) }; }
  catch {
    try { return { files: lines(git(['diff', '--name-only', `${base}..HEAD`])), note: 'No merge base; used two-dot diff.' }; }
    catch { return { files: [], note: `Base ${base} unavailable; changed-file list is empty.` }; }
  }
}

export function baseSurface(base: string, git: GitRead): { surface?: Surface; note?: string } {
  try {
    const value: unknown = JSON.parse(git(['show', `${base}:docs/public-surface.json`]));
    if (!value || typeof value !== 'object' || !('symbols' in value) || !Array.isArray(value.symbols)) throw new Error('invalid snapshot');
    return { surface: value as Surface };
  } catch { return { note: `No readable public-surface snapshot at ${base}; symbol additions/removals unavailable.` }; }
}

export function surfaceChanges(current: Surface, previous?: Surface): { added: SurfaceSymbol[]; removed: SurfaceSymbol[] } {
  if (!previous) return { added: [], removed: [] };
  const old = new Set(previous.symbols.map(symbolKey));
  const now = new Set(current.symbols.map(symbolKey));
  return {
    added: current.symbols.filter((symbol) => !old.has(symbolKey(symbol))),
    removed: previous.symbols.filter((symbol) => !now.has(symbolKey(symbol))),
  };
}

function formatSymbol(symbol: SurfaceSymbol, pages: readonly Page[]): string {
  const mentions = pages.filter((page) => namesSymbol(symbol, page.text)).map((page) => `\`${page.path}\``);
  return `  - \`${symbol.kind}:${symbol.name}\`: ${mentions.length ? mentions.join(', ') : 'no handwritten page names it'}`;
}

export function impactMarkdown(base: string, current: Surface, pages: readonly Page[], git: GitRead): string {
  const diff = changedFiles(base, git);
  const old = baseSurface(base, git);
  const changed = new Set(diff.files.filter((file) => file.startsWith('src/')));
  const affected = current.symbols.filter((symbol) => symbol.source && changed.has(symbol.source));
  const delta = surfaceChanges(current, old.surface);
  // Encode punctuation before Markdown parsing, including fallback notes containing the ref.
  const safeBase = base.replace(/[^a-zA-Z0-9/._-]/gu, (char) => `&#${char.codePointAt(0)!};`);
  const lines = ['## Docs impact (advisory)', '', `Base: <code>${safeBase}</code>`, ''];
  for (const note of [diff.note, old.note]) if (note) lines.push(`Note: ${note.replaceAll(base, safeBase)}`, '');
  lines.push(`### Changed source files (${changed.size})`);
  if (!changed.size) lines.push('- None');
  for (const file of [...changed].sort()) {
    lines.push(`- \`${file}\``);
    const symbols = affected.filter((symbol) => symbol.source === file);
    if (!symbols.length) lines.push('  - No mapped public symbols');
    else lines.push(...symbols.map((symbol) => formatSymbol(symbol, pages)));
  }
  for (const [title, symbols] of [['Added', delta.added], ['Removed', delta.removed]] as const) {
    lines.push('', `### ${title} public symbols (${symbols.length})`);
    lines.push(...(symbols.length ? symbols.map((symbol) => `- \`${symbol.kind}:${symbol.name}\``) : ['- None']));
  }
  return `${lines.join('\n')}\n`;
}
