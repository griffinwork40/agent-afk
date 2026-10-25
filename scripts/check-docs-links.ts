#!/usr/bin/env tsx
/** Check the documentation content tree, not arbitrary repository Markdown.
 * Anchors and queries are ignored. index.mdx maps to its folder URL. Folder
 * navigation entries require a meta.json and are traversed; ... includes all
 * remaining immediate pages/folders. Redirect sources are accepted only when
 * their destinations ultimately resolve to existing pages (cycles fail).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { internalTarget, links, parseRedirects, resolves, slug, type Redirect } from './lib/docs-links.js';
import { isMain, repoRoot } from './lib/docs-reference.js';

export interface DocsTree { pages: Record<string, string>; metas: Record<string, unknown>; redirects: readonly Redirect[] }

export function readDocsTree(root: string, configText: string): DocsTree {
  const pages: Record<string, string> = {};
  const metas: Record<string, unknown> = {};
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const file = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.mdx')) pages[file] = readFileSync(path, 'utf8');
      else if (entry.name === 'meta.json') {
        try { metas[file] = JSON.parse(readFileSync(path, 'utf8')); }
        catch { metas[file] = null; }
      }
    }
  }
  walk(root);
  return { pages, metas, redirects: parseRedirects(configText) };
}

export function checkDocsLinks(tree: DocsTree): string[] {
  const errors: string[] = [];
  const pages = new Set(Object.keys(tree.pages).map(slug));
  const listed = new Set<string>();
  const reachableMetas = new Set<string>();
  const files = Object.keys(tree.pages);
  const dirs = new Set(Object.keys(tree.metas).map((file) => posix.dirname(file)));
  const folderMetas = new Map([...dirs].map((dir) => [dir, posix.join(dir, 'meta.json')]));

  // Reject malformed metadata even when it is not reachable from the sidebar.
  for (const [file, meta] of Object.entries(tree.metas)) {
    if (!meta || typeof meta !== 'object' || ('pages' in meta && !Array.isArray(meta.pages))) errors.push(`${file}: invalid metadata`);
  }
  function visit(metaFile: string): void {
    if (reachableMetas.has(metaFile)) return;
    reachableMetas.add(metaFile);
    const dir = posix.dirname(metaFile);
    const meta = tree.metas[metaFile];
    if (!meta || typeof meta !== 'object') return;
    const entries = 'pages' in meta && Array.isArray(meta.pages) ? meta.pages : ['...'];
    const immediatePages = files.filter((file) => posix.dirname(file) === dir);
    const immediateDirs = [...dirs].filter((child) => child !== dir && posix.dirname(child) === dir);
    for (const entry of entries) {
      if (typeof entry !== 'string') { errors.push(`${metaFile}: nonstring pages entry`); continue; }
      if (/^---.*---$/.test(entry)) continue;
      if (entry === '...') {
        immediatePages.forEach((file) => listed.add(file));
        for (const child of immediateDirs) visit(folderMetas.get(child)!);
        continue;
      }
      // Fumadocs supports !page exclusions and [Label](target) navigation links.
      if (entry.startsWith('!')) continue;
      const navLink = /^\[[^\]]*\]\(([^)]+)\)$/.exec(entry);
      if (navLink) {
        const target = internalTarget(navLink[1]!, posix.join(dir, 'index.mdx'));
        if (target && !resolves(target, pages, tree.redirects)) errors.push(`${metaFile}: unresolved pages entry ${entry}`);
        continue;
      }
      const destination = posix.join(dir, entry);
      const pageFile = `${destination}.mdx`;
      if (pageFile in tree.pages) listed.add(pageFile);
      else if (folderMetas.has(destination)) visit(folderMetas.get(destination)!);
      else errors.push(`${metaFile}: unresolved pages entry ${entry}`);
    }
    for (const excluded of entries.filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('!'))) {
      listed.delete(`${posix.join(dir, excluded.slice(1))}.mdx`);
    }
  }
  if (!('meta.json' in tree.metas)) errors.push('meta.json: missing root navigation');
  visit('meta.json');
  // Validate every meta file, but unreachable navigation cannot rescue orphans.
  const reachablePages = new Set(listed);
  const rootReachableMetas = new Set(reachableMetas);
  for (const file of Object.keys(tree.metas)) {
    if (rootReachableMetas.has(file)) continue;
    errors.push(`${file}: unreachable navigation folder`);
    visit(file);
  }
  for (const file of files) {
    if (!reachablePages.has(file)) errors.push(`${file}: orphan page (not listed in reachable meta.json)`);
    for (const href of links(tree.pages[file]!)) {
      if (href.startsWith('UNVERIFIABLE:')) { errors.push(`${file}: nonliteral href ${href.slice(13)}`); continue; }
      let target: string | undefined;
      try { target = internalTarget(href, file); }
      catch { errors.push(`${file}: malformed link ${href}`); continue; }
      if (target && !resolves(target, pages, tree.redirects)) errors.push(`${file}: broken link ${href}`);
    }
  }
  for (const redirect of tree.redirects) {
    // Wildcards are checked for each concrete incoming link, not as page slugs.
    if (redirect.source.includes(':')) continue;
    if (!resolves(redirect.destination, pages, tree.redirects)) errors.push(`next.config.ts: redirect ${redirect.source} has missing destination ${redirect.destination}`);
  }
  return [...new Set(errors)].sort();
}

if (isMain(import.meta.url)) {
  const tree = readDocsTree(join(repoRoot, 'website/content/docs'), readFileSync(join(repoRoot, 'website/next.config.ts'), 'utf8'));
  const errors = checkDocsLinks(tree);
  for (const error of errors) console.error(error);
  console.log(`Docs links: ${Object.keys(tree.pages).length} pages, ${Object.keys(tree.metas).length} navigation files, ${errors.length} errors`);
  process.exitCode = errors.length ? 1 : 0;
}
