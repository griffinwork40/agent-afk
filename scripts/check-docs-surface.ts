#!/usr/bin/env tsx
/** Documentation ratchet over committed data, never live registrars. */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { isMain, repoRoot } from './lib/docs-reference.js';
import { loadBacklog, loadPublicSurface, listHandwrittenPages, namesSymbol, symbolKey, RATCHET_KINDS,
  type Surface, type Backlog } from './lib/public-surface.js';

export interface HandwrittenPage { path: string; text: string }

/** Inject pages/snapshot/backlog for hermetic fixtures and downstream reports. */
export function checkDocsSurface(surface: Surface, backlog: Backlog, pages: readonly HandwrittenPage[]): string[] {
  const errors: string[] = [];
  const symbols = new Map(surface.symbols.map((symbol) => [symbolKey(symbol), symbol]));
  const named = new Set(surface.symbols.filter((symbol) => pages.some((page) => namesSymbol(symbol, page.text))).map(symbolKey));
  const entries = new Set<string>();
  for (const entry of backlog.entries) {
    const key = symbolKey(entry);
    if (entries.has(key)) errors.push(`Duplicate backlog entry: ${key}`);
    entries.add(key);
    if (!entry.reason.trim()) errors.push(`Missing reason: ${key}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.added) || Number.isNaN(Date.parse(entry.added))
      || new Date(entry.added).toISOString().slice(0, 10) !== entry.added) errors.push(`Invalid added date: ${key}`);
    if (!symbols.has(key)) errors.push(`Stale backlog entry: ${key}`);
    else if (named.has(key)) errors.push(`Resolved backlog entry (remove it): ${key}`);
    if (!RATCHET_KINDS.includes(entry.kind)) errors.push(`Backlog kind is generated-reference only: ${key}`);
  }
  const sorted = backlog.entries.map(symbolKey).sort();
  if (backlog.entries.some((entry, index) => symbolKey(entry) !== sorted[index])) errors.push('Backlog entries must be sorted by kind/name');
  for (const symbol of surface.symbols) {
    if (!RATCHET_KINDS.includes(symbol.kind)) continue;
    if (!named.has(symbolKey(symbol)) && !entries.has(symbolKey(symbol))) errors.push(`Missing handwritten documentation or backlog: ${symbolKey(symbol)}`);
  }
  return errors;
}

export async function checkRepositorySurface(root = repoRoot): Promise<string[]> {
  const [surface, backlog] = await Promise.all([loadPublicSurface(root), loadBacklog(root)]);
  const pages = listHandwrittenPages(root).map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));
  const errors = checkDocsSurface(surface, backlog, pages);
  console.log(`Docs surface: ${surface.symbols.filter((symbol) => RATCHET_KINDS.includes(symbol.kind)).length} ratcheted symbols, ${pages.length} handwritten pages, ${backlog.entries.length} backlog entries`);
  return errors;
}

if (isMain(import.meta.url)) {
  try {
    const errors = await checkRepositorySurface();
    for (const error of errors) console.error(error);
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
