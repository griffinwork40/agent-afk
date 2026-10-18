#!/usr/bin/env tsx
/** Advisory by contract: failure to inspect git or append a summary never blocks CI. */
import { appendFileSync } from 'node:fs';
import { isMain, repoRoot } from './lib/docs-reference.js';
import { loadPublicSurface } from './lib/public-surface.js';
import { gitReader, handwrittenPages, impactMarkdown } from './lib/docs-impact.js';

export async function runImpact(args = process.argv.slice(2)): Promise<string> {
  const index = args.indexOf('--base');
  const base = index >= 0 ? args[index + 1] : undefined;
  if (!base) return '## Docs impact (advisory)\n\nNote: provide --base <ref> to compare public symbols.\n';
  return impactMarkdown(base, await loadPublicSurface(), handwrittenPages(repoRoot), gitReader(repoRoot));
}

if (isMain(import.meta.url)) {
  try {
    const markdown = await runImpact();
    console.log(markdown);
    if (process.env['GITHUB_STEP_SUMMARY']) {
      try { appendFileSync(process.env['GITHUB_STEP_SUMMARY'], markdown); }
      catch (error) { console.error(`Docs impact summary unavailable: ${String(error)}`); }
    }
  } catch (error) { console.log(`## Docs impact (advisory)\n\nNote: impact unavailable: ${String(error)}`); }
}
