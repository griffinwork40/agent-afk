#!/usr/bin/env tsx
/** Stale-reference check: every symbol-looking reference in a hand-written
 * docs page must resolve against docs/public-surface.json (plus the generated
 * references for aliases/short flags). Output: `path:line: <kind> <token> not
 * found (did you mean <nearest>?)`. Opt-outs: docs-refs-ignore-start/-end and
 * docs-refs-ignore-next-line MDX comments, for intentional historical examples only.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { isMain, repoRoot } from './lib/docs-reference.js';
import { listHandwrittenPages, stripComments } from './lib/public-surface.js';
import { loadKnown, type KnownRefs } from './lib/docs-refs-known.js';
import { ignoredLines, pageFindings, type LineFinding } from './lib/docs-refs-rules.js';

export interface DocsPage { path: string; text: string }

export function formatFinding(path: string, finding: LineFinding): string {
  const hint = finding.suggestion ? ` (did you mean ${finding.suggestion}?)` : '';
  return `${path}:${finding.line}: ${finding.kind} ${finding.token} not found${hint}`;
}

export function checkDocsRefs(pages: readonly DocsPage[], known: KnownRefs): string[] {
  return pages.flatMap((page) => pageFindings(page.path, stripComments(page.text), ignoredLines(page.text), known)
    .map((finding) => formatFinding(page.path, finding)));
}

export async function checkRepositoryRefs(root = repoRoot): Promise<string[]> {
  const known = await loadKnown(root);
  const pages = listHandwrittenPages(root).map((path) => ({ path: relative(root, path).split('\\').join('/'), text: readFileSync(path, 'utf8') }));
  const errors = checkDocsRefs(pages, known);
  console.log(`Docs refs: ${pages.length} handwritten pages, ${errors.length} unresolved references`);
  return errors;
}

if (isMain(import.meta.url)) {
  try {
    const errors = await checkRepositoryRefs();
    for (const error of errors) console.error(error);
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
