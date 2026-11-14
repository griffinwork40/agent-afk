#!/usr/bin/env tsx
/** Read-only, secret-free authoring brief from committed snapshot and git subjects. */
import { isMain, repoRoot } from './lib/docs-reference.js';
import { gitReader, handwrittenPages, type GitRead, type Page } from './lib/docs-impact.js';
import { loadBacklog, loadPublicSurface, namesSymbol, RATCHET_KINDS, type Backlog, type Surface } from './lib/public-surface.js';
import { redactSecrets } from '../src/agent/redact-secrets.js';

export function featSinceDocs(git: GitRead): { commits: string[]; note?: string } {
  try {
    const last = git(['log', '-1', '--format=%H', '--', 'website/content']).trim();
    if (!last) return { commits: [], note: 'No prior docs-content commit found.' };
    const commits = git(['log', `${last}..HEAD`, '--format=%h%x09%s']).trim().split('\n').filter(Boolean)
      .filter((line) => /^[^\t]+\tfeat(?:\([^)]*\))?!?:/i.test(line))
      .map((line) => { const [sha, ...subject] = line.split('\t'); return `\`${sha}\` ${redactSecrets(subject.join('\t'))}`; });
    return { commits };
  } catch { return { commits: [], note: 'Git history unavailable.' }; }
}

export function reportMarkdown(surface: Surface, backlog: Backlog, pages: readonly Page[], history: ReturnType<typeof featSinceDocs>): string {
  const onlyGenerated = surface.symbols.filter((symbol) => RATCHET_KINDS.includes(symbol.kind)
    && !pages.some((page) => namesSymbol(symbol, page.text)));
  const backlogLines = backlog.entries.map((item) => `- \`${item.kind}:${item.name}\` (${item.added}): ${redactSecrets(item.reason)}`);
  const lines = ['# Docs freshness report', '', `## Backlog (${backlog.entries.length})`,
    ...(backlogLines.length ? backlogLines : ['- None']), '',
    `## Public symbols named only in generated references (${onlyGenerated.length})`,
    ...(onlyGenerated.length ? onlyGenerated.map((symbol) => `- \`${symbol.kind}:${symbol.name}\``) : ['- None']), '',
    `## feat commits since last website/content update (${history.commits.length})`,
    ...(history.note ? [`- ${history.note}`] : history.commits.length ? history.commits.map((commit) => `- ${commit}`) : ['- None']), '',
    '## Ready-to-paste docs task', '', '```text',
    'Update user-facing handwritten pages under website/content/docs/ for the gaps above.',
    'Use docs/public-surface.json for current symbol names and website/docs-backlog.json for deferred items.',
    'Read current implementation before changing prose. Name new command, slash, tool, config, and hook symbols in handwritten pages,',
    'or add an honest dated reason to website/docs-backlog.json. Remove resolved or stale backlog entries.',
    'Regenerate reference pages using pnpm scan:cli, pnpm scan:slash, pnpm scan:config, pnpm scan:env;',
    'regenerate the snapshot with pnpm scan:surface. Never hand-edit generated pages or the snapshot.',
    'Run pnpm scan:surface:check, pnpm docs:surface:check, pnpm docs:refs:check, pnpm docs:links:check, and pnpm check:audits.',
    '```'];
  return `${lines.join('\n')}\n`;
}

export async function runReport(): Promise<string> {
  const [surface, backlog] = await Promise.all([loadPublicSurface(), loadBacklog()]);
  return reportMarkdown(surface, backlog, handwrittenPages(repoRoot), featSinceDocs(gitReader(repoRoot)));
}

if (isMain(import.meta.url)) {
  try { console.log(await runReport()); }
  catch (error) { console.error(`Docs report unavailable: ${String(error)}`); process.exitCode = 1; }
}
