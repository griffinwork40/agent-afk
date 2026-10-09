/**
 * Render `website/content/docs/configuration/environment-variables.mdx` from
 * `ENV_REGISTRY` (`src/config/env.ts`).
 *
 * Imported and called by `render-env-registry.ts` alongside the JSON and
 * plain-markdown renders. Not intended to be run standalone.
 *
 * Contract:
 *   - categoryLabels is typed Record<EnvVarCategory, string>. scripts/ is NOT in
 *     tsconfig.json's include, so that typing is editor-only; the runtime guard
 *     assertCategoryOrderCompleteness is what actually fails `pnpm scan:env` when
 *     a registry category lacks an order slot or a label.
 *   - categoryOrder determines section order; empty categories are skipped.
 *   - Text is MDX-safe: outside inline-code spans < > become &lt; &gt; and
 *     { } become &#123; &#125;; inside spans the text is left literal (MDX does
 *     not parse code, and entities there would render verbatim). | becomes \|
 *     everywhere, since GFM splits table cells before parsing code spans.
 */

import type { EnvVarCategory, EnvVarMeta } from '../src/config/env.js';

// History: PAGE used the heading labels below before generation was introduced
// (verified against the hand-maintained file at the time of item 7 authorship).
// Exhaustive over EnvVarCategory — a new category is a TypeScript type error here.
const categoryLabels: Record<EnvVarCategory, string> = {
  auth: 'Authentication',
  model: 'Model',
  routing: 'Routing',
  browser: 'Browser',
  mcp: 'MCP (Model Context Protocol)',
  daemon: 'Daemon',
  telegram: 'Telegram',
  worktree: 'Worktrees',
  paths: 'Paths',
  process: 'Process',
  debug: 'Debug',
  display: 'Display',
  misc: 'Miscellaneous',
};

// Section order follows PAGE's original order; display is placed after debug
// (a sensible position for a visual-configuration category).
const categoryOrder: readonly EnvVarCategory[] = [
  'auth',
  'model',
  'routing',
  'browser',
  'mcp',
  'daemon',
  'telegram',
  'worktree',
  'paths',
  'process',
  'debug',
  'display',
  'misc',
];

// Guard: every category in ENV_REGISTRY must appear in categoryOrder.
// (The same guard exists in render-env-registry.ts for the plain-markdown
// output; this guard covers the MDX output independently so a new category
// cannot silently drop vars from either rendered file.)
export function assertCategoryOrderCompleteness(registry: readonly EnvVarMeta[]): void {
  const orderSet = new Set<EnvVarCategory>(categoryOrder);
  const labels: Partial<Record<string, string>> = categoryLabels;
  const missing = [...new Set(registry.map((e) => e.category))].filter(
    (c) => !orderSet.has(c) || !labels[c],
  );
  if (missing.length > 0) {
    throw new Error(
      `render-env-registry.mdx: ENV_REGISTRY has categories missing from categoryOrder or categoryLabels: ` +
        `${missing.join(', ')}. Add them to both in scripts/render-env-registry.mdx.ts.`,
    );
  }
}

/** Escape a description string for use inside an MDX table cell. */
export function escapeMdx(text: string): string {
  // & is deliberately not escaped: prose may contain a bare "X & Y", and no
  // substitution below emits text that a later one rewrites. Odd-indexed parts
  // of the backtick split are inline-code spans and stay literal except for |.
  return text
    .split('`')
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('{', '&#123;')
            .replaceAll('}', '&#125;'),
    )
    .join('`')
    .replaceAll('|', '\\|');
}

/**
 * Render the MDX page from the registry.
 *
 * The returned string is a complete `.mdx` file that can be written directly
 * to `website/content/docs/configuration/environment-variables.mdx`.
 *
 * Invariant: the frontmatter block, intro paragraph, and MDX generation
 * comment are verbatim copies of the hand-authored PAGE content that existed
 * before generation was introduced.
 */
export function renderMdx(registry: readonly EnvVarMeta[]): string {
  assertCategoryOrderCompleteness(registry);

  const sorted = [...registry].sort((a, b) => a.name.localeCompare(b.name));
  const byCategory = new Map<EnvVarCategory, EnvVarMeta[]>();
  for (const entry of sorted) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
    byCategory.get(entry.category)!.push(entry);
  }

  const lines: string[] = [];

  // Frontmatter — verbatim from the hand-authored PAGE.
  lines.push('---');
  lines.push('title: "Environment Variables"');
  lines.push(
    'description: "Complete reference for all environment variables recognized by agent-afk, grouped by category."',
  );
  lines.push('---');
  lines.push('');

  // MDX generation comment — placed after frontmatter per spec.
  lines.push(
    '{/* Generated from src/config/env.ts by scripts/render-env-registry.ts. Do not edit by hand; run `pnpm scan:env`. */}',
  );
  lines.push('');

  // Intro paragraph — verbatim from the hand-authored PAGE.
  lines.push(
    'All environment variables recognized by `agent-afk` are listed here, grouped by functional category. Most are optional; required variables are noted in the description. Variables can be set in your shell, a `.env` file, or `~/.afk/config/afk.env` — that last file is loaded at startup (shell env takes precedence).',
  );
  lines.push('');

  for (const category of categoryOrder) {
    const entries = byCategory.get(category);
    if (!entries || entries.length === 0) continue;

    const label = categoryLabels[category];
    lines.push(`## ${label}`);
    lines.push('');
    lines.push('| Variable | Type | Description | Default |');
    lines.push('| --- | --- | --- | --- |');

    for (const e of entries) {
      // escapeMdx pairs backticks to find code spans; an odd count would flip
      // prose/code parity and leave raw < { in prose, breaking the MDX build.
      if ((e.description.match(/`/g) ?? []).length % 2 !== 0) {
        throw new Error(`render-env-registry.mdx: ${e.name} description has an unbalanced backtick.`);
      }
      const varCell = `\`${e.name}\``;
      const typeCell = e.type;
      const descCell = escapeMdx(e.description);
      const defaultCell = e.default != null ? `\`${escapeMdx(e.default)}\`` : '—';
      lines.push(`| ${varCell} | ${typeCell} | ${descCell} | ${defaultCell} |`);
    }

    lines.push('');
  }

  return lines.join('\n');
}
