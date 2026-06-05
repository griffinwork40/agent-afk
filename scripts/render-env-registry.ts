#!/usr/bin/env tsx
/**
 * Render `docs/env-registry.{json,md}` from `src/config/env.ts`.
 *
 * The registry is committed to git so docs stay in sync with code. CI runs
 * this in --check mode (via `pnpm scan:env -- --check`) and fails if the
 * committed artifacts drift from what the source-of-truth would produce.
 *
 * Output is deterministic — sorted alphabetically by var name, no timestamps
 * embedded that would create spurious diffs. A second consecutive run
 * produces zero filesystem changes.
 *
 * Usage:
 *   pnpm scan:env                   # regenerate docs/env-registry.{json,md}
 *   pnpm scan:env -- --check        # exit nonzero if registry would change
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_REGISTRY, type EnvVarMeta, type EnvVarCategory } from '../src/config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const OUT_JSON = resolve(repoRoot, 'docs/env-registry.json');
const OUT_MD = resolve(repoRoot, 'docs/env-registry.md');

const isCheck = process.argv.includes('--check');

function renderJson(registry: readonly EnvVarMeta[]): string {
  const sorted = [...registry].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({ version: 1, vars: sorted }, null, 2) + '\n';
}

function renderMarkdown(registry: readonly EnvVarMeta[]): string {
  const sorted = [...registry].sort((a, b) => a.name.localeCompare(b.name));
  const byCategory = new Map<EnvVarCategory, EnvVarMeta[]>();
  for (const entry of sorted) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
    byCategory.get(entry.category)!.push(entry);
  }
  // Display order for the rendered sections. MUST contain every member of
  // EnvVarCategory — the render loop below silently skips any category absent
  // from this array, dropping its vars from the doc. The exhaustiveness guard
  // immediately after enforces completeness.
  const categoryOrder: readonly EnvVarCategory[] = [
    'model',
    'auth',
    'telegram',
    'paths',
    'daemon',
    'worktree',
    'threads',
    'mcp',
    'routing',
    'browser',
    'debug',
    'process',
    'misc',
  ];

  // Guard: every category present in ENV_REGISTRY MUST appear in categoryOrder.
  // Without this, a newly-added category (e.g. 'routing') silently drops all of
  // its vars from the rendered markdown — and `scan:env --check` cannot catch
  // it, because it diffs two outputs produced by this same renderer (both omit
  // the unlisted category, so they always agree). Fail loudly at generation
  // time instead, so the omission surfaces the moment the category is added.
  const orderSet = new Set<EnvVarCategory>(categoryOrder);
  const missingFromOrder = [...byCategory.keys()].filter((c) => !orderSet.has(c));
  if (missingFromOrder.length > 0) {
    throw new Error(
      `render-env-registry: ENV_REGISTRY has categories missing from categoryOrder: ` +
        `${missingFromOrder.join(', ')}. Add them to the categoryOrder array in ` +
        `scripts/render-env-registry.ts so their vars are rendered.`,
    );
  }

  const lines: string[] = [];
  lines.push('# Environment Variable Registry');
  lines.push('');
  lines.push('Generated from `src/config/env.ts`. Do not edit by hand — run `pnpm scan:env` after changing the registry source.');
  lines.push('');
  lines.push(
    `**${sorted.length} vars** across ${byCategory.size} categories. Every \`process.env[...]\` read in \`src/\` outside \`src/config/env.ts\` is a CI failure (enforced by \`pnpm audit:env:check\`).`,
  );
  lines.push('');
  lines.push('To add a var: edit `src/config/env.ts` (add a getter on `env` + an entry in `ENV_REGISTRY`), then run `pnpm scan:env`.');
  lines.push('');

  for (const category of categoryOrder) {
    const entries = byCategory.get(category);
    if (!entries || entries.length === 0) continue;
    const title = category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| Name | Type | Required | Default | Example | Description |');
    lines.push('|------|------|----------|---------|---------|-------------|');
    for (const e of entries) {
      const required = e.required ? '✓' : '';
      const def = e.default ? `\`${e.default}\`` : '';
      const example = e.example ? `\`${e.example}\`` : '';
      const description = e.description.replace(/\|/g, '\\|');
      lines.push(`| \`${e.name}\` | ${e.type} | ${required} | ${def} | ${example} | ${description} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function readFileOr(path: string, fallback: string): string {
  if (existsSync(path)) return readFileSync(path, 'utf8');
  return fallback;
}

function main(): void {
  const json = renderJson(ENV_REGISTRY);
  const md = renderMarkdown(ENV_REGISTRY);

  const currentJson = readFileOr(OUT_JSON, '');
  const currentMd = readFileOr(OUT_MD, '');

  const jsonDrift = currentJson !== json;
  const mdDrift = currentMd !== md;

  if (isCheck) {
    if (!jsonDrift && !mdDrift) {
      console.log(`✓ scan:env: docs/env-registry.{json,md} in sync with src/config/env.ts (${ENV_REGISTRY.length} vars).`);
      process.exit(0);
    }
    console.error(`✗ scan:env: docs/env-registry would drift from src/config/env.ts.`);
    if (jsonDrift) console.error(`  - docs/env-registry.json`);
    if (mdDrift) console.error(`  - docs/env-registry.md`);
    console.error('\nFix: run `pnpm scan:env` and commit the result.');
    process.exit(1);
  }

  writeFileSync(OUT_JSON, json);
  writeFileSync(OUT_MD, md);
  console.log(`✓ scan:env: wrote ${ENV_REGISTRY.length} entries → docs/env-registry.{json,md}.`);
}

main();
